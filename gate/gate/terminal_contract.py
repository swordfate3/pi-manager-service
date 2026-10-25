"""Closed private terminal wire contract. No command/path selection exists here."""
import base64
import json
import unicodedata

from .lifecycle_contract import HEX, IMAGE

FRAME = 65536
QUEUE = 262144
SAFE_INTEGER = 2 ** 53 - 1


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError('terminal frame refused')


def integer(value, low=1, high=SAFE_INTEGER):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('terminal integer refused')
    return value


def identity(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError('terminal identity refused')
    return value


def text(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 256 or
            any(unicodedata.category(c) in ('Cc', 'Cs') for c in value)):
        raise ValueError('terminal text refused')


def target(value):
    exact(value, 'v runId runtimeId sessionId terminalEpoch profile inputState managedRestartEligible')
    integer(value['v'], 1, 1)
    identity(value['runId'])
    identity(value['terminalEpoch'])
    text(value['runtimeId'])
    text(value['sessionId'])
    if (value['profile'] != 'web-terminal-v1' or value['managedRestartEligible'] is not False or
            value['inputState'] not in ('local', 'none', 'remote', 'fenced')):
        raise ValueError('terminal target refused')
    return value


def policy(value):
    exact(value, 'enabled images')
    if (type(value['enabled']) is not bool or not isinstance(value['images'], list) or
            len(value['images']) > 64 or (value['enabled'] and not value['images']) or
            any(not isinstance(i, str) or not IMAGE.fullmatch(i) for i in value['images'])):
        raise ValueError('terminal policy refused')
    return {'enabled': value['enabled'], 'images': sorted(set(value['images']))}


def first(value):
    if not isinstance(value, dict):
        raise ValueError('terminal frame refused')
    integer(value.get('v'), 1, 1)
    if value.get('op') == 'status':
        exact(value, 'v op token runId')
        identity(value['runId'])
    else:
        exact(value, 'v op token target scope binding')
        if value['op'] != 'connect' or value['scope'] not in ('read', 'write'):
            raise ValueError('terminal operation refused')
        target(value['target'])
        exact(value['binding'], 'authorizationId connectionId')
        for entry in value['binding'].values():
            identity(entry)
    if not isinstance(value['token'], str) or len(value['token']) != 64:
        raise ValueError('terminal credential refused')
    return {k: v for k, v in value.items() if k != 'token'}


def encode(value):
    data = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode() + b'\n'
    if len(data) > FRAME:
        raise ValueError('terminal frame limit')
    return data


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def nonfinite(_):
    raise ValueError('nonfinite value')


class Lines:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data):
        frames = []
        for part in data.split(b'\n')[:-1]:
            self.pending.extend(part)
            if len(self.pending) + 1 > FRAME:
                raise ValueError('terminal frame limit')
            value = json.loads(self.pending.decode('utf-8', 'strict'), object_pairs_hook=pairs,
                               parse_constant=nonfinite)
            if not isinstance(value, dict):
                raise ValueError('terminal frame refused')
            frames.append(value)
            self.pending.clear()
        self.pending.extend(data.rsplit(b'\n', 1)[-1])
        if len(self.pending) >= FRAME:
            raise ValueError('terminal frame limit')
        return frames


class Conversation:
    """Bounded request correlation and runtime identity/screen envelope validation."""
    def __init__(self, opening):
        self.opening, self.ready, self.last_id = opening, None, 0
        self.pending = {}
        self.screen = None

    def request(self, value):
        if self.ready is None or self.opening.get('scope') != 'write':
            raise ValueError('terminal not writable')
        key = integer(value.get('id'))
        if key <= self.last_id or len(self.pending) >= 64:
            raise ValueError('terminal request quota')
        kind = value.get('type')
        if kind in ('acquire', 'release'):
            exact(value, 'id type')
        elif kind == 'input':
            exact(value, 'id v type terminalEpoch leaseId sequence data')
            integer(value['v'], 1, 1)
            identity(value['leaseId'])
            integer(value['sequence'])
            if (value['terminalEpoch'] != self.ready['terminalEpoch'] or not isinstance(value['data'], str) or
                    not 1 <= len(value['data'].encode('utf-8', 'strict')) <= 8192):
                raise ValueError('terminal input refused')
        elif kind == 'resize':
            exact(value, 'id type leaseId columns rows')
            identity(value['leaseId'])
            integer(value['columns'], 20, 240)
            integer(value['rows'], 5, 120)
        else:
            raise ValueError('terminal action refused')
        self.pending[key] = kind
        self.last_id = key

    def same_target(self, value):
        target(value)
        expected = self.opening.get('target') or self.ready
        run = self.opening.get('runId') or expected['runId']
        if value['runId'] != run or (expected and any(value[k] != expected[k] for k in
                                                    ('runId', 'runtimeId', 'sessionId', 'terminalEpoch'))):
            raise ValueError('terminal identity changed')

    def response(self, value):
        kind = value.get('type')
        if self.ready is None:
            if value == {'type': 'error', 'error': 'terminal_backend_unavailable'}:
                return False
            exact(value, 'type target')
            if kind != 'ready':
                raise ValueError('terminal not ready')
            self.same_target(value['target'])
            self.ready = value['target']
            return True
        if self.opening['op'] == 'status':
            raise ValueError('extra status frame')
        if kind == 'response':
            exact(value, 'type id result')
            action = self.pending.pop(integer(value['id']), None)
            result = value['result']
            if action is None or not isinstance(result, dict):
                raise ValueError('unexpected terminal response')
            valid = []
            if action == 'acquire':
                if result.get('ok') is True:
                    exact(result, 'ok leaseId expiresInMs')
                    identity(result['leaseId'])
                    integer(result['expiresInMs'], 30000, 30000)
                    return True
                valid = [{'ok': False, 'error': x} for x in ('local_owns_input', 'control_unavailable')]
            elif action == 'release':
                valid = [{'ok': True}]
            elif action == 'input':
                valid = [{'ok': True, 'delivery': 'written'},
                         {'ok': False, 'delivery': 'rejected', 'error': 'input_rejected'},
                         {'ok': False, 'delivery': 'unknown', 'error': 'input_delivery_unknown'}]
            elif action == 'resize':
                valid = [{'ok': True}, {'ok': False}] + [{'ok': False, 'error': x} for x in
                                                       ('resize_rejected', 'resize_unknown')]
            if type(result.get('ok')) is not bool or result not in valid:
                raise ValueError('terminal result refused')
        elif kind == 'screen-start':
            exact(value, 'type target sequence columns rows bytes chunks')
            self.same_target(value['target'])
            integer(value['sequence'], 0)
            integer(value['columns'], 20, 240)
            integer(value['rows'], 5, 120)
            size = integer(value['bytes'], 0, 1048576)
            chunks = integer(value['chunks'], 0, 52)
            if self.screen or chunks != (size + 20479) // 20480:
                raise ValueError('terminal screen refused')
            self.screen = dict(sequence=value['sequence'], size=size, chunks=chunks, index=0, received=0)
        elif kind in ('screen-chunk', 'screen-end'):
            exact(value, 'type terminalEpoch sequence index data' if kind == 'screen-chunk'
                  else 'type terminalEpoch sequence')
            screen = self.screen
            if (not screen or value['terminalEpoch'] != self.ready['terminalEpoch'] or
                    integer(value['sequence'], 0) != screen['sequence']):
                raise ValueError('terminal screen identity refused')
            if kind == 'screen-chunk':
                if integer(value['index'], 0) != screen['index'] or screen['index'] >= screen['chunks']:
                    raise ValueError('terminal chunk refused')
                raw = base64.b64decode(value['data'], validate=True)
                if (not 1 <= len(raw) <= 20480 or base64.b64encode(raw).decode() != value['data'] or
                        screen['received'] + len(raw) > screen['size']):
                    raise ValueError('terminal chunk refused')
                screen['index'] += 1
                screen['received'] += len(raw)
            else:
                if screen['index'] != screen['chunks'] or screen['received'] != screen['size']:
                    raise ValueError('incomplete terminal screen')
                self.screen = None
        elif value == {'type': 'screen-unavailable'}:
            self.screen = None
        else:
            raise ValueError('terminal output refused')
        return True

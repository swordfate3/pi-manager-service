"""Fixed, credential-separated Hub authority over existing Gate operations."""
import json
import os
import re
import secrets
import stat
import unicodedata
from urllib.parse import urlsplit, parse_qs

from .registry import MODES, contains_secret, fingerprint, validate_identifier
from .store import ACTIVE, _json


ROOT = '/v1/hub-management'
HEX32 = re.compile(r'[a-f0-9]{32}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
TABLES = {'deployment': 'jobs', 'runtime': 'runtime_jobs',
          'restart': 'lifecycle_jobs', 'intent': 'intents'}
POLICY_IDS = {'runtime': 'pi-runtime', 'restart': 'pi-lifecycle'}
HISTORY_LIMIT = 100
TASK_LIMIT = 512
POLICY_LIMIT = 128
RECEIPT_LIMIT = 2048
RESPONSE_LIMIT = 1024 * 1024
IMAGE_LIMIT = 512  # Coordinated Hub field bound; valid repository+digest is at most 327.


def credential(directory, other_tokens):
    """Create/read one private regular inode without ever following a symlink."""
    path = directory / 'hub-management.token'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_hex(32))
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or
                info.st_nlink != 1 or info.st_uid != os.geteuid()):
            raise ValueError('unsafe Hub management credential')
        value = stream.read(65)
    if not HEX64.fullmatch(value) or value in other_tokens:
        raise ValueError('invalid Hub management credential')
    return value


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('unexpected management fields')


def checked_hex(value, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError('invalid management identity')
    return value


class HubManagement:
    def __init__(self, gate):
        self.gate, self.store = gate, gate.store
        with self.store.lock, self.store._write_transaction():
            self.store.db.execute(
                'CREATE TABLE IF NOT EXISTS hub_management_receipts '
                '(id TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL)')

    def _label(self, value, fallback, maximum=256):
        # Never copy untrusted descriptions, errors, snapshots or arbitrary details.
        if (not isinstance(value, str) or not 0 < len(value) <= maximum or
                any(unicodedata.category(c) in ('Cc', 'Cs') for c in value) or
                contains_secret(value) or any(token in value for token in
                    (self.gate.token, self.gate.lifecycle_token, self.gate.hub_management_token))):
            return fallback
        return value

    def _manager(self, kind):
        return self.gate.runtime_updates if kind == 'runtime' else self.gate.lifecycle

    def _raw(self, kind, key):
        if not isinstance(kind, str) or kind not in TABLES:
            raise ValueError('invalid task kind')
        checked_hex(key, HEX32)
        # Table names come exclusively from the fixed mapping above.
        row = self.store.db.execute('SELECT data FROM ' + TABLES[kind] + ' WHERE id=?', (key,)).fetchone()
        if row is None:
            raise KeyError('task not found')
        return json.loads(row[0])

    def _service(self, key):
        try:
            return self.store.service(key)
        except KeyError:
            return None

    def _context(self, kind, raw):
        return {'service': self._service(raw.get('service', 'pi-web-hub'))
                if kind in ('deployment', 'intent') else None,
                'runtime': self.gate.runtime_updates.policy(),
                'restart': self.gate.lifecycle.policy()}

    def _task(self, kind, raw):
        context = self._context(kind, raw)
        status = raw.get('status')
        actions = []
        if kind == 'intent':
            if status == 'pending':
                actions = ['reject']
            stage = 'awaiting_registration' if status == 'pending' else 'host_rejected'
            target, title = raw.get('target'), 'Service enrollment proposal'
        else:
            stage = raw.get('stage', 'unknown')
            if status == 'pending':
                actions = ['approve', 'reject']
            elif status == 'queued':
                actions = ['reject']
            elif kind == 'deployment' and status in ('deployed', 'recovery_required') and raw.get('old_id'):
                actions = ['rollback']
            if kind == 'deployment':
                service = context['service']
                snapshot = raw.get('snapshot')
                target = (snapshot.get('target') if isinstance(snapshot, dict) else
                          service['target'] if service else 'pi-web-hub')
                title = 'Deploy ' + self._label(raw.get('service'), 'pi-web-hub', 64)
            elif kind == 'runtime':
                target, title = 'pi-runtime', 'Update Pi runtime'
            else:
                target, title = raw.get('run_id'), 'Restart Pi process'
        result = {'kind': kind, 'id': checked_hex(raw['id'], HEX32),
                  'revision': fingerprint({'kind': kind, 'task': raw, 'policy': context}),
                  'status': self._label(status, 'unknown', 64),
                  'stage': self._label(stage, 'unknown', 128),
                  'title': self._label(title, 'Gate task'),
                  'target': self._label(target, 'unavailable'), 'actions': actions}
        for field in ('version', 'commit', 'image', 'plan_hash'):
            value = raw.get(field)
            maximum = IMAGE_LIMIT if field == 'image' else 256
            if isinstance(value, str) and self._label(value, '', maximum):
                result[field] = value
        if kind == 'deployment' and 'image' in raw and 'image' not in result:
            # A hash cannot replace the human-reviewable pinned image identity.
            # Redaction must not leave an executable decision advertised.
            result['actions'] = [action for action in actions if action == 'reject']
        # Deployment's historical timestamp is seconds; wire timestamps are ms.
        created = raw.get('created_at', raw.get('created', 0) * 1000)
        if type(created) is int and 0 <= created <= 2 ** 53 - 1:
            result['created_at'] = created
        if kind == 'intent':
            result['details'] = {'executable': False, 'registration_required': True}
        return result

    def task(self, kind, key):
        with self.store.lock:
            return self._task(kind, self._raw(kind, key))

    def _policy_raw(self, kind, key):
        if kind == 'service':
            validate_identifier(key)
            return self.store.service(key)
        if not isinstance(kind, str) or kind not in POLICY_IDS or POLICY_IDS[kind] != key:
            raise ValueError('invalid policy identity')
        return self._manager(kind).policy()

    def _policy(self, kind, key, raw=None):
        raw = self._policy_raw(kind, key) if raw is None else raw
        result = {'kind': kind, 'id': key, 'mode': raw['mode'],
                  'revision': fingerprint({'kind': kind, 'id': key, 'policy': raw})}
        if kind == 'service':
            result['paused'] = bool(raw.get('paused'))
        else:
            result['images'] = list(raw['images'])
        return result

    @staticmethod
    def _open(kind, raw):
        if raw.get('resolved_at'):
            return False
        if kind == 'deployment':
            return raw['status'] in (*ACTIVE, 'pending', 'queued')
        if kind == 'intent':
            return raw['status'] == 'pending'
        return raw['status'] in ('pending', 'queued', 'running', 'failed', 'recovery_required')

    @staticmethod
    def _bounded(value):
        # Match Handler.reply's actual encoding, including separators and spaces.
        if len(json.dumps(value, ensure_ascii=True).encode('ascii')) > RESPONSE_LIMIT:
            raise RuntimeError('management response exceeds bound; inspect individual task')
        return value

    def listing(self):
        with self.store.lock:
            opened, history = [], []
            for kind, table in TABLES.items():
                for row in self.store.db.execute('SELECT data FROM ' + table + ' ORDER BY rowid DESC'):
                    raw = json.loads(row[0])
                    item = self._task(kind, raw)
                    if self._open(kind, raw):
                        opened.append(item)
                    else:
                        history.append(item)
            history.sort(key=lambda task: task.get('created_at', 0), reverse=True)
            policies = [self._policy('service', s['id'], s) for s in self.store.services()]
            policies.extend(self._policy(kind, key) for kind, key in POLICY_IDS.items())
            if len(opened) > TASK_LIMIT or len(policies) > POLICY_LIMIT:
                raise RuntimeError('management overview exceeds count limits; inspect individual task')
            return self._bounded({'tasks': opened + history[:min(HISTORY_LIMIT, TASK_LIMIT - len(opened))],
                                  'policies': policies})

    def receipt(self, key):
        checked_hex(key, HEX32)
        with self.store.lock:
            row = self.store.db.execute('SELECT receipt FROM hub_management_receipts WHERE id=?', (key,)).fetchone()
            if row is None:
                raise KeyError('decision not found')
            return json.loads(row[0])

    def _validate(self, operation, body):
        fields = {'decisions': ('kind', 'id', 'revision', 'action', 'decision_id'),
                  'policies': ('kind', 'id', 'revision', 'mode', 'decision_id'),
                  'resume': ('id', 'revision', 'decision_id')}
        exact(body, fields[operation])
        checked_hex(body['decision_id'], HEX32)
        checked_hex(body['revision'], HEX64)
        if operation == 'decisions':
            checked_hex(body['id'], HEX32)
            if (not isinstance(body['kind'], str) or body['kind'] not in TABLES or
                    body['action'] not in ('approve', 'reject', 'rollback')):
                raise ValueError('invalid decision')
        else:
            validate_identifier(body['id'])
            if operation == 'policies' and (body['kind'] not in ('service', 'runtime', 'restart') or
                                           body['mode'] not in MODES):
                raise ValueError('invalid policy change')

    def _current(self, operation, body):
        if operation == 'decisions':
            raw = self._raw(body['kind'], body['id'])
            current = self._task(body['kind'], raw)
            if body['action'] not in current['actions']:
                raise RuntimeError('action is not advertised')
        else:
            kind = body['kind'] if operation == 'policies' else 'service'
            raw = self._policy_raw(kind, body['id'])
            current = self._policy(kind, body['id'], raw)
            if operation == 'resume' and not current['paused']:
                raise RuntimeError('service is not paused')
        if current['revision'] != body['revision']:
            raise RuntimeError('reviewed revision changed')
        return raw

    def _dispatch(self, operation, body, raw):
        key = body['id']
        if operation == 'resume':
            self.store.resume_service(key)
            return {'policy': self._policy('service', key)}
        if operation == 'policies':
            kind = body['kind']
            if kind == 'service':
                self.store.set_mode(key, body['mode'])
            else:
                self._manager(kind).set_policy({'mode': body['mode'], 'images': raw['images']})
            return {'policy': self._policy(kind, key)}
        kind, action = body['kind'], body['action']
        if kind == 'intent':
            self.store.reject_intent(key)
        elif kind in ('runtime', 'restart'):
            manager = self._manager(kind)
            (manager.approve if action == 'approve' else manager.reject)(key)
        elif action == 'reject':
            # Same real state transition and eligibility as /admin/reject.
            job = self.store.get(key)
            if job['status'] not in ('pending', 'queued'):
                raise RuntimeError('only unstarted requests can be rejected')
            self.store.update(key, status='rejected', stage='host_rejected')
        else:
            confirm = {'plan': raw['plan_hash']} if 'snapshot' in raw else {'commit': raw['commit']}
            (self.gate.approve if action == 'approve' else self.gate.rollback)(key, **confirm)
        return {'task': self.task(kind, key)}

    def write(self, operation, body):
        self._validate(operation, body)
        payload = _json({'operation': operation, 'body': body})
        key = body['decision_id']
        with self.store.lock:
            row = self.store.db.execute('SELECT payload,receipt FROM hub_management_receipts WHERE id=?', (key,)).fetchone()
            if row is not None:
                if row[0] != payload:
                    raise RuntimeError('decision ID reused with different payload')
                return json.loads(row[1])
            if self.gate.closing:
                raise RuntimeError('Gate is closing')
            self.store.require_admission()
            raw = self._current(operation, body)
            receipt = {'decision_id': key, 'status': 'delivery_unknown'}
            # Separate durable transaction MUST finish before calling any executor.
            # An unfinished intent stays unknown forever and is never replayed.
            with self.store._write_transaction():
                count = self.store.db.execute('SELECT COUNT(*) FROM hub_management_receipts').fetchone()[0]
                if count >= RECEIPT_LIMIT:
                    raise RuntimeError('decision storage full; administrator review required')
                self.store.db.execute('INSERT INTO hub_management_receipts (id,payload,receipt) VALUES (?,?,?)',
                                      (key, payload, _json(receipt)))
            try:
                result = self._dispatch(operation, body, raw)
                completed = self._bounded({**receipt, 'status': 'recorded', **result})
                with self.store._write_transaction():
                    self.store.db.execute('UPDATE hub_management_receipts SET receipt=? WHERE id=?', (_json(completed), key))
            except Exception:
                # After durable intent, even a validation-shaped executor error
                # or failed completion write is uncertain. Never let Handler turn
                # it into a 400/409 that the portal interprets as a known rejection.
                # The original durable ID remains blocked against every replay.
                return receipt
            return completed

    def handle(self, handler):
        """No admin dispatcher, encoded suffixes, query parameters or freeform routes."""
        path = handler.path
        route = urlsplit(path)
        launch = self.gate.pi_launches
        if route.path == ROOT + '/workspaces':
            if len(path) > 8192 or route.fragment or '#' in path or re.search(r'%(?![0-9a-fA-F]{2})', path):
                raise ValueError('invalid workspace query')
            params = parse_qs(route.query, keep_blank_values=True, strict_parsing=True,
                              max_num_fields=2, encoding='utf-8', errors='strict')
            if set(params) - {'path', 'cursor'} or any(len(v) != 1 for v in params.values()):
                raise ValueError('invalid workspace query')
            if handler.command != 'GET':
                handler.reply(405, {'error': 'method not allowed'})
            else:
                handler.reply(200, launch.browse(params.get('path', [''])[0], params.get('cursor', [None])[0]))
            return
        if len(path) > 256 or any(char in path for char in ('?', '#', '%', '\\')):
            raise ValueError('invalid management route')
        method = handler.command
        if path in (ROOT + '/launch-config', ROOT + '/launches') or path.startswith(ROOT + '/launches/'):
            if path == ROOT + '/launches' and method == 'POST':
                handler.reply(202, launch.submit(handler.body(maximum=8192, strict=True)))
            elif method != 'GET':
                handler.reply(405, {'error': 'method not allowed'})
            elif path == ROOT + '/launch-config':
                handler.reply(200, launch.configuration())
            elif path == ROOT + '/launches':
                handler.reply(200, launch.jobs())
            else:
                handler.reply(200, launch.get(path.removeprefix(ROOT + '/launches/')))
            return
        if path == ROOT:
            if method != 'GET':
                handler.reply(405, {'error': 'method not allowed'})
            else:
                handler.reply(200, self.listing())
            return
        suffix = path.removeprefix(ROOT + '/')
        if suffix in ('decisions', 'policies', 'resume'):
            if method != 'POST':
                handler.reply(405, {'error': 'method not allowed'})
            else:
                handler.reply(200, self.write(suffix, handler.body(maximum=4096, strict=True)))
            return
        parts = suffix.split('/')
        if len(parts) == 2 and parts[0] == 'decisions':
            checked_hex(parts[1], HEX32)
            if method != 'GET':
                handler.reply(405, {'error': 'method not allowed'})
            else:
                handler.reply(200, self.receipt(parts[1]))
            return
        if len(parts) == 3 and parts[0] == 'tasks':
            if parts[1] not in TABLES:
                raise ValueError('invalid task kind')
            checked_hex(parts[2], HEX32)
            if method != 'GET':
                handler.reply(405, {'error': 'method not allowed'})
            else:
                handler.reply(200, self._bounded(self.task(parts[1], parts[2])))
            return
        handler.reply(404, {'error': 'not found'})

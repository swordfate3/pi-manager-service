"""Gate-owned, offline pre-stop restoration of a private frozen session copy.

History bytes travel only over local Docker channels into disposable
tmpfs, never commands, environment, logs, the runtime volume or the ledger.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import time
from urllib.parse import quote

from .lifecycle_contract import IDENTITIES, identifier, ready, result, source_identity, text
from .runtime_engine import RuntimeEngine
from .runtime_install import digest, VERSION

LIMIT = 64 * 1024 * 1024
FIELDS = ('session_id', 'leaf_id', 'cwd', 'provider', 'model', 'thinking')
SNAPSHOT_KEYS = set(FIELDS) | {'run_id', 'runtime_id', 'session_file', 'version', 'idle', 'pending', 'busy'}


def capture_bytes(raw, descriptor):
    if (not isinstance(raw, bytes) or len(raw) > LIMIT + 65536 or
            type(descriptor.get('bytes')) is not int or not 0 < descriptor['bytes'] <= LIMIT):
        raise ValueError('invalid frozen capture')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        members = archive.getmembers()
        if (len(members) != 1 or members[0].name != 'session.jsonl' or not members[0].isfile()
                or members[0].size != descriptor['bytes'] or members[0].sparse):
            raise ValueError('invalid frozen archive')
        data = archive.extractfile(members[0]).read(LIMIT + 1)
    if len(data) != descriptor['bytes'] or hashlib.sha256(data).hexdigest() != descriptor['sha256']:
        raise ValueError('frozen capture changed')
    return data


def checked_descriptor(value, job, state):
    if (not isinstance(value, dict) or set(value) != {'contract', 'operation_id', 'sha256', 'bytes',
            'session_format', 'snapshot'} or value['contract'] != 'pi-runtime-restore-v1' or
            value['operation_id'] != job['id'] or type(value['bytes']) is not int or not 0 < value['bytes'] <= LIMIT or
            type(value['session_format']) is not int or value['session_format'] < 1 or
            not isinstance(value['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', value['sha256'])):
        raise ValueError('invalid capture descriptor')
    frozen = value['snapshot']
    if not isinstance(frozen, dict) or set(frozen) != SNAPSHOT_KEYS:
        raise ValueError('invalid frozen snapshot')
    ready(frozen, job)
    for key in ('version', *IDENTITIES, 'idle', 'pending', 'busy'):
        if frozen[key] != state[key]:
            raise ValueError('source snapshot changed')
    for key in ('cwd', 'session_file'):
        path = frozen[key]
        if (not isinstance(path, str) or len(path) > 8192 or not path.startswith('/') or
                '..' in path.split('/') or str(Path(path)) != path or any(ord(c) < 32 for c in path)):
            raise ValueError('invalid frozen path')
    for key in ('provider', 'model', 'thinking'):
        text(frozen[key])
    return value


def checked_result(value, parent, descriptor, source):
    if (not isinstance(value, dict) or set(value) != {'ok', 'contract', 'candidate_tree_sha256',
            'session_sha256', 'expected_hash', 'version', 'node', 'restored', 'cwd_mode', 'no_replay'} or
            value['ok'] is not True or value['contract'] != 'pi-runtime-restore-v1' or
            value['candidate_tree_sha256'] != parent['candidate']['tree_sha256'] or
            value['session_sha256'] != descriptor['sha256'] or value['expected_hash'] != digest(descriptor['snapshot']) or
            value['version'] != parent['version'] or value['cwd_mode'] != 'surrogate' or value['no_replay'] is not True or
            value['restored'] != {k: descriptor['snapshot'][k] for k in FIELDS} or
            not isinstance(value['node'], str) or not re.fullmatch(VERSION, value['node']) or
            tuple(map(int, value['node'].split('.'))) < tuple(map(int, parent['release']['node'][2:].split('.')))):
        raise ValueError('restore probe rejected or changed')
    return {'session_sha256': descriptor['sha256'], 'expected_hash': value['expected_hash'],
            'source_hash': digest(source), 'target_tree_sha256': parent['candidate']['tree_sha256'],
            'target_task': parent['id'], 'version': parent['version'], 'profile_hash': digest(parent['profile'])}


class RestoreEngine(RuntimeEngine):
    @staticmethod
    def name(job, phase):
        if phase != 'validate':
            raise ValueError('invalid restore helper phase')
        return 'pi-runtime-restore-' + identifier(job['id'])

    def definition(self, job, phase):
        definition = super().definition(job, phase)
        # This program is Gate source in the immutable job profile, not a
        # supervisor/extension supplied path or shared-volume executable.
        installer = Path(__file__).with_name('runtime_install.py').read_text()
        request = {'candidate_prefix': '/home/node/.local/.pi-releases/' + identifier(job['target_task']),
                   'session_path': '/tmp/restore-input/session.jsonl', 'expected': job['frozen']['snapshot'],
                   'workdir': '/tmp/restore-work', 'profile': job['profile']}
        script = ('import json,time,os,sys\nfrom pathlib import Path\n'
                  'scope={"__name__":"gate_fixed_probe"}\nexec(' + repr(installer) + ',scope)\n'
                  'Path("/tmp/restore-input").mkdir(mode=0o700)\n'
                  'Path("/tmp/restore-work").mkdir(mode=0o700)\n'
                  'end=time.monotonic()+25\n'
                  'while not Path("/tmp/restore-input/ready").exists():\n'
                  ' if time.monotonic()>end: sys.exit(1)\n'
                  ' time.sleep(.05)\n'
                  'try:\n'
                  ' value=scope["run_probe"](json.loads(sys.argv[1]),mode="--restore")\n'
                  ' print(json.dumps(value,separators=(",",":")),flush=True)\n'
                  'except Exception:\n'
                  ' print("{\\"ok\\":false,\\"stage\\":\\"restore_probe_failed\\"}",flush=True)\n'
                  ' sys.exit(1)\n')
        definition['Cmd'] = [script, json.dumps(request, sort_keys=True, separators=(',', ':'))]
        definition['HostConfig']['LogConfig'] = {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}}
        return definition

    def outcome(self, job):
        item = self.inspect(job, 'validate')
        if not item or item.get('State', {}).get('Status') != 'exited':
            return None
        raw = self.engine.call('GET', '/containers/' + item['Id'] + '/logs?stdout=1&stderr=1',
                               response_raw=True, timeout=3, limit=16384)
        output, offset = bytearray(), 0
        while offset < len(raw):
            header = raw[offset:offset + 8]
            if len(header) != 8 or header[:4] != b'\x01\0\0\0':
                raise ValueError('invalid restore probe output')
            length = int.from_bytes(header[4:], 'big')
            offset += 8
            if offset + length > len(raw):
                raise ValueError('incomplete restore probe output')
            output.extend(raw[offset:offset + length])
            offset += length
        if item['State'].get('ExitCode') != 0:
            raise ValueError('restore probe failed')
        return json.loads(output)


def prepare_refresh(life, job, item, state, outer):
    """One durable attempt. A recovered pre-stop attempt is never redispatched."""
    parent = life.gate.runtime_updates._get(job.get('runtime_update_id') or job['runtime_evidence_id'])
    source = source_identity(state.get('source_identity'), state['version'])
    life._policy_fence(job)
    key, engine = job['id'], life._engine()
    # Persist before the freeze; a crash can only leave a bounded barrier lease,
    # not a second stop or an unobserved live-process mutation.
    job = life._update(key, stage='restore_preparing', restore_intent_at=int(life.clock.time() * 1000))
    request = {**{k: job[k] for k in IDENTITIES}, 'action': 'prepare_restore', 'operation_id': key}
    frozen = checked_descriptor(result(engine.lifecycle_control(item['Id'], request, timeout=3)), job, state)
    helper = None
    restore_engine = RestoreEngine(engine, volume=life.gate.runtime_volume)
    helper_job = {**job, 'version': parent['version'], 'target_task': parent['id'], 'profile': parent['profile'],
                  'frozen': frozen, 'helpers': {}}
    try:
        path = '/run/pi-runtime/restore-' + identifier(key) + '/session.jsonl'
        raw = engine.call('GET', '/containers/' + item['Id'] + '/archive?path=' + quote(path, safe=''),
                          response_raw=True, timeout=min(10, outer.remaining()), limit=LIMIT + 65536)
        data = capture_bytes(raw, frozen)
        # Persist the complete inert definition before create, closing the
        # create-before-ID-record crash window via the deterministic name.
        life._update(key, stage='restore_creating', restore_helper=helper_job)
        helper = restore_engine.create(helper_job, 'validate')
        helper_job['helpers'] = {'validate': {'id': helper, 'intent_at': int(life.clock.time() * 1000)}}
        life._update(key, stage='restore_validating', restore_helper=helper_job)
        life._policy_fence(job)
        restore_engine.start(helper_job, 'validate')
        # Docker archive PUT cannot reliably reach the running /tmp tmpfs.
        # Re-inspect the exact helper and use one independent fixed exec stdin
        # upload. Uncertainty cancels this attempt; never create/start/retry it.
        inspected = restore_engine.inspect(helper_job, 'validate')
        if (not inspected or inspected['Id'] != helper or
                inspected.get('State', {}).get('Status') != 'running' or
                inspected.get('State', {}).get('Running') is not True):
            raise ValueError('restore input unavailable')
        engine.restore_upload(helper, data, byte_count=frozen['bytes'], sha256=frozen['sha256'],
                              timeout=min(12, outer.remaining()))
        del data, raw
        end = time.monotonic() + min(95, outer.remaining())
        while time.monotonic() < end:
            value = restore_engine.outcome(helper_job)
            if value is not None:
                proof = checked_result(value, parent, frozen, source)
                life._policy_fence(job)
                life._resolve(job['run_id'], job['policy'], item['Id'], expected_hash=job['target_hash'])
                latest = life._status(item)
                if latest.get('source_identity') != source:
                    raise ValueError('source identity changed')
                ready(latest, job)
                return life._update(key, restore_proof=proof, stage='restore_verified')
            time.sleep(.1)
        raise ValueError('restore probe timed out')
    except BaseException:
        try:
            engine.lifecycle_control(item['Id'], {'action':'cancel_restore', 'run_id':job['run_id'],
                                                 'operation_id':key}, timeout=3)
        except Exception:
            pass
        raise
    finally:
        if helper:
            # Only this exact private helper; never a consumer or broad cleanup.
            try:
                engine.call('DELETE', '/containers/' + helper + '?force=1&v=1', timeout=3)
            except Exception:
                pass


def reconcile_interrupted(life, job):
    """Cancel/clean one pre-stop attempt off-lock; never prepare, start or stop Pi."""
    key, engine = job['id'], life._engine()
    try:
        item = life._resolve(job['run_id'], job['policy'], job['container_id'],
                             expected_hash=job['target_hash'])
        state = life._status(item)
        if (state.get('runtime_id') != job['runtime_id'] or
                state.get('session_id') != job['session_id'] or
                (state.get('operation') or {}).get('status') == 'running'):
            raise RuntimeError('source restore outcome unavailable')
        reply = result(engine.lifecycle_control(item['Id'], {'action': 'cancel_restore',
                       'run_id': job['run_id'], 'operation_id': key}, timeout=3))
        if reply != {'cancelled': True}:
            raise RuntimeError('capture cancellation unverified')
        plan = job.get('restore_helper')
        if plan is not None:
            if not isinstance(plan, dict) or plan.get('id') != key:
                raise RuntimeError('restore helper record changed')
            helper = RestoreEngine(engine, volume=life.gate.runtime_volume).inspect(plan, 'validate')
            if helper is not None:
                if helper.get('Id') == item['Id']:
                    raise RuntimeError('restore helper confused with consumer')
                engine.call('DELETE', '/containers/' + helper['Id'] + '?force=1&v=1', timeout=3)
        elif engine.inspect('pi-runtime-restore-' + identifier(key), timeout=3) is not None:
            # An old/unrecorded helper cannot be adopted without its full
            # frozen definition. Leave inspection explicit, never broad delete.
            raise RuntimeError('unrecorded restore helper')
        life._update(key, status='stale', stage='restore_pre_stop_failed', restore_reconciled=True,
                     restore_cleanup_at=int(life.clock.time() * 1000))
    except Exception:
        life._update(key, status='recovery_required', stage='restore_recovery_unknown')

"""Restricted launch admission and durable, public-safe launch ledger."""
from contextlib import contextmanager
import copy
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import unicodedata

from .hub_management import HEX32, HEX64, checked_hex, exact
from .store import ACTIVE, REQUEST_OPEN, Store, _json

POLICY_FIELDS = ('version', 'enabled', 'root', 'root_label', 'default_path', 'profile_root',
                 'credential_root', 'pi_image', 'hub_image', 'hub_container', 'hub_config',
                 'hub_export_root', 'volumes', 'environment', 'auxiliary_binds', 'gate_provenance')
VOLUMES = {'home': '/home/node', 'runtime': '/home/node/.local', 'config': '/home/node/.pi',
           'credentials': '/home/node/.credentials', 'cache': '/home/node/.cache/huggingface',
           'hub_runtime': '/run/pi-web-hub'}
ENVIRONMENT = frozenset(('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                         'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                         'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN', 'PI_CC_SWITCH_MODELS_DIR'))
PUBLIC = ('id', 'path', 'label', 'status', 'stage', 'created_at', 'updated_at', 'run_id')
LIVE = ('queued', 'starting', 'running', 'recovery_required')


def digest(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def text(value, maximum, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or (not value and not empty) or
            any(unicodedata.category(c).startswith('C') for c in value)):
        raise ValueError('invalid launch text')
    return value


def relative(value):
    text(value, 1024, empty=True)
    if '\\' in value or (value and any(c in ('', '.', '..') for c in value.split('/'))):
        raise ValueError('invalid workspace path')
    return value


def absolute(value):
    text(value, 4096)
    if not value.startswith('/') or value == '/' or relative(value[1:]) != value[1:]:
        raise ValueError('invalid private path')
    return value


def overlap(a, b):
    return a == b or a.startswith(b + '/') or b.startswith(a + '/')


@contextmanager
def directory(root, path=''):
    """Walk *every* component, including the configured absolute root, no-follow."""
    absolute(root)
    relative(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in (root[1:] + ('/' + path if path else '')).split('/'):
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    except OSError:
        raise ValueError('directory unavailable') from None
    finally:
        os.close(fd)


def identity(fd):
    info = os.fstat(fd)
    return [info.st_dev, info.st_ino]


def load_policy(path):
    path = Path(path)
    absolute(str(path))
    from .terminal_contract import pairs, nonfinite
    with directory(str(path.parent)) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid()):
                raise ValueError('unsafe launch policy')
            raw = stream.read(32769)
    if len(raw) > 32768:
        raise ValueError('launch policy too large')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
    if not isinstance(value, dict) or value.get('profile_root') != str(path.parent):
        raise ValueError('launch profile location mismatch')
    return value


def validate_policy(value, state):
    if not isinstance(value, dict):
        raise ValueError('invalid launch policy')
    value = copy.deepcopy(value)
    value.setdefault('auxiliary_binds', [])
    exact(value, POLICY_FIELDS)
    if type(value['version']) is not int or value['version'] != 1 or type(value['enabled']) is not bool:
        raise ValueError('invalid launch policy version')
    if value['default_path'] != 'pi_projects':
        raise ValueError('invalid default workspace')
    text(value['root_label'], 80)
    roots = [absolute(value[k]) for k in ('root', 'profile_root', 'credential_root')]
    roots.append(str(Path(state).absolute()))
    if any(overlap(a, b) for i, a in enumerate(roots) for b in roots[i + 1:]):
        raise ValueError('overlapping launch authority roots')
    identities = {}
    for key in ('root', 'profile_root', 'credential_root'):
        with directory(value[key]) as fd:
            info = os.fstat(fd)
            if key != 'root' and (stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid()):
                raise ValueError('unsafe private launch directory')
            identities[key] = identity(fd)
    for key in ('pi_image', 'hub_image'):
        if not isinstance(value[key], str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value[key]):
            raise ValueError('immutable launch image required')
    checked_hex(value['hub_container'], HEX64)
    provenance = value['gate_provenance']
    if not isinstance(provenance, dict) or provenance.get('mode') not in ('host', 'container'):
        raise ValueError('explicit Gate provenance required')
    if provenance['mode'] == 'host':
        exact(provenance, ('mode',))
    else:
        exact(provenance, ('mode', 'container', 'image'))
        checked_hex(provenance['container'], HEX64)
        if not isinstance(provenance['image'], str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', provenance['image']):
            raise ValueError('immutable Gate image required')
    absolute(value['hub_config'])
    absolute(value['hub_export_root'])
    if overlap(str(Path(value['hub_config']).parent), value['hub_export_root']):
        raise ValueError('Hub export must be separate from configuration')
    exact(value['volumes'], VOLUMES)
    names = list(value['volumes'].values())
    if (any(not isinstance(n, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', n) for n in names)
            or len(set(names)) != len(names)):
        raise ValueError('invalid launch volumes')
    env = value['environment']
    if not isinstance(env, dict) or set(env) - ENVIRONMENT:
        raise ValueError('invalid launch environment')
    for entry in env.values():
        text(entry, 4096, empty=True)
    binds = value['auxiliary_binds']
    if not isinstance(binds, list) or len(binds) > 1:
        raise ValueError('invalid auxiliary bind list')
    if 'PI_CC_SWITCH_MODELS_DIR' in env and (not binds or env['PI_CC_SWITCH_MODELS_DIR'] != '/run/cc-switch-pi-models'):
        raise ValueError('model environment requires the fixed model bind')
    for bind in binds:
        exact(bind, ('source', 'target', 'read_only'))
        source = absolute(bind['source'])
        if (bind['target'] != '/run/cc-switch-pi-models' or bind['read_only'] is not True or
                any(overlap(source, root) for root in roots) or
                any(overlap(source, blocked) for blocked in ('/etc', '/proc', '/sys', '/dev', '/run', '/var/lib/docker'))):
            raise ValueError('unsafe auxiliary bind')
        with directory(source) as fd:
            identities['models'] = identity(fd)
    if len(_json(value)) > 32768:
        raise ValueError('launch profile too large')
    return value, identities


class LaunchStore(Store):
    """Keep legacy managers fenced at their existing shared admission boundary."""
    launch_fence = None

    def require_admission(self):
        super().require_admission()
        if self.launch_fence and self.launch_fence():
            raise RuntimeError('Pi launches reserve admission')


class PiLaunches:
    def __init__(self, gate, policy=None, engine=None):
        self.gate, self.store, self.engine = gate, gate.store, engine
        self.policy_file = Path(policy) if isinstance(policy, (str, Path)) else None
        if self.policy_file is not None:
            policy = load_policy(self.policy_file)
        self.policy, self.identities = (validate_policy(policy, gate.directory) if policy is not None
                                        else (None, {}))
        self.revision = digest({'policy': self.policy, 'identities': self.identities})
        self.poll_index = 0
        with self.store.lock, self.store._write_transaction():
            self.store.db.execute('CREATE TABLE IF NOT EXISTS pi_launch_jobs '
                                  '(id TEXT PRIMARY KEY, data TEXT NOT NULL)')

    def configuration(self):
        return dict(enabled=bool(self.policy and self.policy['enabled']),
                    rootLabel=self.policy['root_label'] if self.policy else 'gitproject',
                    defaultPath='pi_projects', revision=self.revision, maxActive=16)

    def _enabled(self):
        if not self.configuration()['enabled']:
            raise RuntimeError('Pi launches disabled')

    def _revalidate(self):
        self._enabled()
        value = load_policy(self.policy_file) if self.policy_file else self.policy
        policy, identities = validate_policy(value, self.gate.directory)
        if digest({'policy': policy, 'identities': identities}) != self.revision:
            raise RuntimeError('launch policy changed')

    @contextmanager
    def _workspace(self, path):
        self._enabled()
        relative(path)
        with directory(self.policy['root']) as root:
            if identity(root) != self.identities['root']:
                raise RuntimeError('workspace root changed')
        with directory(self.policy['root'], path) as fd:
            yield fd, digest({'root': self.identities['root'], 'path': path, 'inode': identity(fd)})

    def browse(self, path='', cursor=None):
        if cursor is not None:
            text(cursor, 255)
            if '/' in cursor or relative(cursor) != cursor:
                raise ValueError('invalid workspace cursor')
        with self._workspace(path) as (fd, revision):
            names = []
            with os.scandir(fd) as entries:
                for index, entry in enumerate(islice(entries, 4096)):
                    # Fail closed at the conservative ceiling. A partial scan
                    # cannot promise that lexical pagination will advance.
                    if index == 4095:
                        raise RuntimeError('workspace directory exceeds browse limit')
                    try:
                        relative(entry.name)
                        if entry.is_dir(follow_symlinks=False) and (cursor is None or entry.name > cursor):
                            names.append(entry.name)
                    except (OSError, ValueError):
                        continue
        names.sort()
        truncated = len(names) > 200
        names = names[:200]
        result = dict(path=path, parent=path.rpartition('/')[0] if path else None,
                      revision=revision, entries=[{'name': n, 'path': path + '/' + n if path else n} for n in names],
                      truncated=truncated)
        if truncated and names:
            result['nextCursor'] = names[-1]
        return result

    @staticmethod
    def _public(job):
        return {key: job[key] for key in PUBLIC if key in job}

    def _jobs(self):
        with self.store.lock:
            return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM pi_launch_jobs ORDER BY rowid DESC')]

    def _get(self, key):
        checked_hex(key, HEX32)
        with self.store.lock:
            row = self.store.db.execute('SELECT data FROM pi_launch_jobs WHERE id=?', (key,)).fetchone()
            if row is None:
                raise KeyError(key)
            return json.loads(row[0])

    def get(self, id):
        return self._public(self._get(id))

    def jobs(self):
        return {'jobs': [self._public(j) for j in self._jobs()]}

    def active(self):
        return [self._public(j) for j in self._jobs() if j['status'] in LIVE]

    def busy(self):
        """Side-effect reservation, not the lifetime of a stable running Pi."""
        return [j for j in self.active() if j['status'] != 'running' or j['stage'] != 'running']

    def _other_work(self):
        return (self.gate.closing or self.store.upgrade_reservation() or
                self.gate.lifecycle.active() or self.gate.runtime_updates.active() or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list()))

    def submit(self, value):
        self._enabled()
        exact(value, ('id', 'path', 'label', 'policy_revision', 'workspace_revision'))
        checked_hex(value['id'], HEX32)
        checked_hex(value['policy_revision'], HEX64)
        checked_hex(value['workspace_revision'], HEX64)
        relative(value['path'])
        text(value['label'], 80)
        if value['label'].strip() != value['label']:
            raise ValueError('untrimmed launch label')
        with self.store.lock:
            try:
                previous = self._get(value['id'])
            except KeyError:
                previous = None
            if previous:
                if previous['request'] != value:
                    raise RuntimeError('launch ID payload conflict')
                return self._public(previous)
            Store.require_admission(self.store)
            if self._other_work() or (self.gate.worker and self.gate.worker.is_alive()):
                raise RuntimeError('Gate work active')
            self._revalidate()
            with self._workspace(value['path']) as (_, revision):
                if value['policy_revision'] != self.revision or value['workspace_revision'] != revision:
                    raise RuntimeError('launch selection changed')
            if len(self.active()) >= 16 or len(self._jobs()) >= 256:
                raise RuntimeError('launch quota full')
            now = int(time.time() * 1000)
            job = dict(id=value['id'], path=value['path'], label=value['label'], status='queued', stage='queued',
                       created_at=now, updated_at=now, request=copy.deepcopy(value))
            with self.store._write_transaction():
                self.store.db.execute('INSERT INTO pi_launch_jobs (id,data) VALUES (?,?)', (job['id'], _json(job)))
            return self._public(job)

    def _update(self, key, **fields):
        with self.store.lock, self.store._write_transaction():
            job = self._get(key)
            if all(name in job and job[name] == value for name, value in fields.items()):
                return job
            job.update(fields, updated_at=int(time.time() * 1000))
            self.store.db.execute('UPDATE pi_launch_jobs SET data=? WHERE id=?', (_json(job), key))
            return job

    def _engine(self):
        from .engine import Engine
        from .pi_launch_engine import PiLaunchEngine
        return PiLaunchEngine(self.engine or Engine(), self.policy, str(self.gate.directory.absolute()))

    def _fence(self, job, workspace=True):
        with self.store.lock:
            Store.require_admission(self.store)
            if self._other_work():
                raise RuntimeError('Gate launch fenced')
            self._revalidate()
            if job['request']['policy_revision'] != self.revision:
                raise RuntimeError('launch policy revision changed')
            if workspace:
                with self._workspace(job['path']) as (_, revision):
                    if revision != job['request']['workspace_revision']:
                        raise RuntimeError('selected workspace changed')

    def recover(self):
        # No daemon calls or repeated writes. A queued job has no side effects;
        # a started job must first prove its exact recorded outcome read-only.
        with self.store.lock:
            for job in self._jobs():
                if job['status'] == 'starting':
                    self._update(job['id'], status='recovery_required')

    def tick(self):
        with self.store.lock:
            if self.gate.closing or self.store.upgrade_reservation() or (self.gate.worker and self.gate.worker.is_alive()):
                return bool(self.active())
            jobs = self._jobs()
            if self._other_work():
                return bool(self.busy())
            queued = [j for j in reversed(jobs) if j['status'] == 'queued']
            poll = [j for j in reversed(jobs) if j['status'] == 'running' or
                    (j['status'] == 'recovery_required' and j['stage'] in ('create_intent', 'start_intent', 'running'))]
            if queued:
                job = self._update(queued[0]['id'], status='starting', stage='validating')
                target = self._execute
            elif poll:
                job = poll[self.poll_index % len(poll)]
                self.poll_index += 1
                target = self._poll
            else:
                return bool(self.active())
            self.gate.worker = threading.Thread(target=target, args=(job,), name='pi-launch', daemon=False)
            self.gate.worker.start()
            return True

    def _execute(self, job):
        try:
            self._fence(job)
            engine = self._engine()
            image = engine.preflight(job)
            self._fence(job)
            job = self._update(job['id'], stage='grant_intent', **image)
            credential = engine.grant(job)
            job = self._update(job['id'], stage='credential_intent', run_id=credential['run_id'])
            credential_identity = engine.write_credential(job, credential)
            job = self._update(job['id'], stage='credential_ready', credential_identity=credential_identity)
            self._fence(job)
            job = self._update(job['id'], stage='create_intent')
            container = engine.create(job)
            job = self._update(job['id'], stage='created', container_id=container)
            self._fence(job)
            job = self._update(job['id'], stage='start_intent')
            engine.start(job)
            item = engine.observe(job)
            if item is None or item.get('State', {}).get('Running') is not True:
                raise RuntimeError('launch start not confirmed')
            self._update(job['id'], status='running', stage='running')
        except Exception:
            latest = self._get(job['id'])
            self._update(job['id'], status='failed' if latest['stage'] == 'validating' else 'recovery_required')

    def _poll(self, job):
        try:
            with self.store.lock:
                if self._other_work():
                    return
                self._fence(job, workspace=False)
            engine = self._engine()
            item = engine.observe(job)
            if item is None:
                raise RuntimeError('launch result unproved')
            job = self._update(job['id'], container_id=item['Id'])
            if item.get('State', {}).get('Running') is True and item['State'].get('Status') == 'running':
                self._update(job['id'], status='running', stage='running')
            elif engine.exited(item):
                with self.store.lock:
                    # Read-only inspection may overlap new admission. Reserve
                    # cleanup atomically only after rechecking that boundary.
                    if self._other_work():
                        return
                    self._fence(job, workspace=False)
                    job = self._update(job['id'], status='starting', stage='revoke_intent')
                engine.revoke(job)
                job = self._update(job['id'], stage='remove_intent')
                engine.remove_container(job)
                job = self._update(job['id'], stage='credential_remove_intent')
                engine.remove_credential(job)
                self._update(job['id'], status='exited', stage='complete')
            else:
                self._update(job['id'], status='recovery_required')
        except Exception:
            self._update(job['id'], status='recovery_required')

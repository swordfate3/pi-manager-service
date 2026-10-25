"""Fixed-operation runtime installer; its only persistent mount is pi-runtime."""
import json
import hashlib
import os
from pathlib import Path
import time
import re
from urllib.parse import quote

from .engine import DockerTimeout
from .lifecycle_contract import CONTAINER, IMAGE, identifier, source_identity
from .runtime_install import CHECKS, VERSION, checked_candidate, checked_evidence, digest

MAX_SOURCES = 128
SOURCE_PHASE = re.compile(r'source-([0-9a-f]{64})\Z')


def checked_source(value, version):
    if not isinstance(version, str) or not re.fullmatch(VERSION, version):
        raise ValueError('invalid source version')
    return source_identity(value, version)


def checked_source_image(job, item):
    """A source probe covers one exact image profile, not the policy image set."""
    images = job.get('policy', {}).get('images')
    image = job.get('profile', {}).get('image')
    if (not isinstance(images, list) or not images or not isinstance(image, str) or
            not IMAGE.fullmatch(image) or image != images[0] or item.get('Image') != image):
        raise RuntimeError('image_profile_mismatch')
    return image


def checked_source_evidence(value, source, profile):
    checked_source(source, source.get('version'))
    if (not isinstance(profile, dict) or not isinstance(value, dict) or
            set(value) != {'ok', 'source_hash', 'profile_hash', 'node', 'checks'} or
            value['ok'] is not True or value['source_hash'] != digest(source) or
            value['profile_hash'] != digest(profile) or not isinstance(value['node'], str) or
            not re.fullmatch(VERSION, value['node']) or
            tuple(map(int, value['node'].split('.'))) < tuple(map(int, source['node'][2:].split('.'))) or
            not isinstance(value['checks'], dict) or set(value['checks']) != set(CHECKS) or
            any(check is not True for check in value['checks'].values())):
        raise ValueError('source compatibility evidence missing or changed')
    return value


def runtime_volume(value):
    if value != 'pi-runtime' and (not isinstance(value, str) or
            re.fullmatch(r'pi-runtime-update-test-[0-9a-f]{12,32}', value) is None):
        raise ValueError('invalid trusted runtime volume')
    return value


class RuntimeEngine:
    def __init__(self, engine, *, volume='pi-runtime'):
        self.engine = engine
        self.volume = runtime_volume(volume)

    @staticmethod
    def profile(job):
        """Gate-owned source identities, never read from the shared runtime volume."""
        here = Path(__file__).resolve()
        runtime = here.parents[2] / 'runtime'
        legacy_web_source = os.environ.get('PI_MANAGER_LEGACY_WEB_SOURCE')
        if not legacy_web_source:
            raise RuntimeError('legacy Web source is not configured')
        extensions = Path(legacy_web_source).expanduser().resolve() / 'extensions'
        def sources(root, suffixes):
            paths = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix in suffixes)
            if not paths or any(p.is_symlink() for p in paths):
                raise RuntimeError('execution profile unavailable')
            rows = [(str(p.relative_to(root)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths]
            return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()
        return {'contract': 'pi-runtime-validation-v1', 'image': job['policy']['images'][0],
                'helper_sha256': sources(here.parent, {'.py'}),
                'adapter_sha256': sources(runtime, {'.py', '.mjs'}),
                'web_sha256': sources(extensions, {'.ts', '.mjs'}),
                'probe_sha256': hashlib.sha256(json.dumps([
                    (name, hashlib.sha256((runtime / name).read_bytes()).hexdigest())
                    for name in sorted(('runtime_probe.py', 'runtime_probe_provider.ts', 'runtime_probe_ws.mjs'))
                ], separators=(',', ':')).encode()).hexdigest()}

    @staticmethod
    def consumer_blocker(item, state):
        """Evaluability only, never a compatibility or pre-stop restoration grant."""
        try:
            checked_source(state.get('source_identity'), state.get('version'))
        except (ValueError, TypeError, AttributeError):
            return 'source_evidence_unavailable'
        return None

    def consumers(self, *, timeout=3):
        # Paused/restarting containers still own live runtime obligations.
        # Exact-ID inspection, never a list filter, decides terminal exit.
        filters = {'volume': [self.volume]}
        return self.engine.call('GET', '/containers/json?all=1&filters=' +
                                quote(json.dumps(filters), safe=''), timeout=timeout, limit=1024 * 1024)

    def image_environment(self, definition):
        image = self.engine.image_info(definition['Image'], timeout=3)
        if (not image or image.get('Id') != definition['Image'] or image.get('Config', {}).get('Volumes')):
            raise RuntimeError('invalid runtime helper image')
        raw = image.get('Config', {}).get('Env') or []
        values = dict(e.split('=', 1) for e in raw if isinstance(e, str) and '=' in e)
        if len(values) != len(raw):
            raise RuntimeError('ambiguous helper image environment')
        values.update(e.split('=', 1) for e in definition['Env'])
        for key, value in values.items():
            if (key.startswith(('LD_', '_PYTHON')) or (key.startswith('PYTHON') and
                    not (key == 'PYTHON' and value == '/usr/bin/python3')) or
                    key in ('NODE_PATH', 'BASH_ENV', 'ENV') or (key == 'NODE_OPTIONS' and value) or
                    re.search(r'(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)', key, re.I)):
                raise RuntimeError('untrusted helper image environment')
        return values

    @staticmethod
    def name(job, phase):
        identifier(job['id'])
        if phase not in ('prepare', 'validate', 'activate'):
            match = SOURCE_PHASE.fullmatch(phase) if isinstance(phase, str) else None
            if not match:
                raise ValueError('invalid helper phase')
            sources = job.get('sources', {})
            record = sources.get(match[1], {})
            value = record.get('identity')
            checked_source(value, value.get('version') if isinstance(value, dict) else None)
            if len(sources) > MAX_SOURCES or digest(value) != match[1]:
                raise ValueError('source helper identity changed')
        return 'pi-runtime-updater-' + job['id'] + '-' + phase

    def definition(self, job, phase):
        self.name(job, phase)
        if SOURCE_PHASE.fullmatch(phase):
            checked_source_image(job, {'Image': job['policy']['images'][0]})
        script = Path(__file__).with_name('runtime_install.py').read_text()
        arguments = {'release': job.get('release')}
        if phase != 'prepare':
            arguments.update(candidate=job.get('candidate'), profile=job.get('profile'))
        if phase == 'activate':
            arguments['evidence'] = job.get('evidence')
        command = [script, job['version'], job['id'], phase,
                   json.dumps(arguments, sort_keys=True, separators=(',', ':'))]
        if SOURCE_PHASE.fullmatch(phase):
            arguments = {'source': job['sources'][phase[7:]]['identity'], 'profile': job['profile']}
            # Execute Gate's fixed launcher code, not a mutable volume module.
            # Strip only runtime_install's CLI footer; run_probe independently
            # verifies the immutable probe files before accepting data-only IPC.
            script = script.rsplit("\nif __name__ == '__main__':", 1)[0] + '''
try:
    outcome = run_probe(json.loads(sys.argv[1]), mode='--source')
except Exception:
    outcome = {'ok': False, 'stage': 'compatibility_probe_failed'}
print(json.dumps(outcome, separators=(',', ':')), flush=True)
sys.exit(0 if outcome.get('ok') is True else 1)
'''
            command = [script, json.dumps(arguments, sort_keys=True, separators=(',', ':'))]
        return {
            'Image': job['policy']['images'][0], 'User': '1000:1000',
            'Healthcheck': {'Test': ['NONE']},
            'Entrypoint': ['/usr/bin/python3', '-I', '-c'],
            'Cmd': command, 'WorkingDir': '/tmp',
            'Env': ['HOME=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_OPTIONS=',
                    'NPM_CONFIG_USERCONFIG=/dev/null', 'NPM_CONFIG_GLOBALCONFIG=/tmp/npm-globalrc',
                    'NPM_CONFIG_CACHE=/tmp/npm-cache', 'NPM_CONFIG_PREFIX=/home/node/.local'],
            'Labels': {'cn.swordfate.pi.runtime-update': job['id'],
                       'cn.swordfate.pi.runtime-phase': phase},
            'HostConfig': {
                'NetworkMode': 'host' if phase == 'prepare' else 'none',
                'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                'SecurityOpt': ['no-new-privileges:true'], 'Memory': 1073741824,
                'NanoCpus': 2000000000, 'PidsLimit': 96,
                'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                'Tmpfs': {'/tmp': 'rw,nosuid,nodev,size=512m,mode=1777'},
                'Mounts': [{'Type': 'volume', 'Source': self.volume,
                            'Target': '/home/node/.local', 'ReadOnly': phase != 'prepare' and phase != 'activate',
                            'VolumeOptions': {'NoCopy': True}}],
                'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}},
            },
        }

    def inspect(self, job, phase):
        saved = job.get('helpers', {}).get(phase, {})
        item = self.engine.inspect(saved.get('id') or self.name(job, phase), timeout=3)
        if item is None:
            return None
        definition = self.definition(job, phase)
        config, host = item.get('Config', {}), item.get('HostConfig', {})
        mounts = item.get('Mounts') or []
        if (not CONTAINER.fullmatch(item.get('Id', '')) or item['Image'] != definition['Image'] or
                any(config.get(k) != definition[k] for k in ('User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Healthcheck')) or
                config.get('Labels', {}).get('cn.swordfate.pi.runtime-update') != job['id'] or
                config.get('Labels', {}).get('cn.swordfate.pi.runtime-phase') != phase or
                (saved.get('id') is not None and item['Id'] != saved['id']) or
                any(host.get(k) != definition['HostConfig'][k] for k in
                    ('NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Memory',
                     'NanoCpus', 'PidsLimit', 'RestartPolicy', 'Tmpfs', 'LogConfig')) or
                host.get('Privileged') or host.get('CapAdd') or host.get('Devices') or
                host.get('Binds') or host.get('VolumesFrom') or
                any(host.get(k) for k in ('DeviceRequests', 'GroupAdd', 'PidMode', 'UTSMode',
                                         'PortBindings', 'ExtraHosts', 'Links', 'ContainerIDFile')) or
                host.get('IpcMode') not in (None, '', 'private') or host.get('UsernsMode') == 'host' or
                len(mounts) != 1 or mounts[0].get('Type') != 'volume' or
                mounts[0].get('Name') != self.volume or
                mounts[0].get('Destination') != '/home/node/.local' or
                mounts[0].get('RW') is not (phase in ('prepare', 'activate')) or
                mounts[0].get('Propagation', '') not in ('', 'rprivate') or
                mounts[0].get('SubPath') or mounts[0].get('Subpath')):
            raise RuntimeError('runtime helper identity changed')
        # Docker merges immutable image defaults with the explicit overrides.
        # Compare the whole result, rejecting duplicates, credentials/loaders,
        # and injected values without rejecting inert image-specific paths.
        actual = config.get('Env') or []
        expected = self.image_environment(definition)
        values = dict(e.split('=', 1) for e in actual if isinstance(e, str) and '=' in e)
        if len(values) != len(actual) or values != expected:
            raise RuntimeError('runtime helper environment changed')
        volume = self.engine.lifecycle_volume(self.volume)
        if (not volume or volume.get('Driver') != 'local' or volume.get('Options') or
                mounts[0].get('Source') != volume.get('Mountpoint')):
            raise RuntimeError('untrusted runtime volume')
        return item

    def create(self, job, phase):
        """Creation is inert. The caller commits this ID before dispatching start."""
        item = self.inspect(job, phase)
        if item is None:
            if phase in job.get('helpers', {}):
                raise RuntimeError('persisted helper disappeared')
            self.image_environment(self.definition(job, phase))
            created = self.engine.call('POST', '/containers/create?name=' + self.name(job, phase),
                                       self.definition(job, phase), timeout=3, limit=16384)
            if not CONTAINER.fullmatch(created.get('Id', '')):
                raise RuntimeError('invalid helper container')
            item = self.inspect({**job, 'helpers': {phase: {'id': created['Id']}}}, phase)
        if not item or item.get('State', {}).get('Status') != 'created':
            raise RuntimeError('unrecorded helper may have run')
        return item['Id']

    def start(self, job, phase):
        saved = job.get('helpers', {}).get(phase, {})
        if not saved.get('id') or not saved.get('intent_at'):
            raise RuntimeError('durable helper identity and intent required')
        item = self.inspect(job, phase)
        if not item or item.get('State', {}).get('Status') != 'created':
            raise RuntimeError('helper start outcome ambiguous')
        self.engine.call('POST', '/containers/' + item['Id'] + '/start', timeout=3)
        return item['Id']

    def poll(self, job, phase):
        try:
            item = self.inspect(job, phase)
        except DockerTimeout:
            return {'state': 'observation_timeout'}
        if not item:
            return {'state': 'unknown'}
        state = item.get('State', {})
        if state.get('Running'):
            if time.time() - job['helpers'][phase]['intent_at'] / 1000 > 900:
                # Stop only the fixed helper, never an Agent; do not infer activation.
                self.engine.call('POST', '/containers/' + item['Id'] + '/stop?t=2', timeout=3)
                return {'state': 'unknown'}
            return {'state': 'running'}
        if state.get('Status') != 'exited':
            return {'state': 'unknown'}
        try:
            raw = self.engine.call('GET', '/containers/' + item['Id'] + '/logs?stdout=1&stderr=1',
                                   response_raw=True, limit=8192, timeout=3)
        except DockerTimeout:
            return {'state': 'observation_timeout'}
        output, position = bytearray(), 0
        while position < len(raw):
            header = raw[position:position + 8]
            if len(header) != 8 or header[0] != 1 or header[1:4] != b'\0\0\0':
                return {'state': 'unknown'}
            size = int.from_bytes(header[4:8], 'big')
            position += 8
            if position + size > len(raw):
                return {'state': 'unknown'}
            output.extend(raw[position:position + size])
            position += size
        try:
            value = json.loads(output)
        except (ValueError, UnicodeError):
            return {'state': 'unknown'}
        changed = phase == 'activate'
        if state.get('ExitCode') == 0 and isinstance(value, dict) and value.get('ok') is True:
            try:
                if SOURCE_PHASE.fullmatch(phase):
                    checked_source_evidence(value, job['sources'][phase[7:]]['identity'], job['profile'])
                    return {'state': 'succeeded', 'evidence': value}
                base = {'ok': True, 'version': job['version'], 'changed': changed}
                if phase == 'prepare' and set(value) == set(base) | {'candidate'} and all(value[k] == v for k, v in base.items()):
                    checked_candidate(value['candidate'], job['release'])
                    return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                            'candidate': value['candidate']}
                if phase == 'validate' and set(value) == set(base) | {'evidence'} and all(value[k] == v for k, v in base.items()):
                    checked_evidence(value['evidence'], job['candidate'], job['release'], job['profile'])
                    return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                            'evidence': value['evidence']}
            except (ValueError, KeyError, TypeError):
                return {'state': 'unknown'}
        if (phase == 'activate' and state.get('ExitCode') == 0 and
                value == {'ok': True, 'version': job['version'], 'changed': changed}):
            return {'state': 'succeeded', 'version': job['version'], 'changed': changed}
        if (isinstance(value, dict) and set(value) == {'ok', 'stage'} and value['ok'] is False
                and value['stage'] in ('install_failed', 'candidate_changed', 'entrypoint_changed',
                                       'compatibility_probe_unavailable', 'compatibility_probe_failed') and state.get('ExitCode') == 1):
            return {'state': 'failed', 'stage': value['stage']}
        return {'state': 'unknown'}

    def quiescent(self, job):
        """Inspect all labeled helpers, including creation-before-ID-commit orphans."""
        filters = {'label': ['cn.swordfate.pi.runtime-update=' + job['id']]}
        items = self.engine.call('GET', '/containers/json?all=1&filters=' +
                                 quote(json.dumps(filters), safe=''), timeout=3, limit=1024 * 1024)
        if not isinstance(items, list) or len(items) > MAX_SOURCES + 3:
            raise RuntimeError('ambiguous runtime helpers')
        keys = {item['Id'] for item in items}
        keys.update(value['id'] for value in job.get('helpers', {}).values())
        if job.get('helper_id'):  # Pre-two-phase ledger: absence can be inspected; live legacy helper cannot.
            keys.add(job['helper_id'])
        for key in keys:
            item = self.engine.inspect(key, timeout=3)
            if item is None:
                continue  # Host acknowledgment plus confirmed absence, not installation success.
            phase = item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-phase')
            if phase not in ('prepare', 'validate', 'activate') and not (
                    isinstance(phase, str) and SOURCE_PHASE.fullmatch(phase)):
                raise RuntimeError('legacy or unrecognized helper requires host removal')
            checked = self.inspect({**job, 'helpers': {phase: {'id': key}}}, phase)
            state = (checked or {}).get('State', {})
            if state.get('Running') is not False or state.get('Status') not in ('created', 'exited', 'dead'):
                raise RuntimeError('runtime helper still active')

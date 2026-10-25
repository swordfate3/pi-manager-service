"""Closed lifecycle wire contract and trusted-container checks."""
import re
import unicodedata
from pathlib import PurePosixPath

HEX = re.compile(r'[a-f0-9]{32}\Z')
CONTAINER = re.compile(r'[a-f0-9]{64}\Z')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
STAGE = re.compile(r'[a-z_]{1,64}\Z')
IDENTITIES = ('run_id', 'runtime_id', 'session_id', 'leaf_id')
SAFE_TEXT = ('runtime_id', 'session_id', 'old_runtime_id', 'new_runtime_id',
             'old_version', 'expected_version', 'new_version')
STATES = ('pending', 'queued', 'running', 'succeeded', 'failed', 'recovery_required', 'rejected', 'stale')
OP_STATES = ('running', 'succeeded', 'failed', 'recovery_required')
OPEN = ('pending', 'queued', 'running', 'failed', 'recovery_required')
# The env-python shebang must never inherit unreviewed interpreter/import knobs.
# PYTHON is the image's build-tool hint, not a Python interpreter setting.
SAFE_PYTHON_ENV = {'PYTHON': '/usr/bin/python3', 'PYTHONUNBUFFERED': '1',
                   'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'PYTHONSAFEPATH': '1'}


def identifier(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError('invalid lifecycle identity')
    return value


def text(value, nullable=False):
    if nullable and value is None:
        return value
    if (not isinstance(value, str) or not 1 <= len(value) <= 256 or
            any(unicodedata.category(c) == 'Cc' for c in value)):
        raise ValueError('invalid lifecycle text')
    return value


def timestamp(value):
    if type(value) is not int or not 0 < value <= 2 ** 53 - 1:
        raise ValueError('invalid lifecycle timestamp')
    return value


def restart_request(value):
    if not isinstance(value, dict) or set(value) != {*IDENTITIES, 'idempotency_key'}:
        raise ValueError('invalid lifecycle request')
    identifier(value['run_id'])
    identifier(value['idempotency_key'])
    text(value['runtime_id'])
    text(value['session_id'])
    text(value['leaf_id'], nullable=True)
    return dict(value)


def control_request(value):
    if value == {'action': 'status'}:
        return
    if isinstance(value, dict) and set(value) == {'action', 'run_id', 'operation_id'} and value['action'] == 'cancel_restore':
        identifier(value['run_id'])
        identifier(value['operation_id'])
        return
    if not isinstance(value, dict):
        raise ValueError('invalid control request')
    expected = {*IDENTITIES, 'action', 'operation_id'}
    if 'restore_proof' in value:
        if value.get('action') != 'restart':
            raise ValueError('invalid restore action')
        expected.add('restore_proof')
        restore_proof(value['restore_proof'])
    if set(value) != expected or value.get('action') not in ('restart', 'prepare_restore'):
        raise ValueError('invalid control request')
    restart_request({**{k: value[k] for k in IDENTITIES}, 'idempotency_key': value['operation_id']})


def restore_proof(value):
    if not isinstance(value, dict) or set(value) != {'session_sha256', 'expected_hash', 'source_hash',
            'target_tree_sha256', 'target_task', 'version', 'profile_hash'}:
        raise ValueError('invalid restore proof')
    identifier(value['target_task'])
    for key in ('session_sha256', 'expected_hash', 'source_hash', 'target_tree_sha256', 'profile_hash'):
        if not isinstance(value[key], str) or not re.fullmatch('[0-9a-f]{64}', value[key]):
            raise ValueError('invalid restore digest')
    if not isinstance(value['version'], str) or not re.fullmatch(
            r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value['version']):
        raise ValueError('invalid restore version')


def source_identity(value, version):
    keys = {'contract', 'package', 'executable', 'version', 'node', 'tree_sha256'}
    if (not isinstance(value, dict) or set(value) != keys or value['contract'] != 'pi-runtime-source-v1' or
            value['version'] != version or not isinstance(value['tree_sha256'], str) or
            not re.fullmatch('[0-9a-f]{64}', value['tree_sha256']) or
            not isinstance(value['node'], str) or not re.fullmatch(
                r'>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value['node'])):
        raise ValueError('invalid source identity')
    for key in ('package', 'executable'):
        path = value[key]
        if (not isinstance(path, str) or not path.startswith('/home/node/.local/') or len(path) > 8192 or
                str(PurePosixPath(path)) != path or '..' in PurePosixPath(path).parts or
                any(unicodedata.category(c) == 'Cc' for c in path)):
            raise ValueError('invalid source path')
    if (not value['package'].endswith('/lib/node_modules/@earendil-works/pi-coding-agent') or
            not value['executable'].startswith(value['package'] + '/')):
        raise ValueError('invalid source package')
    return dict(value)


def public(job):
    result = {k: job[k] for k in ('id', 'run_id', 'status', 'stage')}
    identifier(result['id'])
    identifier(result['run_id'])
    if result['status'] not in STATES or not isinstance(result['stage'], str) or not STAGE.fullmatch(result['stage']):
        raise ValueError('invalid lifecycle state')
    for key in SAFE_TEXT:
        if key in job:
            result[key] = text(job[key])
    if 'leaf_id' in job:
        result['leaf_id'] = text(job['leaf_id'], nullable=True)
    if 'started_at' in job:
        result['started_at'] = timestamp(job['started_at'])
    elif job['status'] in ('running', 'succeeded'):
        raise ValueError('missing lifecycle timestamp')
    return result


def result(value):
    if not isinstance(value, dict) or value.get('ok') is not True or not isinstance(value.get('result'), dict):
        raise RuntimeError('control unavailable')
    return value['result']


def snapshot(value, run_id):
    if value.get('managed') is not True or value.get('run_id') != run_id:
        raise RuntimeError('target unavailable')
    safe = {'managed': True, 'run_id': identifier(run_id)}
    for key in ('runtime_id', 'session_id', 'version'):
        safe[key] = text(value.get(key))
    if 'leaf_id' not in value:
        raise ValueError('missing leaf identity')
    safe['leaf_id'] = text(value['leaf_id'], nullable=True)
    for key in ('idle', 'pending', 'busy'):
        if type(value.get(key)) is not bool:
            raise ValueError('invalid target state')
        safe[key] = value[key]
    if 'source_identity' in value:
        safe['source_identity'] = source_identity(value['source_identity'], safe['version'])
    return safe


def ready(value, expected):
    if (any(value[k] != expected[k] for k in IDENTITIES) or
            value['idle'] is not True or value['pending'] is not False or value['busy'] is not False):
        raise RuntimeError('target changed or busy')


def terminal_profile(item):
    config = (item or {}).get('Config', {})
    return ((config.get('Labels') or {}).get('cn.swordfate.pi.runtime-profile') == 'web-terminal-v1' or
            'PI_RUNTIME_PROFILE=web-terminal-v1' in (config.get('Env') or []))


def trusted(item, run_id, images, role='restart', *, runtime_volume='pi-runtime'):
    """Role admission is independent of the common immutable-container checks."""
    if role not in ('restart', 'terminal', 'inventory'):
        raise ValueError('invalid trust role')
    if role == 'restart' and terminal_profile(item):
        raise RuntimeError('terminal_profile_unaudited')
    trusted_container(item, run_id, images, runtime_volume=runtime_volume)
    config = item['Config']
    if role == 'terminal' or (role == 'inventory' and terminal_profile(item)):
        if (item['HostConfig'].get('LogConfig') or {}).get('Type') != 'none':
            raise RuntimeError('terminal content logging refused')
        labels = config.get('Labels') or {}
        env = config.get('Env') or []
        names = [entry.partition('=')[0] for entry in env]
        if (labels.get('cn.swordfate.pi.runtime-profile') != 'web-terminal-v1' or
                'PI_RUNTIME_PROFILE=web-terminal-v1' not in env or
                'PI_RUNTIME_RUN_ID=' + run_id not in env or len(set(names)) != len(names)):
            raise RuntimeError('untrusted terminal launch')
        for entry in env:
            name, _, value = entry.partition('=')
            if (name in ('NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV') or
                    (name == 'PATH' and value != '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')):
                raise RuntimeError('untrusted terminal loader')
    elif (config.get('Labels') or {}).get('cn.swordfate.pi.lifecycle') != '1':
        raise RuntimeError('untrusted lifecycle role')
    return item


def trusted_container(item, run_id, images, *, runtime_volume='pi-runtime'):
    """Fail closed on authority mounts or overrides of image-owned control code."""
    if not isinstance(item, dict):
        raise RuntimeError('target unavailable')
    config, host = item.get('Config', {}), item.get('HostConfig', {})
    labels = config.get('Labels') or {}
    if (not CONTAINER.fullmatch(item.get('Id', '')) or item.get('Image') not in images or
            item.get('State', {}).get('Running') is not True or
            labels.get('cn.swordfate.pi.run-id') != run_id or
            config.get('User') != '1000:1000' or config.get('Entrypoint') != ['/usr/local/bin/pi-entrypoint'] or
            host.get('Privileged') is not False or host.get('CapAdd') or
            'ALL' not in (host.get('CapDrop') or []) or
            not set(host.get('SecurityOpt') or []).intersection({'no-new-privileges', 'no-new-privileges:true'}) or
            not set(host.get('SecurityOpt') or []).issubset({'no-new-privileges', 'no-new-privileges:true'}) or
            any(host.get(k) for k in ('Devices', 'DeviceRequests', 'VolumesFrom', 'ContainerIDFile', 'GroupAdd', 'UTSMode')) or
            set(host.get('Tmpfs') or {}) - {'/tmp'} or
            host.get('PidMode') not in (None, '') or host.get('IpcMode') in ('host',) or
            str(host.get('IpcMode', '')).startswith('container:') or host.get('UsernsMode') == 'host'):
        raise RuntimeError('untrusted target')
    for env in config.get('Env') or []:
        name, _, value = env.partition('=')
        if (name.startswith('LD_') or
                (name.startswith(('PYTHON', '_PYTHON')) and SAFE_PYTHON_ENV.get(name) != value)):
            raise RuntimeError('untrusted runtime environment')
        if ((name == 'PI_RUNTIME_DIR' and value != '/run/pi-runtime') or
                (name == 'PI_RUNTIME_RUN_ID' and value != run_id)):
            raise RuntimeError('untrusted control identity')
    # Existing launcher's data mounts only; no user-selected authority mount paths.
    volumes = {'/home/node': 'pi-user-home', '/home/node/.pi': 'pi-home',
               '/home/node/.local': runtime_volume, '/home/node/.credentials': 'pi-credentials',
               '/home/node/.cache/huggingface': 'pi-huggingface-cache', '/run/pi-web-hub': 'pi-web-hub-runtime'}
    readonly = {'/run/host-ssh', '/run/cc-switch-pi-models', '/home/node/.bashrc',
                '/run/secrets/huggingface-token', '/run/secrets/pi-web-session.json'}
    for mount in item.get('Mounts') or []:
        dest, source = mount.get('Destination', ''), mount.get('Source', '')
        if (not isinstance(dest, str) or str(PurePosixPath(dest)) != dest or '..' in PurePosixPath(dest).parts or
                mount.get('Propagation', '') not in ('', 'rprivate') or mount.get('SubPath') or mount.get('Subpath')):
            raise RuntimeError('untrusted mount')
        if mount.get('Type') == 'volume':
            if (volumes.get(dest) != mount.get('Name') or not mount.get('Name') or
                    (dest == '/run/pi-web-hub' and mount.get('RW') is not False)):
                raise RuntimeError('untrusted authority volume')
        elif mount.get('Type') == 'bind':
            if (not isinstance(source, str) or not source.startswith('/') or
                    '..' in PurePosixPath(source).parts or source in ('/', '/home', '/home/fate', '/root', '/mnt', '/mnt/c') or
                    any(source == p or source.startswith(p + '/') for p in ('/etc', '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker')) or
                    any(word in source.lower() for word in ('docker.sock', 'gate-state', 'deploy-gate', 'lifecycle.token', '.codex', '/.credentials'))):
                raise RuntimeError('untrusted authority bind')
            bridge = (source == dest and
                      re.fullmatch(r'/home/[^/]+/\.vscode-server/extensions/[^/]+(?:/bridge)?', dest) and
                      mount.get('RW') is False)
            if (dest not in ('/workspace', '/workspace/.pi-attachments', '/run/cc-switch-pi-models') and
                    not (dest in readonly and mount.get('RW') is False) and not bridge):
                raise RuntimeError('untrusted mount destination')
        else:
            raise RuntimeError('untrusted mount type')
    return item

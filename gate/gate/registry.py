import copy
import hashlib
import ipaddress
import json
import posixpath
import re


MODES = ('manual', 'auto', 'disabled')
KINDS = ('hub', 'image')
HUB_REPOSITORY = 'swordfate3/pi-web-ui'
HUB_BRANCH = 'main'
MAX_MEMORY = 8 * 1024 * 1024 * 1024
MAX_NANO_CPUS = 8_000_000_000
MAX_LOG_SIZE = 256 * 1024 * 1024

_IDENTIFIER = re.compile(r'[a-z0-9][a-z0-9_.-]{0,63}\Z')
_TARGET = re.compile(r'[a-z0-9][a-z0-9_.-]{0,127}\Z')
_COMPONENT = re.compile(r'[a-z0-9]+(?:[._-][a-z0-9]+)*\Z')
_REGISTRY_HOST = re.compile(r'[a-z0-9]+(?:[.-][a-z0-9]+)*\Z')
_VOLUME = re.compile(r'[a-z0-9][a-z0-9_.-]{0,127}\Z')
_ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\Z')
_PORT_KEY = re.compile(r'([1-9][0-9]{0,4})/(tcp|udp)\Z')
_IMAGE_DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
_SECRET = re.compile(
    r'(?i)(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+'
    r'|bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----'
    r'|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'
)

_RESERVED_TARGETS = {
    'docker', 'docker.sock', 'pi-deploy-gate', 'pi-deploy-gate-state',
}


def fingerprint(value):
    """Return a stable digest for a JSON value."""
    try:
        raw = json.dumps(
            value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
            allow_nan=False,
        ).encode('ascii')
    except (TypeError, ValueError) as error:
        raise ValueError('value must be canonical JSON') from error
    return hashlib.sha256(raw).hexdigest()


def _exact(value, required, optional=()):
    if not isinstance(value, dict):
        raise TypeError('value must be an object')
    keys = set(value)
    required = set(required)
    optional = set(optional)
    if not required <= keys or keys - required - optional:
        raise ValueError('unexpected or missing fields')


def _integer(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(name + ' is outside the allowed range')
    return value


def _string(value, maximum, name, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value):
        raise ValueError(name + ' must be bounded text')
    if '\x00' in value or '\r' in value or '\n' in value:
        raise ValueError(name + ' contains a control character')
    return value


def validate_identifier(value):
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError('invalid service identifier')
    return value


def validate_target(value):
    if not isinstance(value, str) or not _TARGET.fullmatch(value):
        raise ValueError('invalid target name')
    if value in _RESERVED_TARGETS or value.startswith('pi-deploy-gate-'):
        raise ValueError('reserved target name')
    return value


def validate_repository(value):
    if not isinstance(value, str) or not 3 <= len(value) <= 255 or value != value.lower():
        raise ValueError('invalid image repository')
    if any(marker in value for marker in ('://', '@', '?', '#', '\\')):
        raise ValueError('image repository must not contain a scheme, digest or query')
    parts = value.split('/')
    if len(parts) < 2 or any(part in ('', '.', '..') for part in parts):
        raise ValueError('image repository must be an explicit path')
    first = parts[0]
    if ':' in first:
        host, port = first.rsplit(':', 1)
        if not _REGISTRY_HOST.fullmatch(host) or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError('invalid registry host or port')
    elif not _COMPONENT.fullmatch(first):
        raise ValueError('invalid repository component')
    if any(not _COMPONENT.fullmatch(part) for part in parts[1:]):
        raise ValueError('invalid repository component')
    return value


def validate_image_reference(repository, value):
    repository = validate_repository(repository)
    if not isinstance(value, str) or not value.startswith(repository + '@'):
        raise ValueError('image reference does not match registered repository')
    digest = value[len(repository) + 1:]
    if not _IMAGE_DIGEST.fullmatch(digest):
        raise ValueError('image reference must use a full lowercase sha256 digest')
    return value


def contains_secret(value):
    return isinstance(value, str) and bool(_SECRET.search(value))


def _path(value, name, allow_root=False):
    _string(value, 512, name)
    if not value.startswith('/') or '//' in value or any(part == '..' for part in value.split('/')):
        raise ValueError(name + ' must be a normalized absolute path')
    normalized = posixpath.normpath(value)
    if normalized != value or (normalized == '/' and not allow_root):
        raise ValueError(name + ' must be a normalized absolute path')
    return value


def _string_list(value, name, require_nonempty=False, maximum=128):
    if not isinstance(value, list) or len(value) > maximum or (require_nonempty and not value):
        raise ValueError(name + ' must be a bounded list')
    for item in value:
        _string(item, 4096, name + ' item')
    return copy.deepcopy(value)


def _validate_healthcheck(value):
    _exact(value, ('Test',), ('Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval'))
    test = _string_list(value['Test'], 'healthcheck test', require_nonempty=True, maximum=64)
    if test[0] not in ('CMD', 'CMD-SHELL') or len(test) < 2:
        raise ValueError('healthcheck must contain a nonempty CMD or CMD-SHELL test')
    if test[0] == 'CMD-SHELL' and len(test) != 2:
        raise ValueError('CMD-SHELL healthcheck must contain one command string')
    result = {'Test': test}
    for key in ('Interval', 'Timeout', 'StartPeriod', 'StartInterval'):
        if key in value:
            result[key] = _integer(value[key], 0, 3_600_000_000_000, key)
    if 'Retries' in value:
        result['Retries'] = _integer(value['Retries'], 1, 100, 'healthcheck retries')
    return result


def _validate_restart_policy(value):
    _exact(value, ('Name',), ('MaximumRetryCount',))
    if value['Name'] != 'unless-stopped':
        raise ValueError('restart policy must be unless-stopped')
    result = {'Name': 'unless-stopped'}
    if 'MaximumRetryCount' in value:
        result['MaximumRetryCount'] = _integer(value['MaximumRetryCount'], 0, 0, 'restart retry count')
    return result


def _validate_tmpfs(value):
    if not isinstance(value, dict) or set(value) != {'/tmp'}:
        raise ValueError('only a protected /tmp tmpfs is allowed')
    options = _string(value['/tmp'], 256, 'tmpfs options').split(',')
    if len(options) != len(set(options)) or not {'nosuid', 'nodev', 'noexec'} <= set(options):
        raise ValueError('tmpfs must disable suid, devices and execution')
    allowed = {'rw', 'nosuid', 'nodev', 'noexec', 'mode=1777'}
    for option in options:
        if option in allowed:
            continue
        match = re.fullmatch(r'size=([1-9][0-9]*)([kKmMgG])', option)
        if not match:
            raise ValueError('unsupported tmpfs option')
        scale = {'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3}[match.group(2).lower()]
        if int(match.group(1)) * scale > 1024 ** 3:
            raise ValueError('tmpfs is too large')
    return {'/tmp': value['/tmp']}


def _validate_binds(value):
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError('binds must be a bounded list')
    result = []
    destinations = set()
    for bind in value:
        _string(bind, 1024, 'bind')
        parts = bind.rsplit(':', 2)
        if len(parts) != 3 or parts[2] not in ('ro', 'rw'):
            raise ValueError('bind must contain source, destination and ro/rw mode')
        source, destination, mode = parts
        _path(destination, 'bind destination')
        if destination in destinations or destination.lower().endswith('/docker.sock'):
            raise ValueError('duplicate or reserved bind destination')
        destinations.add(destination)
        if source.startswith('/'):
            # Inspect preserves symlink aliases; it cannot prove host provenance.
            raise ValueError('absolute host binds are unsupported for image services')
        else:
            if not _VOLUME.fullmatch(source) or source in _RESERVED_TARGETS or source.startswith('pi-deploy-gate-'):
                raise ValueError('invalid or reserved named volume')
        result.append(bind)
    return result


def _validate_log_config(value):
    _exact(value, ('Type', 'Config'))
    if value['Type'] != 'json-file':
        raise ValueError('only rotated json-file logging is allowed')
    config = value['Config']
    _exact(config, ('max-size', 'max-file'))
    match = (re.fullmatch(r'([1-9][0-9]{0,3})([kKmMgG])', config['max-size'])
             if isinstance(config['max-size'], str) else None)
    if not match:
        raise ValueError('invalid log max-size')
    scale = {'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3}[match.group(2).lower()]
    if int(match.group(1)) * scale > MAX_LOG_SIZE:
        raise ValueError('log max-size exceeds 256 MiB')
    if not isinstance(config['max-file'], str) or not config['max-file'].isdigit():
        raise ValueError('invalid log max-file')
    if not 1 <= int(config['max-file']) <= 10:
        raise ValueError('log max-file is outside the allowed range')
    return copy.deepcopy(value)


def _port_key(value):
    match = _PORT_KEY.fullmatch(value) if isinstance(value, str) else None
    if not match or int(match.group(1)) > 65535:
        raise ValueError('invalid container port')
    return value


def _validate_exposed_ports(value):
    if not isinstance(value, dict) or len(value) > 64:
        raise ValueError('ExposedPorts must be a bounded object')
    result = {}
    for key, item in value.items():
        _port_key(key)
        if item != {}:
            raise ValueError('exposed port values must be empty objects')
        result[key] = {}
    return result


def _validate_port_bindings(value, exposed):
    if not isinstance(value, dict) or len(value) > 64:
        raise ValueError('PortBindings must be a bounded object')
    result = {}
    for key, bindings in value.items():
        _port_key(key)
        if key not in exposed or not isinstance(bindings, list) or not 1 <= len(bindings) <= 16:
            raise ValueError('port binding must reference an exposed port')
        normalized = []
        for binding in bindings:
            _exact(binding, ('HostIp', 'HostPort'))
            host_ip = binding['HostIp']
            if not isinstance(host_ip, str):
                raise ValueError('port binding address must be text')
            if host_ip:
                try:
                    ipaddress.ip_address(host_ip)
                except ValueError as error:
                    raise ValueError('invalid port binding address') from error
            host_port = binding['HostPort']
            if not isinstance(host_port, str) or not host_port.isdigit() or not 1 <= int(host_port) <= 65535:
                raise ValueError('invalid host port')
            normalized.append({'HostIp': host_ip, 'HostPort': host_port})
        result[key] = normalized
    return result


def _validate_host_config(value, exposed):
    required = {
        'NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Memory',
        'NanoCpus', 'PidsLimit', 'RestartPolicy', 'Tmpfs', 'Binds', 'LogConfig',
    }
    _exact(value, required, ('PortBindings',))
    network = value['NetworkMode']
    if network not in ('none', 'host', 'bridge'):
        if (not isinstance(network, str) or network.startswith('container:') or
                not _TARGET.fullmatch(network) or network in _RESERVED_TARGETS):
            raise ValueError('unsafe network mode')
    if value['ReadonlyRootfs'] is not True:
        raise ValueError('read-only root filesystem is required')
    if value['CapDrop'] != ['ALL']:
        raise ValueError('all Linux capabilities must be dropped')
    if value['SecurityOpt'] != ['no-new-privileges:true']:
        raise ValueError('no-new-privileges is required')
    result = {
        'NetworkMode': network,
        'ReadonlyRootfs': True,
        'CapDrop': ['ALL'],
        'SecurityOpt': ['no-new-privileges:true'],
        'Memory': _integer(value['Memory'], 1, MAX_MEMORY, 'memory'),
        'NanoCpus': _integer(value['NanoCpus'], 1, MAX_NANO_CPUS, 'NanoCpus'),
        'PidsLimit': _integer(value['PidsLimit'], 1, 1024, 'PidsLimit'),
        'RestartPolicy': _validate_restart_policy(value['RestartPolicy']),
        'Tmpfs': _validate_tmpfs(value['Tmpfs']),
        'Binds': _validate_binds(value['Binds']),
        'LogConfig': _validate_log_config(value['LogConfig']),
    }
    if 'PortBindings' in value:
        result['PortBindings'] = _validate_port_bindings(value['PortBindings'], exposed)
    return result


def _validate_template(value):
    required = {'User', 'Entrypoint', 'Cmd', 'Env', 'WorkingDir', 'Healthcheck', 'HostConfig'}
    _exact(value, required, ('ExposedPorts',))
    user = value['User']
    match = re.fullmatch(r'([0-9]+):([0-9]+)', user) if isinstance(user, str) else None
    if not match or int(match.group(1)) == 0 or int(match.group(2)) == 0:
        raise ValueError('container user must be a nonzero numeric uid:gid')
    env = _string_list(value['Env'], 'environment', maximum=128)
    for item in env:
        name, separator, _ = item.partition('=')
        if not separator or not _ENV_NAME.fullmatch(name):
            raise ValueError('invalid environment entry')
    exposed = _validate_exposed_ports(value.get('ExposedPorts', {}))
    result = {
        'User': user,
        'Entrypoint': _string_list(value['Entrypoint'], 'entrypoint', require_nonempty=True, maximum=64),
        'Cmd': _string_list(value['Cmd'], 'command', maximum=64),
        'Env': env,
        'WorkingDir': _path(value['WorkingDir'], 'working directory'),
        'Healthcheck': _validate_healthcheck(value['Healthcheck']),
        'HostConfig': _validate_host_config(value['HostConfig'], exposed),
    }
    if 'ExposedPorts' in value:
        result['ExposedPorts'] = exposed
    return result


def _validate_image_policy(value, target):
    _exact(value, ('target', 'template', 'probe', 'health_timeout'))
    if value['target'] != target:
        raise ValueError('policy target does not match service target')
    probe = value['probe']
    _exact(probe, ('entrypoint', 'cmd'))
    return {
        'target': target,
        'template': _validate_template(value['template']),
        'probe': {
            'entrypoint': _string_list(probe['entrypoint'], 'probe entrypoint', require_nonempty=True, maximum=64),
            'cmd': _string_list(probe['cmd'], 'probe command', maximum=64),
        },
        'health_timeout': _integer(value['health_timeout'], 1, 600, 'health timeout'),
    }


def _validate_hub_policy(value, target):
    _exact(value, ('target', 'base_image', 'private_volume', 'runtime_volume', 'health_port', 'health_timeout'),
           ('terminal_provider',))
    if 'terminal_provider' in value and value['terminal_provider'] is not True:
        raise ValueError('terminal provider opt-in must be true')
    if value['target'] != target:
        raise ValueError('policy target does not match service target')
    if not isinstance(value['base_image'], str) or not _IMAGE_DIGEST.fullmatch(value['base_image']):
        raise ValueError('Hub base image must be a full sha256 image ID')
    for key in ('private_volume', 'runtime_volume'):
        if not isinstance(value[key], str) or not _VOLUME.fullmatch(value[key]):
            raise ValueError('invalid Hub volume')
        if value[key] in _RESERVED_TARGETS or value[key].startswith('pi-deploy-gate-'):
            raise ValueError('reserved Hub volume')
        if value[key] in (
                'pi-terminal-provider-ipc', 'pi-terminal-provider-credentials'):
            raise ValueError('provider volumes cannot be exposed through writable Hub state')
    return {
        'target': target,
        'base_image': value['base_image'],
        'private_volume': value['private_volume'],
        'runtime_volume': value['runtime_volume'],
        'health_port': _integer(value['health_port'], 1, 65535, 'health port'),
        'health_timeout': _integer(value['health_timeout'], 0, 600, 'health timeout'),
        **({'terminal_provider': True} if value.get('terminal_provider') is True else {}),
    }


def validate_service(value):
    """Validate an administrator-owned service definition and normalize defaults."""
    _exact(value, ('id', 'target', 'kind', 'source', 'policy'), ('mode',))
    identifier = validate_identifier(value['id'])
    target = validate_target(value['target'])
    kind = value['kind']
    if kind not in KINDS:
        raise ValueError('unsupported service kind')
    mode = value.get('mode', 'manual')
    if mode not in MODES:
        raise ValueError('invalid approval mode')
    source = value['source']
    if kind == 'hub':
        _exact(source, ('repository', 'auto_branch'))
        if source['repository'] != HUB_REPOSITORY or source['auto_branch'] != HUB_BRANCH:
            raise ValueError('unapproved Hub source')
        normalized_source = {'repository': HUB_REPOSITORY, 'auto_branch': HUB_BRANCH}
        policy = _validate_hub_policy(value['policy'], target)
    else:
        _exact(source, ('repository',))
        normalized_source = {'repository': validate_repository(source['repository'])}
        policy = _validate_image_policy(value['policy'], target)
    return {
        'id': identifier,
        'target': target,
        'kind': kind,
        'source': normalized_source,
        'mode': mode,
        'policy': policy,
    }


def service_public(service):
    """Return the exact non-sensitive registry view exposed to request clients."""
    keys = ('id', 'target', 'kind', 'source', 'mode', 'revision', 'policy_hash', 'paused', 'failures')
    return {key: copy.deepcopy(service[key]) for key in keys}

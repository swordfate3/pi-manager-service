"""Fixed-template single-container deployments; no request-supplied Docker options."""
import copy
import re
import time
from urllib.parse import quote

from .deploy import Deployer
from .engine import DockerError
from .registry import validate_image_reference


SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


def remaining(deadline):
    budget = deadline - time.monotonic()
    if budget <= 0:
        raise DockerError('isolated validation deadline exceeded')
    return budget


def environment(values):
    result = {}
    for value in values or []:
        key, separator, content = value.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in result:
            raise ValueError('invalid or duplicate environment')
        result[key] = content
    return result


class ImageDeployer(Deployer):
    def image_config(self, image, timeout=None):
        info = self.engine.image_info(image, timeout=timeout)
        if not info or info.get('Id') != image or not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise ValueError('image full identity mismatch')
        config = info['Config']
        if (info.get('Os', 'linux') != 'linux' or config.get('Volumes') or config.get('OnBuild') or
                config.get('Shell') not in (None, [], ['/bin/sh', '-c']) or
                config.get('StopSignal') not in (None, '', 'SIGTERM', '15')):
            raise ValueError('image metadata is not approved')
        template = self.policy['template']
        if set(config.get('ExposedPorts') or {}) - set(template.get('ExposedPorts') or {}):
            raise ValueError('image introduces unapproved ports')
        approved = environment(template['Env'])
        for key, value in environment(config.get('Env')).items():
            if key not in approved and (key != 'PATH' or value != SAFE_PATH):
                raise ValueError('image introduces unapproved environment')
        return config

    def target_body(self, image, job):
        self.image_config(image)
        body = copy.deepcopy(self.policy['template'])
        body.update(Image=image, Labels={'pi.deploy-gate.job': job,
                                         'pi.deploy-gate.target': self.policy['target']})
        return body

    def prepare(self, job):
        validate_image_reference(job['snapshot']['source']['repository'], job['image'])
        self.store.update(job['id'], stage='resolving_image')
        image = self.engine.resolve_image(job['image'])
        self.image_config(image)  # Reject anonymous mounts before any container create.
        return image

    def check_target(self):
        item = self.engine.inspect(self.policy['target'])
        if (not item or not item['State']['Running'] or
                item['State'].get('Health', {}).get('Status') != 'healthy'):
            raise ValueError('target is not healthy')
        if item['Name'].lstrip('/') != self.policy['target']:
            raise ValueError('target name mismatch')
        self.check_configuration(item)
        return item

    def check_configuration(self, item, created=False):
        image_config = self.image_config(item['Image'])
        template = self.policy['template']
        config, host = item['Config'], item['HostConfig']
        if config.get('StopSignal') not in (None, '', 'SIGTERM', '15'):
            raise ValueError('target stop signal changed')
        if (template['Healthcheck']['Test'][0] == 'CMD-SHELL' and
                config.get('Shell') not in (None, [], ['/bin/sh', '-c'])):
            raise ValueError('target health shell changed')
        approved_host = template['HostConfig']
        for field in ('User', 'Entrypoint', 'Cmd', 'WorkingDir'):
            if config.get(field) != template[field]:
                raise ValueError('target command/user policy changed')
        expected_env = environment(image_config.get('Env'))
        expected_env.update(environment(template['Env']))
        if environment(config.get('Env')) != expected_env:
            raise ValueError('target environment changed')
        if config.get('Volumes') or (config.get('ExposedPorts') or {}) != template.get('ExposedPorts', {}):
            raise ValueError('target volume/port metadata changed')
        health = config.get('Healthcheck') or {}
        if health.get('Test') != template['Healthcheck']['Test'] or any(
                health.get(key, 0) != template['Healthcheck'].get(key, 0)
                for key in ('Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval')):
            raise ValueError('target health policy changed')
        for field in ('NetworkMode', 'ReadonlyRootfs', 'Memory', 'NanoCpus', 'PidsLimit', 'Tmpfs', 'LogConfig'):
            if host.get(field) != approved_host[field]:
                raise ValueError('target resource/security policy changed')
        if ([value.upper() for value in host.get('CapDrop') or []] != ['ALL'] or
                host.get('SecurityOpt') not in (['no-new-privileges'], ['no-new-privileges:true'])):
            raise ValueError('target capability policy changed')
        restart = host.get('RestartPolicy') or {}
        if restart.get('Name') != 'unless-stopped' or restart.get('MaximumRetryCount', 0) != 0:
            raise ValueError('target restart policy changed')
        forbidden = ('Privileged', 'CapAdd', 'Devices', 'DeviceRequests', 'DeviceCgroupRules',
                     'GroupAdd', 'PidMode', 'UTSMode', 'UsernsMode', 'VolumesFrom', 'Links',
                     'PublishAllPorts', 'AutoRemove', 'Mounts', 'ContainerIDFile', 'CgroupParent',
                     'Sysctls', 'ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'StorageOpt',
                     'OomKillDisable', 'Ulimits', 'Init', 'MaskedPaths', 'ReadonlyPaths')
        # Docker supplies its standard masked/readonly paths; checked separately below.
        for field in forbidden[:-2]:
            if host.get(field):
                raise ValueError('target has forbidden host options')
        if (host.get('IpcMode', 'private') != 'private' or
                host.get('CgroupnsMode', 'private') != 'private' or
                host.get('Runtime', 'runc') not in ('', 'runc')):
            raise ValueError('target namespace/runtime changed')
        if (host.get('PortBindings') or {}) != approved_host.get('PortBindings', {}):
            raise ValueError('target port bindings changed')
        self.check_host_extras(host)
        self.check_network(approved_host['NetworkMode'])
        networks = item.get('NetworkSettings', {}).get('Networks', {})
        state = item.get('State', {})
        never_started = (state.get('Status') == 'created' and state.get('Running') is False and
                         state.get('StartedAt') == '0001-01-01T00:00:00Z' and
                         item.get('RestartCount') == 0)
        if set(networks) != {approved_host['NetworkMode']} and not (created and never_started and not networks):
            raise ValueError('target has unexpected networks')
        for network in networks.values():
            if network.get('Links') or network.get('IPAMConfig') or network.get('Aliases'):
                raise ValueError('target network options changed')
        if sorted(host.get('Binds') or []) != sorted(approved_host['Binds']):
            raise ValueError('target mount requests changed')
        expected_mounts = [bind.rsplit(':', 2) for bind in approved_host['Binds']]
        mounts = item.get('Mounts') or []
        if len(mounts) != len(expected_mounts):
            raise ValueError('target has extra or missing mounts')
        for source, destination, mode in expected_mounts:
            matches = [mount for mount in mounts if mount['Destination'] == destination]
            if len(matches) != 1:
                raise ValueError('target mount destination changed')
            mount = matches[0]
            if (mount['RW'] != (mode == 'rw') or mount.get('SubPath') or mount.get('Subpath') or
                    mount.get('Propagation', '') not in ('', 'rprivate')):
                raise ValueError('target mount access changed')
            if source.startswith('/'):
                # Also reject previously saved templates, not only new registrations.
                raise ValueError('absolute host binds are unsupported for image services')
            else:
                volume = self.engine.call('GET', '/volumes/' + quote(source, safe=''), missing=True)
                if (not volume or volume.get('Name') != source or volume.get('Driver') != 'local' or
                        volume.get('Options') or volume.get('Scope', 'local') != 'local' or
                        mount['Type'] != 'volume' or mount.get('Name') != source or
                        mount.get('Driver') != 'local' or mount.get('Source') != volume.get('Mountpoint')):
                    raise ValueError('named volume is not an existing plain local volume')

    def check_host_extras(self, host):
        for field in ('MemoryReservation', 'CpuShares', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod',
                      'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems', 'OomScoreAdj', 'BlkioWeight',
                      'BlkioWeightDevice', 'BlkioDeviceReadBps', 'BlkioDeviceWriteBps',
                      'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps'):
            if host.get(field):
                raise ValueError('unapproved resource override')
        if host.get('MemorySwap', 0) not in (0, 2 * host['Memory']):
            raise ValueError('unapproved swap limit')
        readonly = {'/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'}
        # Docker versions differ in the optional masks; never accept removal of the core masks.
        if 'MaskedPaths' in host and not {'/proc/kcore', '/proc/keys', '/sys/firmware'} <= set(host['MaskedPaths'] or []):
            raise ValueError('kernel masks disabled')
        if 'ReadonlyPaths' in host and not readonly <= set(host['ReadonlyPaths'] or []):
            raise ValueError('kernel readonly paths disabled')

    def check_network(self, name, timeout=None):
        network = self.engine.call('GET', '/networks/' + quote(name, safe=''), missing=True, timeout=timeout)
        driver = {'none': 'null', 'host': 'host'}.get(name, 'bridge')
        if (not network or network.get('Name') != name or network.get('Driver') != driver or
                network.get('Scope') != 'local' or network.get('Ingress') or network.get('ConfigOnly') or
                network.get('ConfigFrom', {}).get('Network') or name.startswith('pi-deploy-gate')):
            raise ValueError('network provenance is not approved')
        options = network.get('Options') or {}
        if name == 'bridge':
            defaults = {'com.docker.network.bridge.default_bridge': 'true',
                        'com.docker.network.bridge.enable_icc': 'true',
                        'com.docker.network.bridge.enable_ip_masquerade': 'true',
                        'com.docker.network.bridge.host_binding_ipv4': '0.0.0.0',
                        'com.docker.network.bridge.name': 'docker0',
                        'com.docker.network.driver.mtu': '1500'}
            if any(defaults.get(key) != value for key, value in options.items()):
                raise ValueError('default bridge options changed')
        elif options:
            raise ValueError('network driver options are not approved')

    def check_created(self, identifier, image, job):
        item = self.engine.inspect(identifier)
        if (not item or item['Id'] != identifier or item['Image'] != image or
                item['Name'].lstrip('/') != self.policy['target'] or
                item['Config'].get('Labels', {}).get('pi.deploy-gate.job') != job['id'] or
                item['Config'].get('Labels', {}).get('pi.deploy-gate.target') != self.policy['target']):
            raise ValueError('created target identity changed')
        self.check_configuration(item, created=True)

    def check_restore(self, item, job):
        self.check_configuration(item)
        for key in ('new_id', 'recovery_candidate_id'):
            if job.get(key):
                self.check_recovery_candidate(job[key], job)

    def check_recovery_candidate(self, identifier, job):
        item = self.engine.inspect(identifier)
        if (not item or item['Id'] != identifier or
                any(job.get(key) and job[key] != identifier for key in ('new_id', 'recovery_candidate_id')) or
                item['Name'].lstrip('/') not in (self.policy['target'], job.get('recovery_name')) or
                item['Image'] != job['candidate_image'] or
                item['Config'].get('Labels', {}).get('pi.deploy-gate.job') != job['id'] or
                item['Config'].get('Labels', {}).get('pi.deploy-gate.target') != self.policy['target']):
            raise ValueError('recovery candidate identity/name changed')
        # Recovery cannot prove that a created/current object was never started.
        # Require realized membership even after a lost create response.
        self.check_configuration(item)

    def cleanup_probe(self, job, deadline=None):
        job = self.store.get(job['id'])
        evidence = {'probe_id': job.get('probe_id'), 'image': job['candidate_image']}
        if job.get('probe_cleanup_complete') == evidence:
            return  # This exact probe was conclusively removed/observed absent.
        if deadline is None:
            # One cleanup allowance per adapter, shared by finally/run recovery.
            if getattr(self, '_probe_cleanup_deadline', None) is None:
                self._probe_cleanup_deadline = time.monotonic() + 3
            deadline = self._probe_cleanup_deadline
        name = 'pi-gate-probe-' + job['id']
        named = self.engine.inspect(name, timeout=remaining(deadline))
        recorded = self.engine.inspect(job['probe_id'], timeout=remaining(deadline)) if job.get('probe_id') else None
        if not named and not recorded:
            self.store.update(job['id'], probe_cleanup_complete=evidence)
            return
        if (not named or not recorded or named['Id'] != recorded['Id'] or
                recorded['Id'] != job['probe_id'] or recorded['Name'].lstrip('/') != name or
                recorded['Image'] != job['candidate_image'] or recorded.get('Mounts') or
                recorded['Config'].get('Labels', {}).get('pi.deploy-gate.probe') != job['id']):
            raise DockerError('probe exact identity drift; manual cleanup required')
        self.engine.remove(recorded['Id'], timeout=remaining(deadline))
        self.store.update(job['id'], probe_cleanup_complete=evidence)

    def check_probe(self, container, image, job, body, deadline):
        item = self.engine.inspect(container, timeout=remaining(deadline))
        if (not item or item['Id'] != container or item['Image'] != image or
                item['Name'] != '/pi-gate-probe-' + job['id'] or item.get('Mounts') or
                item['Config'].get('Labels', {}).get('pi.deploy-gate.probe') != job['id']):
            raise DockerError('probe exact identity or mounts changed')
        config, host = item['Config'], item['HostConfig']
        for field in ('User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Healthcheck'):
            if config.get(field) != body[field]:
                raise DockerError('probe configuration changed')
        if environment(config.get('Env')) != environment(body['Env']) or config.get('Volumes'):
            raise DockerError('probe environment or volumes changed')
        for field, expected in body['HostConfig'].items():
            actual = host.get(field)
            if field == 'RestartPolicy':
                if actual.get('Name') != 'no' or actual.get('MaximumRetryCount', 0):
                    raise DockerError('probe restart policy changed')
            elif field == 'Binds':
                if actual:
                    raise DockerError('probe has mounts')
            elif field == 'SecurityOpt':
                if actual not in (['no-new-privileges'], ['no-new-privileges:true']):
                    raise DockerError('probe security policy changed')
            elif field == 'LogConfig':
                if actual.get('Type') != 'none' or actual.get('Config'):
                    raise DockerError('probe logging policy changed')
            elif actual != expected:
                raise DockerError('probe host policy changed')
        for field in ('Privileged', 'CapAdd', 'Devices', 'DeviceRequests', 'DeviceCgroupRules',
                      'GroupAdd', 'PidMode', 'UTSMode', 'UsernsMode', 'VolumesFrom', 'Links',
                      'PublishAllPorts', 'AutoRemove', 'Mounts', 'PortBindings', 'Sysctls',
                      'ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'StorageOpt', 'OomKillDisable',
                      'Ulimits', 'Init', 'CgroupParent', 'ContainerIDFile'):
            if host.get(field):
                raise DockerError('probe has forbidden host options')
        if (host.get('IpcMode', 'private') != 'private' or
                host.get('CgroupnsMode', 'private') != 'private' or
                host.get('Runtime', 'runc') not in ('', 'runc') or
                set(item.get('NetworkSettings', {}).get('Networks', {})) - {'none'}):
            raise DockerError('probe namespace changed')
        self.check_host_extras(host)
        self.check_network('none', timeout=remaining(deadline))

    def probe(self, image, job):
        identifier = job['id']
        deadline = time.monotonic() + 20
        self._probe_cleanup_deadline = None
        config = self.image_config(image, timeout=remaining(deadline))
        # Override every inherited environment name; no formal service values enter the probe.
        inherited = environment(config.get('Env'))
        env = {key: '' for key in inherited}
        env.update(PATH=SAFE_PATH, HOME='/tmp')
        body = {'Image': image, 'User': self.policy['template']['User'], 'WorkingDir': '/tmp',
                'Entrypoint': self.policy['probe']['entrypoint'], 'Cmd': self.policy['probe']['cmd'],
                'Env': [key + '=' + value for key, value in env.items()],
                'Healthcheck': {'Test': ['NONE']},
                'Labels': {'pi.deploy-gate.probe': identifier},
                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true'], 'Memory': 64 * 1024 * 1024,
                               'NanoCpus': 500000000, 'PidsLimit': 32, 'Binds': [],
                               'RestartPolicy': {'Name': 'no'},
                               'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'},
                               'LogConfig': {'Type': 'none'}}}
        self.cleanup_probe(self.store.get(identifier), deadline=deadline)
        # Commit before create: a lost response must not inherit an earlier
        # absence/removal receipt or make an unrecorded new object safe to delete.
        self.store.update(identifier, probe_id=None, probe_cleanup_complete=None)
        container = self.engine.create('pi-gate-probe-' + identifier, body, timeout=remaining(deadline))
        self.store.update(identifier, probe_id=container)
        try:
            self.check_probe(container, image, job, body, deadline)
            self.engine.start(container, timeout=remaining(deadline))
            while True:
                item = self.engine.inspect(container, timeout=remaining(deadline))
                remaining(deadline)
                if not item or item['Image'] != image:
                    raise DockerError('probe identity changed')
                if not item['State']['Running']:
                    if item['State']['ExitCode'] != 0:
                        raise DockerError('isolated validation failed')
                    return
                time.sleep(min(0.25, remaining(deadline)))
        finally:
            self.cleanup_probe(self.store.get(identifier))

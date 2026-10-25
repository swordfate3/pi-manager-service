"""Opt-in disposable Gate→Docker→real Pi→Hub launch acceptance.

Uses explicitly selected immutable images and fresh test volumes only. No API
keys, SSH, production state, project mounts or model requests are used.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'integrations/runtime-updater/gate'))
from gate.service import Gate


def command(*args, timeout=40):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


def wait_for(callback, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = callback()
        if result:
            return result
        time.sleep(.15)
    raise AssertionError('Disposable launch condition timed out')


class DisposableResources:
    """Exact test-resource journal; never discover/prune by prefix or replay creates."""
    LABEL = 'pi.launch.acceptance'
    RECONCILE_ATTEMPTS = 3

    def __init__(self, evidence, output):
        self.evidence, self.output = evidence, output
        self.namespace = evidence['namespace']
        if not re.fullmatch('[a-f0-9]{32}', self.namespace):
            raise ValueError('invalid test namespace')
        self.prefix = 'pi-launch-test-' + self.namespace
        self.resources = evidence['resources'] = []
        evidence.update(cleanup_errors=[], residual_targets=[])
        self.save()

    def save(self):
        pending = self.output.with_suffix('.tmp')
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(json.dumps(self.evidence, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, self.output)
        fd = os.open(self.output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def intent(self, kind, name, **ownership):
        if kind not in ('container', 'volume') or any(r['name'] == name for r in self.resources):
            raise ValueError('invalid or duplicate test resource')
        launch = ownership.get('launch_id')
        if launch is not None:
            if kind != 'container' or not re.fullmatch('[a-f0-9]{32}', launch) or name != 'pi-gate-launch-' + launch:
                raise ValueError('invalid test launch identity')
            if not re.fullmatch('[a-f0-9]{64}', ownership.get('policy_revision', '')):
                raise ValueError('test launch policy identity required')
            volumes = ownership.get('volumes', [])
            if len(volumes) != 6 or len(set(volumes)) != 6 or any(not v.startswith(self.prefix + '-') for v in volumes):
                raise ValueError('test launch volume namespace required')
        elif not re.fullmatch(re.escape(self.prefix) + '-[a-z_]+', name):
            raise ValueError('resource outside test namespace')
        if kind == 'container' and not re.fullmatch('sha256:[a-f0-9]{64}', ownership.get('image', '')):
            raise ValueError('immutable test image required')
        resource = dict(kind=kind, name=name, creation='uncertain', cleanup='pending', **ownership)
        self.resources.append(resource)
        self.save()  # durable before the create can reach the daemon
        return resource

    def inspect(self, resource):
        kind, name = resource['kind'], resource['name']
        try:
            raw = command('docker', kind, 'inspect', name, timeout=5)
        except subprocess.CalledProcessError as error:
            absent = ({f'Error: No such container: {name}', f'Error response from daemon: No such container: {name}'}
                      if kind == 'container' else {f'Error response from daemon: get {name}: no such volume',
                                                   f'Error: No such volume: {name}'})
            if error.returncode == 1 and (error.stderr or '').strip() in absent:
                return None
            raise RuntimeError('test resource inspection failed') from None
        items = json.loads(raw)
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            raise ValueError('invalid resource inspection')
        return items[0]

    def prove(self, resource, item):
        if resource['kind'] == 'volume':
            if (item.get('Name') != resource['name'] or item.get('Labels', {}).get(self.LABEL) != self.namespace or
                    item.get('Driver') != 'local' or item.get('Options')):
                raise ValueError('test volume ownership unproved')
            return
        key = item.get('Id', '')
        if (not re.fullmatch('[a-f0-9]{64}', key) or item.get('Name') != '/' + resource['name'] or
                item.get('Image') != resource['image'] or resource.get('id', key) != key):
            raise ValueError('test container identity unproved')
        labels = item.get('Config', {}).get('Labels') or {}
        if 'launch_id' in resource:
            names = [m.get('Name') for m in item.get('Mounts', []) if m.get('Type') == 'volume']
            if (labels.get('cn.swordfate.pi.launch-id') != resource['launch_id'] or
                    labels.get('cn.swordfate.pi.launch-policy') != resource['policy_revision'] or
                    sorted(names) != sorted(resource['volumes'])):
                raise ValueError('test launch namespace unproved')
        elif labels.get(self.LABEL) != self.namespace:
            raise ValueError('test container namespace unproved')
        resource['id'] = key

    def confirm(self, resource):
        item = self.inspect(resource)
        if item is None:
            raise RuntimeError('created test resource unavailable')
        self.prove(resource, item)
        resource['creation'] = 'acknowledged'
        self.save()
        return item

    def create_volume(self, name):
        resource = self.intent('volume', name)
        if command('docker', 'volume', 'create', '--label', self.LABEL + '=' + self.namespace, name) != name:
            raise ValueError('unexpected created volume')
        self.confirm(resource)

    def create_container(self, name, image, *args, timeout=40):
        resource = self.intent('container', name, image=image)
        key = command('docker', 'create', '--name', name, '--label', self.LABEL + '=' + self.namespace, *args,
                      timeout=timeout)
        if not re.fullmatch('[a-f0-9]{64}', key):
            raise ValueError('unexpected created container')
        resource['id'] = key
        self.save()
        self.confirm(resource)
        return key

    def _cleanup(self, resource):
        for attempt in range(self.RECONCILE_ATTEMPTS):
            try:
                item = self.inspect(resource)
            except Exception:
                if attempt + 1 == self.RECONCILE_ATTEMPTS:
                    raise
            else:
                if item is not None:
                    self.prove(resource, item)
                    self.save()  # record the proved immutable ID before remove
                    if resource['kind'] == 'container':
                        command('docker', 'rm', '-f', resource['id'], timeout=10)
                    else:
                        command('docker', 'volume', 'rm', resource['name'], timeout=10)
                    if self.inspect(resource) is not None:
                        raise RuntimeError('test resource removal unconfirmed')
                    resource['cleanup'] = 'removed'
                    return
                if resource['creation'] == 'acknowledged':
                    resource['cleanup'] = 'absent'
                    return
            if attempt + 1 < self.RECONCILE_ATTEMPTS:
                time.sleep(.15)
        # Repeated 404s cannot prove a timed-out create will never commit later.
        resource['cleanup'] = 'uncertain'

    def finish(self, gate=None, temporary=None):
        def failure(operation, target, error):
            self.evidence['cleanup_errors'].append(dict(operation=operation, target=target, error=type(error).__name__))
        if gate is not None:
            try:
                gate.close()
            except BaseException as error:
                failure('gate.close', 'test-gate', error)
        for kind in ('container', 'volume'):
            for resource in reversed(self.resources):
                if resource['kind'] != kind:
                    continue
                try:
                    self._cleanup(resource)
                except BaseException as error:
                    resource['cleanup'] = 'error'
                    failure('cleanup', resource['name'], error)
        if temporary is not None:
            try:
                temporary.cleanup()
            except BaseException as error:
                failure('temporary.cleanup', temporary.name, error)
        self.evidence['residual_targets'] = [dict(r) for r in self.resources if r['cleanup'] not in ('removed', 'absent')]
        self.evidence['cleanup'] = not self.evidence['cleanup_errors'] and not self.evidence['residual_targets']
        try:
            self.save()
        except BaseException as error:
            self.evidence['cleanup'] = False
            failure('evidence.write', str(self.output), error)
        return self.evidence['cleanup']


def main():
    if os.environ.get('PI_REAL_DOCKER_TEST') != '1':
        raise ValueError('explicit test opt-in required')
    images = {key: os.environ.get(key, '') for key in ('PI_LAUNCH_TEST_IMAGE', 'PI_LAUNCH_TEST_HUB_IMAGE')}
    if any(not re.fullmatch(r'sha256:[a-f0-9]{64}', image) for image in images.values()):
        raise ValueError('explicit immutable test images required')
    namespace = uuid.uuid4().hex
    prefix = 'pi-launch-test-' + namespace
    volumes = {key: prefix + '-' + key for key in ('home', 'runtime', 'config', 'credentials', 'cache', 'hub_runtime')}
    destinations = {'home': '/home/node', 'runtime': '/home/node/.local', 'config': '/home/node/.pi',
                    'credentials': '/home/node/.credentials', 'cache': '/home/node/.cache/huggingface',
                    'hub_runtime': '/run/pi-web-hub'}
    output = ROOT / '.tmp/launch-acceptance' / namespace
    output.mkdir(parents=True)
    evidence = {'namespace': namespace, 'images': images, 'volumes': list(volumes.values()),
                'production_touched': False, 'registered': False, 'cleanup': False}
    hub = gate = None
    resources = DisposableResources(evidence, output / 'evidence.json')
    primary_failure = False
    temporary = None
    try:
        temporary = tempfile.TemporaryDirectory(prefix='pi-launch-acceptance-')
        base = Path(temporary.name)
        for relative in ('projects/pi_projects/project-a', 'profile', 'credentials', 'hub-private', 'exports'):
            (base / relative).mkdir(parents=True, mode=0o700)
        config = base / 'hub-private/config.json'
        config.write_text(json.dumps({'port': 0, 'runtimeDir': '/run/pi-web-hub'}))
        config.chmod(0o600)
        for volume in volumes.values():
            resources.create_volume(volume)
        # Every mount is newly created in this invocation. Docker seeds the
        # image-owned runtime; the helper initializes synthetic settings.
        mounts = []
        for key, destination in destinations.items():
            mounts.extend(['--mount', f'type=volume,source={volumes[key]},target={destination}' +
                           ('' if key == 'runtime' else ',volume-nocopy')])
        seed = '''
import json,os
from pathlib import Path
agent=Path('/home/node/.pi/agent');agent.mkdir(parents=True,exist_ok=True)
(agent/'settings.json').write_text(json.dumps({'defaultProvider':'faux','defaultModel':'faux-1',
 'extensions':['/opt/pi-web-ui/e2e/fixtures/runtime-update-provider.ts','/opt/pi-web-ui/extensions/mirror-server.ts']}))
for root in ('/home/node','/run/pi-web-hub'):
 for directory,dirs,files in os.walk(root):
  os.chown(directory,1000,1000)
  for name in files:
   os.chown(os.path.join(directory,name),1000,1000,follow_symlinks=False)
os.chmod('/run/pi-web-hub',0o700)
'''
        helper = resources.create_container(prefix + '-seed', images['PI_LAUNCH_TEST_IMAGE'], '--network', 'none', '--user', '0:0',
                '--entrypoint', '/usr/bin/python3', *mounts, images['PI_LAUNCH_TEST_IMAGE'], '-c', seed, timeout=180)
        command('docker', 'start', '-a', helper, timeout=60)
        hub = resources.create_container(prefix + '-hub', images['PI_LAUNCH_TEST_HUB_IMAGE'], '--network', 'host', '--user', '1000:1000',
                      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory', '512m', '--pids-limit', '128',
                      '--mount', f'type=bind,source={base}/hub-private,target=/hub/private',
                      '--mount', f'type=bind,source={base}/exports,target=/hub/exports',
                      '--mount', f'type=volume,source={volumes["hub_runtime"]},target=/run/pi-web-hub',
                      images['PI_LAUNCH_TEST_HUB_IMAGE'])
        command('docker', 'start', hub)
        def hub_url():
            for line in command('docker', 'logs', hub).splitlines():
                try:
                    value = json.loads(line)
                    if value.get('localUrl'):
                        return value['localUrl']
                except ValueError:
                    pass
        url = wait_for(hub_url)
        policy = dict(version=1, enabled=True, root=str(base / 'projects'), root_label='gitproject',
                      default_path='pi_projects', profile_root=str(base / 'profile'),
                      credential_root=str(base / 'credentials'), pi_image=images['PI_LAUNCH_TEST_IMAGE'],
                      hub_image=images['PI_LAUNCH_TEST_HUB_IMAGE'], hub_container=hub,
                      hub_config='/hub/private/config.json', hub_export_root='/hub/exports',
                      volumes=volumes, environment={}, auxiliary_binds=[], gate_provenance={'mode': 'host'})
        gate = Gate(base / 'gate', launch_policy=policy)
        manager = gate.pi_launches
        body = dict(id=uuid.uuid4().hex, path='pi_projects/project-a', label='Disposable real Pi',
                    policy_revision=manager.configuration()['revision'],
                    workspace_revision=manager.browse('pi_projects/project-a')['revision'])
        launch = resources.intent('container', 'pi-gate-launch-' + body['id'], image=images['PI_LAUNCH_TEST_IMAGE'],
                                  launch_id=body['id'], policy_revision=body['policy_revision'], volumes=list(volumes.values()))
        manager.submit(body)
        manager.submit(body)
        def running():
            gate.tick()
            if gate.worker:
                gate.worker.join(1)
            job = manager.get(body['id'])
            if job['status'] in ('failed', 'recovery_required'):
                private = manager._get(body['id'])
                expected = manager._engine().definition(private) if private.get('run_id') else {}
                result = subprocess.run(['docker', 'inspect', 'pi-gate-launch-' + body['id']], capture_output=True, text=True)
                if result.returncode == 0:
                    item = json.loads(result.stdout)[0]
                    evidence['diagnostic_state'] = item['State']['Status']
                    evidence['diagnostic_config_mismatches'] = [key for key in ('User', 'WorkingDir', 'Entrypoint', 'Cmd', 'OpenStdin', 'Tty', 'Labels') if item['Config'].get(key) != expected.get(key)]
                    evidence['diagnostic_host_mismatches'] = [key for key, value in expected.get('HostConfig', {}).items() if key != 'Mounts' and item['HostConfig'].get(key) != value]
                    (output / 'synthetic-pi.log').write_text(command('docker', 'logs', item['Id'])[-8000:])
                raise AssertionError('Disposable launch failed: ' + job['stage'])
            return job if job['status'] == 'running' else None
        job = wait_for(running)
        resources.confirm(launch)
        evidence['job'] = job
        def registered():
            with urllib.request.urlopen(url + 'api/sessions', timeout=3) as response:
                sessions = json.load(response)['sessions']
            return sessions[0] if len(sessions) == 1 else None
        session = wait_for(registered)
        evidence['registered'] = True
        evidence['generation'] = session['generation']
        # A new client after the original management request ended still
        # reaches this independent process. No browser lifetime owns it.
        with urllib.request.urlopen(url.rstrip('/') + session['path'], timeout=5) as response:
            assert response.status == 200
        item = manager._get(body['id'])
        container = item['container_id']
        evidence['pi_container'] = container
        inspect = json.loads(command('docker', 'inspect', container))[0]
        assert inspect['State']['Running'] and inspect['Config']['User'] == '1000:1000'
        assert inspect['HostConfig']['CapDrop'] == ['ALL']
        assert len(manager.jobs()['jobs']) == 1
        # Explicitly stop this one test Pi, then exercise owned cleanup.
        command('docker', 'stop', '--time', '5', container)
        def cleaned():
            gate.tick()
            if gate.worker:
                gate.worker.join(1)
            return manager.get(body['id'])['status'] == 'exited'
        wait_for(cleaned)
        evidence['owned_exit_cleanup'] = True
    except BaseException as error:
        primary_failure = True
        evidence['primary_failure'] = type(error).__name__
        raise
    finally:
        if not resources.finish(gate, temporary) and not primary_failure:
            raise AssertionError('Disposable cleanup incomplete; inspect evidence.json')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()

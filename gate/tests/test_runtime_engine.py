"""Fixed Docker helper protocol and missing-evidence regressions."""
import copy
import json
import unittest

from gate.runtime_engine import RuntimeEngine


class DockerAPI:
    def __init__(self):
        self.items = {}
        self.calls = []
        self.next_id = 1
        self.logs = {}
        self.image_env = []

    def image_info(self, image, timeout=None):
        return {'Id': image, 'Config': {'Env': list(self.image_env)}}

    def inspect(self, key, timeout=None):
        item = self.items.get(key) or next((item for item in self.items.values() if item['Name'] == key), None)
        return copy.deepcopy(item)

    def lifecycle_volume(self, name):
        return {'Driver': 'local', 'Options': None, 'Mountpoint': '/var/lib/docker/volumes/pi-runtime/_data'}

    def call(self, method, path, value=None, **kwargs):
        self.calls.append((method, path))
        if path.startswith('/containers/create?'):
            key = format(self.next_id, '064x')
            self.next_id += 1
            self.items[key] = {'Id': key, 'Name': path.split('name=')[1], 'Image': value['Image'],
                'Config': copy.deepcopy(value), 'HostConfig': copy.deepcopy(value['HostConfig']),
                'Mounts': [{'Type': 'volume', 'Name': 'pi-runtime', 'Destination': '/home/node/.local',
                            'Source': '/var/lib/docker/volumes/pi-runtime/_data', 'RW': True}],
                'State': {'Status': 'created', 'Running': False}}
            merged = dict(e.split('=', 1) for e in self.image_env)
            merged.update(e.split('=', 1) for e in value['Env'])
            self.items[key]['Config']['Env'] = [k + '=' + v for k, v in merged.items()]
            return {'Id': key}
        if path.startswith('/containers/json?'):
            return [{'Id': key} for key in self.items]
        key = path.split('/')[2]
        if path.endswith('/start'):
            self.items[key]['State'] = {'Status': 'running', 'Running': True}
            return None
        if '/logs?' in path:
            body = json.dumps(self.logs[key]).encode()
            return b'\x01\0\0\0' + len(body).to_bytes(4, 'big') + body
        raise AssertionError((method, path))


class RuntimeEngineTest(unittest.TestCase):
    def setUp(self):
        self.docker = DockerAPI()
        self.runtime = RuntimeEngine(self.docker)
        self.job = {'id': 'b' * 32, 'version': '1.3.0',
                    'policy': {'images': ['sha256:' + 'c' * 64]}, 'helpers': {}}

    def create(self, phase):
        key = self.runtime.create(self.job, phase)
        self.job['helpers'][phase] = {'id': key}
        return key

    def test_creation_is_inert_and_start_requires_persistable_identity_and_intent(self):
        key = self.create('prepare')
        self.assertEqual(self.docker.items[key]['State']['Status'], 'created')
        with self.assertRaises(RuntimeError):
            self.runtime.start(self.job, 'prepare')
        self.job['helpers']['prepare']['intent_at'] = 9999999999999
        self.runtime.start(self.job, 'prepare')
        self.assertTrue(self.docker.items[key]['State']['Running'])

    def test_missing_persisted_helper_cannot_be_created_or_started_again(self):
        key = self.create('prepare')
        self.job['helpers']['prepare']['intent_at'] = 1
        self.docker.items.pop(key)
        calls = len(self.docker.calls)
        with self.assertRaises(RuntimeError):
            self.runtime.create(self.job, 'prepare')
        with self.assertRaises(RuntimeError):
            self.runtime.start(self.job, 'prepare')
        self.assertEqual(self.runtime.poll(self.job, 'prepare'), {'state': 'unknown'})
        self.assertEqual(len(self.docker.calls), calls)

    def test_an_unrecorded_running_named_helper_is_never_adopted_as_unstarted(self):
        key = self.runtime.create(self.job, 'prepare')
        self.docker.items[key]['State'] = {'Status': 'running', 'Running': True}
        with self.assertRaises(RuntimeError):
            self.runtime.create(self.job, 'prepare')

    def test_phase_specific_receipts_cannot_fabricate_activation_success(self):
        key = self.create('activate')
        self.job['helpers']['activate']['intent_at'] = 1
        self.docker.items[key]['State'] = {'Status': 'exited', 'Running': False, 'ExitCode': 0}
        self.docker.logs[key] = {'ok': True, 'version': '1.3.0', 'changed': False}
        self.assertEqual(self.runtime.poll(self.job, 'activate')['state'], 'unknown')
        self.docker.logs[key]['changed'] = True
        self.assertEqual(self.runtime.poll(self.job, 'activate')['state'], 'succeeded')
        self.assertEqual(self.docker.items[key]['HostConfig']['NetworkMode'], 'none')

    def test_inspection_rejects_running_orphan_and_accepts_confirmed_absence(self):
        key = self.runtime.create(self.job, 'prepare')  # crash before ledger ID publication
        self.docker.items[key]['State'] = {'Status': 'running', 'Running': True}
        with self.assertRaises(RuntimeError):
            self.runtime.quiescent(self.job)
        self.docker.items.pop(key)
        self.runtime.quiescent(self.job)

    def test_wrong_phase_label_or_container_identity_is_rejected(self):
        key = self.create('prepare')
        self.docker.items[key]['Config']['Labels']['cn.swordfate.pi.runtime-phase'] = 'activate'
        with self.assertRaises(RuntimeError):
            self.runtime.inspect(self.job, 'prepare')


if __name__ == '__main__':
    unittest.main()

"""Real filesystem, durable Store and HTTP tests; no real Docker access."""
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gate.service import Gate, start_servers


def launch_policy(base):
    for name in ('projects/pi_projects/project-a', 'private', 'credentials', 'state'):
        (base / name).mkdir(parents=True, mode=0o700, exist_ok=True)
    return dict(version=1, enabled=True, root=str(base / 'projects'), root_label='gitproject',
                default_path='pi_projects', profile_root=str(base / 'private'),
                credential_root=str(base / 'credentials'), pi_image='sha256:' + '1' * 64,
                hub_image='sha256:' + '2' * 64, hub_container='3' * 64,
                hub_config='/private/config.json', hub_export_root='/exports',
                gate_provenance={'mode': 'host'},
                volumes=dict(home='test-home', runtime='test-runtime', config='test-config',
                             credentials='test-models', cache='test-cache', hub_runtime='test-hub-runtime'),
                environment={'HTTPS_PROXY': 'http://private-proxy:8080'})


class LaunchesTest(unittest.TestCase):
    def setUp(self):
        # Keep every disposable artifact within this worktree.
        self.tmp = tempfile.TemporaryDirectory(prefix='.launch-', dir=Path(__file__).parents[2])
        self.base = Path(self.tmp.name)
        self.policy = launch_policy(self.base)
        self.gate = Gate(self.base / 'state')
        self.addCleanup(self.stop)

    def stop(self):
        self.gate.close()
        self.tmp.cleanup()

    def enable(self):
        from gate.pi_launches import PiLaunches
        self.gate.pi_launches = PiLaunches(self.gate, self.policy)
        return self.gate.pi_launches

    def request_value(self, manager, key='a' * 32, path='pi_projects/project-a'):
        return dict(id=key, path=path, label='Project A',
                    policy_revision=manager.configuration()['revision'],
                    workspace_revision=manager.browse(path)['revision'])

    def test_gate_provenance_requires_explicit_trusted_host_or_pinned_container(self):
        self.policy.pop('gate_provenance', None)
        with self.assertRaises(ValueError):
            self.enable()
        for value in ({'mode': 'host', 'source': '/untrusted'}, {'mode': 'automatic'},
                      {'mode': 'container', 'container': 'gate', 'image': 'latest'},
                      {'mode': 'container', 'container': '4' * 64}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.policy['gate_provenance'] = value
                self.enable()
        for value in ({'mode': 'host'}, {'mode': 'container', 'container': '4' * 64,
                                       'image': 'sha256:' + '5' * 64}):
            with self.subTest(value=value):
                self.policy['gate_provenance'] = value
                self.assertTrue(self.enable().configuration()['enabled'])

    def test_default_disabled_and_no_browse_or_submit(self):
        self.assertTrue(hasattr(self.gate, 'pi_launches'), 'Gate launch capability is missing')
        m = self.gate.pi_launches
        self.assertEqual(m.configuration()['enabled'], False)
        self.assertEqual(m.configuration()['defaultPath'], 'pi_projects')
        self.assertRegex(m.configuration()['revision'], '^[a-f0-9]{64}$')
        for operation in (lambda: m.browse(), lambda: m.submit({})):
            with self.assertRaises((ValueError, RuntimeError)):
                operation()

    def test_browse_only_directories_and_nofollow_all_components(self):
        m = self.enable()
        project = self.base / 'projects/pi_projects'
        (project / 'file').touch()
        (project / 'link').symlink_to(project / 'project-a', target_is_directory=True)
        result = m.browse('pi_projects')
        self.assertEqual(result['path'], 'pi_projects')
        self.assertEqual(result['parent'], '')
        self.assertEqual(result['entries'], [{'name': 'project-a', 'path': 'pi_projects/project-a'}])
        self.assertIsNone(m.browse()['parent'])
        for path in ('../outside', '/tmp', str(self.base / 'projects-other'), 'pi_projects//project-a',
                     'pi_projects/../private', 'pi_projects/link', 'pi_projects/link/child',
                     'pi_projects/file', 'pi_projects\\project-a', 'pi_projects/', '.', 'x\x00'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                m.browse(path)

    def test_pagination_and_scan_bound(self):
        m = self.enable()
        root = self.base / 'projects/pi_projects'
        for n in range(205):
            (root / f'd{n:04}').mkdir()
        first = m.browse('pi_projects')
        self.assertEqual(len(first['entries']), 200)
        self.assertTrue(first['truncated'])
        second = m.browse('pi_projects', first['nextCursor'])
        self.assertEqual(len(second['entries']), 6)
        self.assertFalse(second['truncated'])
        for n in range(4100):
            (root / f'f{n:04}').touch()
        with self.assertRaisesRegex(RuntimeError, 'workspace directory exceeds browse limit'):
            m.browse('pi_projects')

    def test_many_files_never_returns_empty_truncated_or_nonadvancing_page(self):
        m = self.enable()
        root = self.base / 'projects/files-only'
        root.mkdir()
        for n in range(4100):
            (root / f'f{n:04}').touch()
        for cursor in (None, 'zzzz'):
            with self.subTest(cursor=cursor), self.assertRaisesRegex(RuntimeError, 'workspace directory exceeds browse limit'):
                m.browse('files-only', cursor)

    def test_durable_idempotency_conflict_and_no_side_effect_during_submit(self):
        m = self.enable()
        value = self.request_value(m)
        first = m.submit(value)
        self.assertEqual(first['status'], 'queued')
        self.assertEqual(m.submit(value), first)
        self.assertIsNone(self.gate.worker)
        self.assertEqual(list((self.base / 'credentials').iterdir()), [])
        self.assertEqual(set(first), {'id', 'path', 'label', 'status', 'stage', 'created_at', 'updated_at'})
        with self.assertRaises(RuntimeError):
            m.submit({**value, 'label': 'different'})
        self.gate.close()
        self.gate = Gate(self.base / 'state', launch_policy=self.policy)
        self.assertEqual(self.gate.pi_launches.get(first['id']), first)
        self.assertEqual(self.gate.pi_launches.jobs(), {'jobs': [first]})

    def test_repeated_running_observations_preserve_transition_time_beyond_one_minute(self):
        m = self.enable()
        with patch('gate.pi_launches.time.time', return_value=1000):
            job = m.submit(self.request_value(m))
        with patch('gate.pi_launches.time.time', return_value=1001):
            m._update(job['id'], status='running', stage='running', container_id='c' * 64)
        observed = {'Id': 'c' * 64, 'State': {'Running': True, 'Status': 'running'}}
        engine = SimpleNamespace(observe=lambda _: observed)
        with patch.object(m, '_engine', return_value=engine):
            for now in range(1006, 1072, 5):
                with patch('gate.pi_launches.time.time', return_value=now):
                    m._poll(m._get(job['id']))
                self.assertEqual(m.get(job['id'])['updated_at'], 1001000)
        self.assertGreater(1071000 - m.get(job['id'])['updated_at'], 60000)
        with patch('gate.pi_launches.time.time', return_value=1072):
            m._update(job['id'], status='recovery_required')
        self.assertEqual(m.get(job['id'])['updated_at'], 1072000)
        with patch.object(m, '_engine', return_value=engine), patch('gate.pi_launches.time.time', return_value=1080):
            m._poll(m._get(job['id']))
        self.assertEqual(m.get(job['id'])['updated_at'], 1080000)
        self.assertEqual(m.get(job['id'])['status'], 'running')
        self.gate.close()
        self.gate = Gate(self.base / 'state', launch_policy=self.policy)
        self.assertEqual(self.gate.pi_launches.get(job['id'])['updated_at'], 1080000)

    def test_changed_directory_or_policy_revision_refused(self):
        m = self.enable()
        value = self.request_value(m)
        path = self.base / 'projects/pi_projects/project-a'
        path.rename(path.with_name('old'))
        path.mkdir()
        with self.assertRaises(RuntimeError):
            m.submit(value)
        value = self.request_value(m)
        with self.assertRaises(RuntimeError):
            m.submit({**value, 'policy_revision': 'f' * 64})

    def test_strict_payload_and_quotas(self):
        m = self.enable()
        value = self.request_value(m)
        for changed in ({'extra': 1}, {'id': 'A' * 32}, {'label': ' x '}, {'label': 'x\n'},
                        {'label': 'x' * 81}, {'workspace_revision': 'x'}, {'path': '../outside'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                m.submit({**value, **changed})
        for n in range(16):
            m.submit({**value, 'id': f'{n:032x}'})
        with self.assertRaises(RuntimeError):
            m.submit(value)
        self.assertEqual(len(m.active()), 16)

    def test_policy_rejects_authority_overlap_mutable_images_and_injection(self):
        from gate.pi_launches import PiLaunches
        for change in ({'credential_root': self.policy['root']}, {'profile_root': str(self.base)},
                       {'pi_image': 'pi:latest'}, {'default_path': ''}, {'command': ['sh']},
                       {'environment': {'NODE_OPTIONS': '--require=/workspace/x'}},
                       {'volumes': {**self.policy['volumes'], 'config': 'test-hub-runtime'}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                PiLaunches(self.gate, {**self.policy, **change})
        linked = self.base / 'linked'
        linked.symlink_to(self.base / 'credentials')
        with self.assertRaises(ValueError):
            PiLaunches(self.gate, {**self.policy, 'credential_root': str(linked)})

    def test_missing_default_is_not_created_or_replaced(self):
        m = self.enable()
        root = self.base / 'projects/pi_projects'
        root.rename(root.with_name('gone'))
        self.assertEqual(m.configuration()['defaultPath'], 'pi_projects')
        with self.assertRaises(ValueError):
            m.browse('pi_projects')
        self.assertFalse(root.exists())

    def test_private_policy_file_permission_and_changed_profile(self):
        from gate.pi_launches import PiLaunches
        path = self.base / 'private/launch.json'
        path.write_text(json.dumps(self.policy))
        path.chmod(0o600)
        m = PiLaunches(self.gate, path)
        value = self.request_value(m)
        changed = {**self.policy, 'environment': {'NO_PROXY': 'new-value'}}
        path.write_text(json.dumps(changed))
        with self.assertRaises(RuntimeError):
            m.submit(value)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            PiLaunches(self.gate, path)

    def test_optional_model_directory_is_private_fixed_readonly_and_revision_bound(self):
        from gate.pi_launches import PiLaunches
        source = self.base / 'model-config'
        source.mkdir()
        bind = {'source': str(source), 'target': '/run/cc-switch-pi-models', 'read_only': True}
        policy = {**self.policy, 'auxiliary_binds': [bind]}
        m = PiLaunches(self.gate, policy)
        self.assertTrue(m.configuration()['enabled'])
        for altered in ({'target': '/var/run/docker.sock'}, {'target': '/workspace'}, {'read_only': False},
                        {'source': self.policy['root']}, {'source': self.policy['profile_root']},
                        {'source': '/etc'}, {'extra': 'forbidden'}):
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                PiLaunches(self.gate, {**policy, 'auxiliary_binds': [{**bind, **altered}]})
        with self.assertRaises(ValueError):
            PiLaunches(self.gate, {**policy, 'auxiliary_binds': [bind, bind]})
        for changed in ({**self.policy, 'environment': {'PI_CC_SWITCH_MODELS_DIR': '/run/cc-switch-pi-models'}},
                        {**policy, 'environment': {'PI_CC_SWITCH_MODELS_DIR': '/workspace'}}):
            with self.assertRaises(ValueError):
                PiLaunches(self.gate, changed)
        value = self.request_value(m)
        source.rename(source.with_name('old-model-config'))
        source.mkdir()
        with self.assertRaises(RuntimeError):
            m.submit(value)

    def test_retained_quota_never_evicts(self):
        m = self.enable()
        value = self.request_value(m)
        for n in range(256):
            job = m.submit({**value, 'id': f'{n:032x}'})
            m._update(job['id'], status='failed')
        with self.assertRaises(RuntimeError):
            m.submit(value)
        self.assertEqual(len(m.jobs()['jobs']), 256)
        self.assertEqual(m.get('0' * 32)['status'], 'failed')

    def test_existing_work_and_upgrade_fence_launch_admission(self):
        m = self.enable()
        value = self.request_value(m)
        self.gate.submit({'commit': '1' * 40})
        with self.assertRaises(RuntimeError):
            m.submit(value)
        for job in self.gate.store.list():
            self.gate.store.update(job['id'], status='rejected')
        self.gate.reserve_upgrade('sha256:' + 'f' * 64)
        with self.assertRaises(RuntimeError):
            m.submit(value)

    def test_directory_scan_never_consumes_more_than_4096_entries(self):
        m = self.enable()
        consumed = []
        original = os.scandir
        root = self.base / 'projects/pi_projects'

        class Entries:
            def __enter__(self):
                self.iterator = original(root)
                self.entry = next(self.iterator)
                return self

            def __exit__(self, *_):
                self.iterator.close()

            def __iter__(self):
                return self

            def __next__(self):
                consumed.append(1)
                return self.entry

        with patch('gate.pi_launches.os.scandir', return_value=Entries()):
            with self.assertRaisesRegex(RuntimeError, 'workspace directory exceeds browse limit'):
                m.browse('pi_projects')
        self.assertEqual(len(consumed), 4096)

    def test_http_auth_routes_query_and_response_projection(self):
        m = self.enable()
        http, admin = start_servers(self.gate, 0)
        try:
            def call(path, method='GET', value=None, token=None):
                connection = HTTPConnection(*http.server_address)
                connection.request(method, '/v1/hub-management/' + path,
                                   json.dumps(value) if value is not None else None,
                                   {'Authorization': 'Bearer ' + (token or self.gate.hub_management_token),
                                    'Content-Type': 'application/json'})
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            value = self.request_value(m)
            for token in (self.gate.token, self.gate.lifecycle_token):
                self.assertEqual(call('workspaces?path=pi_projects', token=token)[0], 401)
                self.assertEqual(call('launches', 'POST', value, token)[0], 401)
            self.assertEqual(call('launch-config')[0], 200)
            self.assertEqual(call('workspaces?path=pi_projects')[1]['parent'], '')
            self.assertEqual(call('launches', 'POST', value)[0], 202)
            self.assertEqual(call('launches/' + value['id'])[1]['status'], 'queued')
            self.assertEqual(len(call('launches')[1]['jobs']), 1)
            for query in ('path=a&path=b', 'extra=1', 'cursor=a&cursor=b', 'path=%FF', 'path=%2Ftmp'):
                self.assertEqual(call('workspaces?' + query)[0], 400, query)
            for path in ('launches?x=1', 'launch-config?x=1', 'launches/%61' + 'a' * 31):
                self.assertEqual(call(path)[0], 400, path)
            self.assertEqual(call('workspaces', 'POST', {})[0], 405)
            self.assertNotIn('private-proxy', json.dumps(call('launch-config')))
        finally:
            for server in (http, admin):
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()

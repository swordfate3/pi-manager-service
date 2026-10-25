import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
import subprocess
from unittest import mock

from gate.deploy import Deployer
from gate.service import Gate, Handler, start_servers
from test_registry import image_service

SHA = '1' * 40
POLICY = {'target': 'pi-web-hub', 'base_image': 'sha256:' + 'a' * 64,
          'private_volume': 'pi-web-hub-private', 'runtime_volume': 'pi-web-hub-runtime',
          'health_port': 16181, 'health_timeout': 40}


class ControlledDeployer:
    def __init__(self):
        self.store = None
        self.called = []
        self.hold = threading.Event()
        self.hold.set()
        self.started = threading.Event()

    def run(self, job):
        self.called.append(job['id'])
        self.started.set()
        self.hold.wait(3)
        self.store.update(job['id'], status='deployed', stage='complete')


class BoundaryEngine:
    def inspect(self, _target):
        return None


class BoundaryDeployer(Deployer):
    """Exercise the real shared lifecycle without artifact or Docker I/O."""

    def __init__(self, store, before_cutover, invalidate):
        super().__init__(store, BoundaryEngine(), POLICY, before_cutover=before_cutover)
        self.invalidate = invalidate
        self.cleaned = False
        self.restored = False

    def check_target(self):
        return {'Id': 'old-target', 'Image': 'old-image'}

    def prepare(self, _job):
        return 'candidate-image'

    def probe(self, _image, _job):
        self.invalidate()

    def cleanup_probe(self, _job):
        self.cleaned = True

    def restore(self, job):
        self.restored = True
        self.store.update(job['id'], status='recovery_required', stage='manual_recovery_required')


class MultiServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.worker = ControlledDeployer()
        self.gate = Gate(Path(self.tmp.name), self.worker, policy=POLICY,
                         head_resolver=lambda source: SHA)
        self.worker.store = self.gate.store
        self.http, self.admin = start_servers(self.gate, port=0)
        self.addCleanup(self.stop)

    def stop(self):
        self.worker.hold.set()
        self.http.shutdown()
        self.admin.shutdown()
        self.http.server_close()
        self.admin.server_close()
        self.gate.close()
        self.tmp.cleanup()

    def request(self, method, path, value=None, admin=False):
        if admin:
            conn = http.client.HTTPConnection('localhost', timeout=3)
            conn.sock = socket.socket(socket.AF_UNIX)
            conn.sock.connect(str(Path(self.tmp.name) / 'admin.sock'))
        else:
            conn = http.client.HTTPConnection('127.0.0.1', self.http.server_address[1], timeout=3)
        conn.request(method, path, json.dumps(value) if value is not None else None,
                     {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.gate.token})
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def finish(self):
        if self.gate.worker:
            self.gate.worker.join(3)

    def test_legacy_request_maps_to_hub_and_auto_deploys_only_after_explicit_request(self):
        self.assertEqual(self.worker.called, [])
        code, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(code, 201)
        self.assertEqual(job['service'], 'pi-web-hub')
        self.assertEqual(job['status'], 'queued')
        self.gate.tick()
        self.finish()
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'deployed')

    def test_manual_mode_requires_matching_plan_digest(self):
        self.gate.store.set_mode('pi-web-hub', 'manual')
        _, job = self.request('POST', '/v1/requests', {'service': 'pi-web-hub', 'commit': SHA})
        self.gate.tick()
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.request('POST', '/admin/approve', {
            'id': job['id'], 'plan': '0' * 64}, admin=True)[0], 409)
        self.assertEqual(self.request('POST', '/admin/approve', {
            'id': job['id'], 'plan': job['plan_hash']}, admin=True)[0], 202)
        self.finish()
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'deployed')

    def test_disabled_and_policy_changes_prevent_queued_deployment(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(self.request('POST', '/admin/policy', {
            'service': 'pi-web-hub', 'mode': 'disabled'}, admin=True)[0], 200)
        self.gate.tick()
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.request('POST', '/v1/requests', {'commit': SHA})[0], 409)
        self.assertIn(self.gate.store.get(job['id'])['status'], ('stale', 'canceled'))

    def test_switching_to_auto_does_not_approve_old_pending_jobs(self):
        self.gate.store.set_mode('pi-web-hub', 'manual')
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.gate.store.set_mode('pi-web-hub', 'auto')
        self.gate.tick()
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'pending')

    def test_source_failure_and_non_head_commit_remain_manual(self):
        _, other = self.request('POST', '/v1/requests', {'commit': '2' * 40})
        self.assertEqual(other['status'], 'pending')
        def unavailable(source):
            raise OSError('offline')
        self.gate.head_resolver = unavailable
        _, offline = self.request('POST', '/v1/requests', {'commit': '3' * 40})
        self.assertEqual(offline['status'], 'pending')
        self.gate.tick()
        self.assertEqual(self.worker.called, [])

    def test_changed_branch_before_execution_stops_auto_job(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.gate.head_resolver = lambda source: '2' * 40
        self.gate.tick()
        self.finish()
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'stale')

    def test_public_client_cannot_set_policy_register_or_approve(self):
        for path, body in (
            ('/admin/policy', {'service': 'pi-web-hub', 'mode': 'auto'}),
            ('/admin/register', {'service': 'evil'}),
            ('/admin/approve', {'id': 'a' * 32, 'plan': 'b' * 64}),
        ):
            self.assertEqual(self.request('POST', path, body)[0], 404)
        for body in ({'commit': SHA, 'auto': True}, {'commit': SHA, 'target': 'pi-deploy-gate'}):
            self.assertEqual(self.request('POST', '/v1/requests', body)[0], 400)

    def test_service_list_does_not_expose_runtime_templates(self):
        code, value = self.request('GET', '/v1/services')
        self.assertEqual(code, 200)
        self.assertEqual(value['services'][0]['mode'], 'auto')
        self.assertNotIn('private_volume', json.dumps(value))
        self.assertNotIn('base_image', json.dumps(value))

    def test_admin_status_omits_private_snapshot(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        code, detail = self.request('GET', '/admin/requests/' + job['id'], admin=True)
        self.assertEqual(code, 200)
        self.assertNotIn('snapshot', detail)
        self.assertNotIn('base_image', json.dumps(detail))
        self.assertEqual(detail['plan_hash'], job['plan_hash'])

    def test_private_admin_cli_changes_policy_and_lists_services(self):
        command = ['/usr/bin/python3', '-m', 'gate.admin', '--state', self.tmp.name]
        result = subprocess.run(command + ['policy', '--json-stdin'], input=json.dumps({
            'service': 'pi-web-hub', 'mode': 'manual'}), text=True, capture_output=True,
            cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['mode'], 'manual')
        self.assertEqual(self.gate.store.service('pi-web-hub')['mode'], 'manual')

    def test_cutover_rechecks_source_and_policy(self):
        _, public_job = self.request('POST', '/v1/requests', {'commit': SHA})
        job = self.gate.store.get(public_job['id'])
        self.gate.verify_execution(job, cutover=True)
        self.assertEqual(self.gate.store.get(job['id'])['stage'], 'cutover_authorized')
        self.gate.store.set_mode('pi-web-hub', 'disabled')
        with self.assertRaises(RuntimeError) as caught:
            self.gate.verify_execution(job, cutover=True)
        self.assertEqual(type(caught.exception).__name__, 'PreconditionChanged')

    def test_cutover_precondition_change_is_stale_without_automatic_failure(self):
        deployer = BoundaryDeployer(
            self.gate.store,
            self.gate.verify_execution,
            lambda: self.gate.store.set_mode('pi-web-hub', 'manual'),
        )
        self.gate.deployer = deployer
        job = self.gate.submit({'commit': SHA})

        self.gate.tick()
        self.finish()

        stored = self.gate.store.get(job['id'])
        service = self.gate.store.service('pi-web-hub')
        self.assertEqual(stored['status'], 'stale')
        self.assertEqual(stored['stage'], 'cutover_precondition_changed')
        self.assertTrue(deployer.cleaned)
        self.assertEqual(service['failures'], 0)
        self.assertFalse(service['paused'])

    def test_cutover_precondition_change_after_recorded_destruction_uses_recovery(self):
        deployer = None

        def invalidate():
            self.gate.store.update(job['id'], old_id='old-target')
            self.gate.store.set_mode('pi-web-hub', 'manual')

        deployer = BoundaryDeployer(self.gate.store, self.gate.verify_execution, invalidate)
        self.gate.deployer = deployer
        job = self.gate.submit({'commit': SHA})

        self.gate.tick()
        self.finish()

        self.assertTrue(deployer.restored)
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'recovery_required')
        self.assertEqual(self.gate.store.service('pi-web-hub')['failures'], 1)

    def test_snapshot_hub_approval_and_rollback_require_plan_not_commit(self):
        self.gate.store.set_mode('pi-web-hub', 'manual')
        pending = self.gate.store.request_version('pi-web-hub', {'commit': SHA})
        with self.assertRaisesRegex(RuntimeError, 'plan'):
            self.gate.approve(pending['id'], commit=SHA)

        deployed = self.gate.store.request_version('pi-web-hub', {'commit': '2' * 40})
        self.gate.store.update(deployed['id'], status='deployed', old_id='old', new_id='new')
        with self.assertRaisesRegex(RuntimeError, 'plan'):
            self.gate.rollback(deployed['id'], commit=deployed['commit'])

    def test_disabled_service_cannot_approve_legacy_pending_request(self):
        legacy = self.gate.store.request(SHA)
        self.gate.store.set_mode('pi-web-hub', 'disabled')
        code, _ = self.request('POST', '/admin/approve', {
            'id': legacy['id'], 'commit': SHA}, admin=True)
        self.assertEqual(code, 409)
        self.assertEqual(self.worker.called, [])

    def test_admin_status_includes_recovery_outside_recent_hundred(self):
        oldest = self.gate.store.request('a' * 40)
        self.gate.store.update(oldest['id'], status='recovery_required')
        for number in range(101):
            job = self.gate.store.request('%040x' % (number + 10))
            self.gate.store.update(job['id'], status='rejected')
        code, value = self.request('GET', '/admin/requests', admin=True)
        self.assertEqual(code, 200)
        self.assertEqual(len(value['requests']), 100)
        self.assertEqual([job['id'] for job in value['active']], [oldest['id']])

    def test_unrelated_recovery_blocks_rollback(self):
        old = self.gate.store.request('a' * 40)
        self.gate.store.update(old['id'], status='deployed', old_id='a' * 64)
        recovery = self.gate.store.request('b' * 40)
        self.gate.store.update(recovery['id'], status='recovery_required')
        with self.assertRaisesRegex(RuntimeError, 'another recovery'):
            self.gate.rollback(old['id'], commit=old['commit'])

    def test_admin_registered_image_service_supports_manual_then_auto(self):
        definition = image_service(identifier='example-api', target='example-api')
        code, service = self.request('POST', '/admin/register', definition, admin=True)
        self.assertEqual(code, 200)
        self.assertEqual(service['mode'], 'manual')
        version = 'ghcr.io/acme/widget@sha256:' + 'a' * 64
        code, pending = self.request('POST', '/v1/requests', {'service': 'example-api', 'image': version})
        self.assertEqual(code, 201)
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(self.request('POST', '/admin/approve', {
            'id': pending['id'], 'plan': pending['plan_hash']}, admin=True)[0], 202)
        self.finish()
        self.request('POST', '/admin/policy', {'service': 'example-api', 'mode': 'auto'}, admin=True)
        _, automatic = self.request('POST', '/v1/requests', {'service': 'example-api', 'image': version})
        self.assertEqual(automatic['status'], 'queued')
        self.gate.tick()
        self.finish()
        self.assertEqual(self.gate.store.get(automatic['id'])['status'], 'deployed')
        self.assertEqual(self.request('POST', '/v1/requests', {'service': 'example-api',
            'image': 'ghcr.io/evil/widget@sha256:' + 'a' * 64})[0], 400)

    def test_onboarding_is_only_intent_and_admin_can_reject(self):
        proposal = {'service': 'example-api', 'target': 'example-api',
                    'repository': 'ghcr.io/acme/widget', 'description': 'Please register this service'}
        code, intent = self.request('POST', '/v1/intents', proposal)
        self.assertEqual(code, 201)
        self.assertEqual(intent['status'], 'pending')
        self.assertEqual(self.request('GET', '/admin/intents')[0], 404)
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.request('POST', '/admin/reject-intent', {'id': intent['id']}, admin=True)[0], 200)
        self.assertEqual(self.gate.store.intents()[0]['status'], 'rejected')

    def test_pre_cutover_resolution_requires_exact_target_and_keeps_objects(self):
        job = self.gate.store.request(SHA)
        self.gate.store.update(job['id'], status='recovery_required', baseline_id='a' * 64)
        self.worker.check_target_for = lambda job: {'Id': 'a' * 64}
        self.assertEqual(self.request('POST', '/admin/resolve', {
            'id': job['id'], 'target_id': 'b' * 64}, admin=True)[0], 409)
        self.assertEqual(self.request('POST', '/admin/resolve', {
            'id': job['id'], 'target_id': 'a' * 64}, admin=True)[0], 200)
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'failed')
        self.assertEqual(self.worker.called, [])

    def test_pre_cutover_resolution_rejects_missing_stored_baseline(self):
        job = self.gate.store.request(SHA)
        self.gate.store.update(job['id'], status='recovery_required')
        self.worker.check_target_for = lambda _job: {'Id': 'a' * 64}

        code, _ = self.request('POST', '/admin/resolve', {
            'id': job['id'], 'target_id': 'a' * 64}, admin=True)

        self.assertEqual(code, 409)
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'recovery_required')

    def test_resolve_checks_target_without_lock_and_revalidates_job(self):
        job = self.gate.store.request(SHA)
        captured = self.gate.store.update(
            job['id'], status='recovery_required', baseline_id='a' * 64)
        observed = []

        def check_target(_job):
            observed.append(self.gate.store.lock._is_owned())
            self.gate.store.update(captured['id'], stage='changed_during_target_check')
            return {'Id': 'a' * 64}

        self.worker.check_target_for = check_target
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.gate.resolve(job['id'], 'a' * 64)
        self.assertEqual(observed, [False])
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'recovery_required')

    def test_rollback_checks_target_without_lock_and_revalidates_job(self):
        job = self.gate.store.request(SHA)
        captured = self.gate.store.update(
            job['id'], status='deployed', old_id='old', new_id='new')
        observed = []

        class Engine:
            def inspect(inner_self, _target):
                observed.append(self.gate.store.lock._is_owned())
                self.gate.store.update(captured['id'], stage='changed_during_target_check')
                return {'Id': 'new'}

        self.worker.engine = Engine()
        self.worker.policy = POLICY
        self.worker.restore = lambda current: self.gate.store.update(
            current['id'], status='rolled_back', stage='test_restore')

        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.gate.rollback(job['id'], commit=SHA)
        self.assertEqual(observed, [False])
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'deployed')

    def test_registration_reads_and_replies_without_store_lock(self):
        observations = []
        original_body = Handler.body
        original_reply = Handler.reply

        def body(handler):
            observations.append(('body', handler.server.gate.store.lock._is_owned()))
            return original_body(handler)

        def reply(handler, status, value):
            observations.append(('reply', handler.server.gate.store.lock._is_owned()))
            return original_reply(handler, status, value)

        definition = image_service(identifier='lock-api', target='lock-api')
        with mock.patch.object(Handler, 'body', body), mock.patch.object(Handler, 'reply', reply):
            code, _ = self.request('POST', '/admin/register', definition, admin=True)

        self.assertEqual(code, 200)
        self.assertEqual(observations, [('body', False), ('reply', False)])

    def test_global_queue_serializes_two_distinct_queued_jobs(self):
        definition = image_service(identifier='queue-api', target='queue-api')
        self.gate.store.register_service(definition)
        self.gate.store.set_mode('queue-api', 'auto')
        first = self.gate.submit({'service': 'queue-api',
            'image': 'ghcr.io/acme/widget@sha256:' + 'a' * 64})
        second = self.gate.submit({'service': 'queue-api',
            'image': 'ghcr.io/acme/widget@sha256:' + 'b' * 64})
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual((first['status'], second['status']), ('queued', 'queued'))

        self.worker.hold.clear()
        self.gate.tick()
        self.assertTrue(self.worker.started.wait(1))
        self.gate.tick()
        self.assertEqual(self.worker.called, [first['id']])
        self.assertEqual(self.gate.store.get(second['id'])['status'], 'queued')

        self.worker.hold.set()
        self.finish()
        self.worker.started.clear()
        self.gate.tick()
        self.assertTrue(self.worker.started.wait(1))
        self.finish()
        self.assertEqual(self.worker.called, [first['id'], second['id']])

    def test_admin_services_and_events_are_redacted_and_failures_are_generic(self):
        definition = image_service(identifier='private-api', target='private-api')
        definition['policy']['template']['Env'] = ['PASSWORD=private-but-admin-owned']
        self.gate.store.register_service(definition)
        self.gate.store.audit('inspection', 'private-api', result='accepted')

        for path in ('/admin/services', '/admin/events'):
            with self.subTest(path=path):
                code, value = self.request('GET', path, admin=True)
                rendered = json.dumps(value)
                self.assertEqual(code, 200)
                self.assertNotIn('private-but-admin-owned', rendered)
                self.assertNotIn('request.token', rendered)

        for name, path in (('services', '/admin/services'), ('events', '/admin/events')):
            original = getattr(self.gate.store, name)
            setattr(self.gate.store, name, lambda: (_ for _ in ()).throw(
                RuntimeError('token=do-not-leak')))
            try:
                code, value = self.request('GET', path, admin=True)
            finally:
                setattr(self.gate.store, name, original)
            rendered = json.dumps(value)
            self.assertEqual(code, 409)
            self.assertNotIn('do-not-leak', rendered)


if __name__ == '__main__':
    unittest.main()

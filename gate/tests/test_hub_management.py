"""Restricted Hub protocol against real HTTP/SQLite and temporary state only."""
import concurrent.futures
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import runpy
import secrets
import socket
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from gate.service import Gate, start_servers
from gate.runtime_catalog import RuntimeCatalog
from test_multiservice import POLICY
from test_registry import image_service
from test_runtime_catalog import release
from test_runtime_updates import DockerBoundary, InstallBoundary, IMAGE

ROOT = '/v1/hub-management'
SHA = '1' * 40


class DeploymentBoundary:
    """Only Docker execution is substituted; approval and accounting stay real."""
    def __init__(self):
        self.store = None
        self.engine = self
        self.calls = []

    def inspect(self, target):
        return {'Id': 'new-container'}

    def run(self, job):
        self.calls.append(('run', job['id']))
        self.store.update(job['id'], status='deployed', stage='complete',
                          old_id='old-container', new_id='new-container')

    def restore(self, job):
        self.calls.append(('restore', job['id']))
        self.store.update(job['id'], status='rolled_back', stage='complete')


class HubManagementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.boundary = DeploymentBoundary()
        self.gate = Gate(self.directory, self.boundary, policy=POLICY,
                         head_resolver=lambda _: SHA)
        self.boundary.store = self.gate.store
        self.gate.store.set_mode('pi-web-hub', 'manual')
        self.http, self.admin = start_servers(self.gate, 0)
        self.addCleanup(self.stop)

    def stop(self):
        for server in (self.http, self.admin):
            server.shutdown()
            server.server_close()
        self.gate.close()
        self.tmp.cleanup()

    def request(self, method='GET', path=ROOT, value=None, *, token=None, headers=None,
                raw=None, admin=False):
        conn = http.client.HTTPConnection(*self.http.server_address, timeout=3)
        if admin:
            conn = http.client.HTTPConnection('localhost', timeout=3)
            conn.sock = socket.socket(socket.AF_UNIX)
            conn.sock.settimeout(3)
            conn.sock.connect(str(self.directory / 'admin.sock'))
        fields = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' +
                  (token if token is not None else getattr(self.gate, 'hub_management_token', 'missing'))}
        fields.update(headers or {})
        conn.request(method, path, raw if raw is not None else
                     (None if value is None else json.dumps(value)), fields)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def listing(self):
        code, data = self.request()
        self.assertEqual(code, 200, data)
        return data

    def task(self, kind, key):
        code, data = self.request(path=f'{ROOT}/tasks/{kind}/{key}')
        self.assertEqual(code, 200, data)
        return data

    def decision(self, task, action, decision_id=None):
        return dict(kind=task['kind'], id=task['id'], revision=task['revision'],
                    action=action, decision_id=decision_id or secrets.token_hex(16))

    def post(self, suffix, body):
        return self.request('POST', ROOT + '/' + suffix, body)

    def pending(self):
        return self.gate.submit({'commit': SHA})

    def finish(self):
        if self.gate.worker:
            self.gate.worker.join(3)
            self.assertFalse(self.gate.worker.is_alive())

    def runtime(self):
        m = self.gate.runtime_updates
        docker = DockerBoundary()
        self.gate.lifecycle.engine = docker
        m.runtime_engine = InstallBoundary(docker)
        m.catalog = RuntimeCatalog(fetch=lambda url: release(url.rsplit('/', 1)[-1]))
        m.set_policy({'mode': 'manual', 'images': [IMAGE]})
        return m.submit({'version': '1.3.0', 'idempotency_key': 'b' * 32})

    def test_dedicated_auth_safe_listing_and_exact_task(self):
        job = self.pending()
        for token in (self.gate.token, self.gate.lifecycle_token, '', 'wrong'):
            self.assertEqual(self.request(token=token)[0], 401)
            for method, path, body in (
                    ('GET', ROOT + '/tasks/deployment/' + job['id'], None),
                    ('GET', ROOT + '/decisions/' + 'a' * 32, None),
                    ('POST', ROOT + '/decisions', {}),
                    ('POST', ROOT + '/policies', {}),
                    ('POST', ROOT + '/resume', {})):
                self.assertEqual(self.request(method, path, body, token=token)[0], 401)
        data = self.listing()
        task = self.task('deployment', job['id'])
        self.assertEqual(data['tasks'], [task])
        self.assertEqual(task['actions'], ['approve', 'reject'])
        self.assertEqual(task['target'], 'pi-web-hub')
        self.assertEqual(task['plan_hash'], job['plan_hash'])
        self.assertRegex(task['revision'], '^[a-f0-9]{64}$')
        raw = json.dumps(data)
        for private in ('snapshot', 'private_volume', self.gate.token, self.gate.lifecycle_token,
                        self.gate.hub_management_token):
            self.assertNotIn(private, raw)
        for path in ('/admin/requests', '/v1/requests', '/v1/pi-lifecycle/restarts/' + 'a' * 32):
            self.assertEqual(self.request(path=path)[0], 401)

    def test_approval_durable_replay_and_changed_payload_conflict(self):
        job = self.pending()
        body = self.decision(self.task('deployment', job['id']), 'approve')
        code, receipt = self.post('decisions', body)
        self.assertEqual(code, 200, receipt)
        self.assertEqual(receipt['status'], 'recorded')
        self.assertEqual(receipt['task']['status'], 'deploying')
        self.finish()
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'deployed')
        self.assertEqual(self.gate.store.service('pi-web-hub')['failures'], 0)
        self.assertEqual(self.post('decisions', body), (200, receipt))
        self.assertEqual(self.request(path=ROOT + '/decisions/' + body['decision_id']), (200, receipt))
        self.assertEqual(self.post('decisions', {**body, 'action': 'reject'})[0], 409)
        self.assertEqual(self.boundary.calls, [('run', job['id'])])

    def test_concurrent_decisions_only_one_mutates(self):
        job = self.pending()
        task = self.task('deployment', job['id'])
        bodies = [self.decision(task, 'reject') for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            codes = list(pool.map(lambda b: self.post('decisions', b)[0], bodies))
        self.assertEqual(sorted(codes), [200, 409])
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'rejected')

    def test_full_raw_revision_and_policy_changes_conflict(self):
        job = self.pending()
        task = self.task('deployment', job['id'])
        self.gate.store.update(job['id'], private_execution_fence={'generation': 2})
        self.assertNotEqual(task['revision'], self.task('deployment', job['id'])['revision'])
        self.assertEqual(self.post('decisions', self.decision(task, 'approve'))[0], 409)
        task = self.task('deployment', job['id'])
        self.gate.store.set_mode('pi-web-hub', 'disabled')
        self.assertEqual(self.post('decisions', self.decision(task, 'approve'))[0], 409)
        task = self.task('deployment', job['id'])
        code, receipt = self.post('decisions', self.decision(task, 'approve'))
        self.assertEqual((code, receipt['status']), (200, 'delivery_unknown'))
        self.assertEqual(self.boundary.calls, [])

    def test_deployment_rollback_keeps_original_accounting(self):
        job = self.pending()
        self.assertEqual(self.post('decisions', self.decision(self.task('deployment', job['id']), 'approve'))[0], 200)
        self.finish()
        task = self.task('deployment', job['id'])
        self.assertEqual(task['actions'], ['rollback'])
        body = self.decision(task, 'rollback')
        self.assertEqual(self.post('decisions', body)[0], 200)
        self.finish()
        final = self.gate.store.get(job['id'])
        self.assertEqual(final['status'], 'rolled_back')
        self.assertEqual(final['deployment_outcome'], 'deployed')
        self.assertEqual(self.post('decisions', body)[0], 200)
        self.assertEqual(self.boundary.calls, [('run', job['id']), ('restore', job['id'])])

    def test_runtime_approval_and_real_rejection(self):
        job = self.runtime()
        task = self.task('runtime', job['id'])
        self.assertEqual(self.post('decisions', self.decision(task, 'approve'))[0], 200)
        self.assertEqual(self.gate.runtime_updates.get(job['id'])['status'], 'queued')
        task = self.task('runtime', job['id'])
        self.assertEqual(task['actions'], ['reject'])
        self.assertEqual(self.post('decisions', self.decision(task, 'reject'))[0], 200)
        self.assertEqual(self.gate.runtime_updates.get(job['id'])['status'], 'rejected')

    def test_intent_can_only_be_rejected(self):
        item = self.gate.store.intent(dict(service='widget', target='widget',
            repository='ghcr.io/acme/widget', description='Please register this service'))
        task = self.task('intent', item['id'])
        self.assertEqual(task['actions'], ['reject'])
        self.assertEqual(self.post('decisions', self.decision(task, 'approve'))[0], 409)
        self.assertEqual(self.post('decisions', self.decision(task, 'reject'))[0], 200)
        self.assertEqual(self.gate.store.intents()[0]['status'], 'rejected')
        self.assertEqual(self.gate.store.events()[0]['action'], 'intent_rejected')

    def test_policy_mode_preserves_trust_and_resume(self):
        self.gate.runtime_updates.set_policy({'mode': 'manual', 'images': [IMAGE]})
        self.gate.lifecycle.set_policy({'mode': 'manual', 'images': [IMAGE]})
        for _ in range(3):
            self.gate.store.record_result('pi-web-hub', False)
        for kind in ('service', 'runtime', 'restart'):
            policy = next(p for p in self.listing()['policies'] if p['kind'] == kind)
            for mode in ('auto', 'disabled', 'manual'):
                body = {k: policy[k] for k in ('kind', 'id', 'revision')}
                body.update(mode=mode, decision_id=secrets.token_hex(16))
                code, receipt = self.post('policies', body)
                self.assertEqual(code, 200, receipt)
                self.assertEqual(receipt['policy']['mode'], mode)
                self.assertEqual(self.post('policies', body), (200, receipt))
                if kind != 'service':
                    self.assertEqual(receipt['policy']['images'], [IMAGE])
                policy = receipt['policy']
        self.assertEqual(self.gate.runtime_updates.policy()['images'], [IMAGE])
        self.assertEqual(self.gate.lifecycle.policy()['images'], [IMAGE])
        policy = next(p for p in self.listing()['policies'] if p['kind'] == 'service')
        self.assertTrue(policy['paused'])
        body = dict(id=policy['id'], revision=policy['revision'], decision_id=secrets.token_hex(16))
        code, receipt = self.post('resume', body)
        self.assertEqual(code, 200, receipt)
        self.assertFalse(receipt['policy']['paused'])
        self.assertEqual(self.gate.store.service('pi-web-hub')['failures'], 0)
        self.assertEqual(self.post('resume', body), (200, receipt))
        self.assertEqual(self.post('resume', {**body, 'decision_id': secrets.token_hex(16)})[0], 409)
        self.assertEqual(self.post('resume', {**body, 'revision': '0' * 64})[0], 409)

    def test_http_origin_route_and_body_bounds(self):
        self.assertEqual(self.request(headers={'Origin': 'https://chat.example'})[0], 403)
        self.assertEqual(self.request(headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request(headers={'Authorization': 'Bearer wrong'})[0], 401)
        for suffix in ('?x=1', '/', '/tasks/deployment/' + 'a' * 32 + '/extra',
                       '/tasks/bogus/' + 'a' * 32, '/decisions/' + 'a' * 31,
                       '/tasks/deployment/%61' + 'a' * 31, '/admin/approve'):
            self.assertIn(self.request(path=ROOT + suffix)[0], (400, 404))
        self.assertEqual(self.request('POST', ROOT, {})[0], 405)
        self.assertEqual(self.request(path=ROOT + '/policies')[0], 405)
        for raw in ('{}', '{"id":1,"id":2}', '{"x":NaN}', '[]', '{', ' ' * 4097):
            self.assertEqual(self.request('POST', ROOT + '/decisions', raw=raw)[0], 400)
        self.assertEqual(self.request('POST', ROOT + '/resume', {}, headers={'Content-Type': 'text/plain'})[0], 400)
        job = self.pending()
        body = self.decision(self.task('deployment', job['id']), 'reject')
        self.assertEqual(self.post('decisions', {**body, 'command': 'arbitrary'})[0], 400)
        self.assertEqual(self.post('decisions', {**body, 'revision': []})[0], 400)
        self.assertEqual(self.post('decisions', {**body, 'decision_id': '../invalid'})[0], 400)

    def test_receipt_survives_gate_restart(self):
        job = self.pending()
        body = self.decision(self.task('deployment', job['id']), 'reject')
        code, receipt = self.post('decisions', body)
        self.assertEqual(code, 200, receipt)
        token = self.gate.hub_management_token
        self.gate.close()
        self.gate = Gate(self.directory, self.boundary, policy=POLICY)
        self.boundary.store = self.gate.store
        self.http.gate = self.admin.gate = self.gate
        self.assertEqual(self.gate.hub_management_token, token)
        self.assertEqual(self.post('decisions', body), (200, receipt))
        self.assertEqual(self.request(path=ROOT + '/decisions/' + body['decision_id']), (200, receipt))

    def test_restart_approval_keeps_source_and_policy_fences(self):
        # Reuse the established offline source-evidence fixture, not a fake approve.
        from test_lifecycle import Gate as EvidenceGate, FakeEngine, BODY, KEY
        with tempfile.TemporaryDirectory() as directory:
            gate = EvidenceGate(Path(directory))
            try:
                gate.lifecycle.engine = FakeEngine()
                gate.lifecycle.set_policy({'mode': 'manual', 'images': [IMAGE]})
                job = gate.lifecycle.submit(BODY)
                task = gate.hub_management.task('restart', job['id'])
                receipt = gate.hub_management.write('decisions', self.decision(task, 'approve'))
                self.assertEqual(receipt['task']['status'], 'queued')
                self.assertEqual(gate.lifecycle.get(KEY)['status'], 'queued')
                body = self.decision(gate.hub_management.task('restart', KEY), 'reject')
                self.assertEqual(gate.hub_management.write('decisions', body)['task']['status'], 'rejected')
                self.assertEqual(gate.lifecycle.get(KEY)['stage'], 'host_rejected')
                # No restart was dispatched by granting approval or rejecting queued work.
                self.assertTrue(all(call['action'] == 'status' for call in gate.lifecycle.engine.calls))
            finally:
                gate.close()

    def test_dispatch_intent_precedes_executor_and_unknown_is_never_replayed(self):
        job = self.pending()
        body = self.decision(self.task('deployment', job['id']), 'reject')
        manager = self.gate.hub_management
        dispatch = manager._dispatch
        def interrupted(*args):
            with contextlib.closing(sqlite3.connect(self.directory / 'jobs.sqlite3')) as db:
                receipt = json.loads(db.execute('SELECT receipt FROM hub_management_receipts WHERE id=?',
                                               (body['decision_id'],)).fetchone()[0])
            self.assertEqual(receipt, {'decision_id': body['decision_id'], 'status': 'delivery_unknown'})
            dispatch(*args)
            raise RuntimeError('simulate lost completion record')
        with patch.object(manager, '_dispatch', side_effect=interrupted):
            self.assertEqual(self.post('decisions', body),
                             (200, {'decision_id': body['decision_id'], 'status': 'delivery_unknown'}))
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'rejected')
        expected = {'decision_id': body['decision_id'], 'status': 'delivery_unknown'}
        self.gate.close()
        self.gate = Gate(self.directory, self.boundary, policy=POLICY)
        self.http.gate = self.admin.gate = self.gate
        self.boundary.store = self.gate.store
        with patch.object(self.gate.hub_management, '_dispatch', side_effect=AssertionError('replayed')):
            self.assertEqual(self.post('decisions', body), (200, expected))
            self.assertEqual(self.request(path=ROOT + '/decisions/' + body['decision_id']), (200, expected))
            self.assertEqual(self.post('decisions', {**body, 'action': 'approve'})[0], 409)

    def test_full_receipt_storage_preserves_unknown_and_blocks_new_mutations(self):
        from gate import hub_management
        first = self.pending()
        body = self.decision(self.task('deployment', first['id']), 'reject')
        with patch.object(self.gate.hub_management, '_dispatch', side_effect=RuntimeError('interrupted')):
            self.assertEqual(self.post('decisions', body),
                             (200, {'decision_id': body['decision_id'], 'status': 'delivery_unknown'}))
        with patch.object(hub_management, 'RECEIPT_LIMIT', 1):
            other = self.gate.submit({'commit': '2' * 40})
            self.assertEqual(self.post('decisions', self.decision(self.task('deployment', other['id']), 'reject'))[0], 409)
            self.assertEqual(self.gate.store.get(other['id'])['status'], 'pending')
            self.assertEqual(self.post('decisions', body)[1]['status'], 'delivery_unknown')

    def test_open_work_never_disappears_behind_history(self):
        oldest = self.pending()
        for number in range(110):
            job = self.gate.submit({'commit': '%040x' % (number + 10)})
            self.gate.store.update(job['id'], status='rejected')
        data = self.listing()
        self.assertEqual(len(data['tasks']), 101)
        self.assertEqual(data['tasks'][0]['id'], oldest['id'])

    def test_failed_deployments_are_bounded_terminal_history(self):
        oldest = self.pending()
        for number in range(110):
            job = self.gate.submit({'commit': '%040x' % (number + 10)})
            self.gate.store.update(job['id'], status='failed')
        data = self.listing()
        self.assertEqual(len(data['tasks']), 101)
        self.assertEqual(data['tasks'][0]['id'], oldest['id'])

    def test_historical_deployment_target_comes_from_reviewed_snapshot(self):
        self.gate.store.register_service(image_service(mode='manual'))
        job = self.gate.submit({'service': 'widget', 'image': 'ghcr.io/acme/widget@sha256:' + 'a' * 64})
        # A trusted admin can change a definition later; rollback still targets the snapshot.
        self.gate.store.register_service(image_service(target='widget-v2', mode='manual'))
        task = self.task('deployment', job['id'])
        self.assertEqual(task['target'], 'widget')
        code, receipt = self.post('decisions', self.decision(task, 'approve'))
        self.assertEqual((code, receipt['status']), (200, 'delivery_unknown'))
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'pending')

    def test_unexpected_route_prefix_never_lists_or_mutates(self):
        for suffix in ('evil/decisions', 'evil/decisions/' + 'a' * 32,
                       'evil/tasks/deployment/' + 'a' * 32):
            self.assertEqual(self.request(path=ROOT + suffix)[0], 404)

    def test_overview_count_overflow_fails_explicitly_without_hiding_open_work(self):
        from gate import hub_management
        first = self.pending()
        second = self.gate.submit({'commit': '2' * 40})
        with patch.object(hub_management, 'TASK_LIMIT', 1, create=True):
            self.assertEqual(self.request()[0], 409)
            self.assertEqual(self.task('deployment', first['id'])['status'], 'pending')
            self.assertEqual(self.task('deployment', second['id'])['status'], 'pending')
        with patch.object(hub_management, 'POLICY_LIMIT', 1, create=True):
            self.assertEqual(self.request()[0], 409)

    def test_overview_wire_bound_matches_actual_encoded_response(self):
        from gate import hub_management
        self.pending()
        data = self.listing()
        encoded_length = len(json.dumps(data, ensure_ascii=True).encode())
        # The HTTP serializer adds spaces; counting only canonical JSON is insufficient.
        with patch.object(hub_management, 'RESPONSE_LIMIT', encoded_length - 1):
            self.assertEqual(self.request()[0], 409)

    def test_policy_stale_revision_and_shared_decision_id_conflict(self):
        policy = next(p for p in self.listing()['policies'] if p['kind'] == 'service')
        body = {k: policy[k] for k in ('kind', 'id', 'revision')}
        body.update(mode='auto', decision_id=secrets.token_hex(16))
        self.assertEqual(self.post('policies', body)[0], 200)
        self.assertEqual(self.post('policies', {**body, 'mode': 'disabled'})[0], 409)
        self.assertEqual(self.post('policies', {**body, 'decision_id': secrets.token_hex(16)})[0], 409)
        job = self.gate.submit({'commit': '2' * 40})
        decision = self.decision(self.task('deployment', job['id']), 'reject', body['decision_id'])
        self.assertEqual(self.post('decisions', decision)[0], 409)

    def test_delayed_resume_cannot_clear_a_later_pause_incident(self):
        store = self.gate.store
        store.set_mode('pi-web-hub', 'auto')
        execution_policy_hash = store.service('pi-web-hub')['policy_hash']

        def fail_automatic_jobs(first):
            for number in range(first, first + 3):
                job = store.request_version('pi-web-hub', {'commit': '%040x' % number}, automatic=True)
                store.update(job['id'], status='failed', stage='worker_failed')
                store.account_job_result(job['id'])
                # Duplicate accounting must not advance the incident or affect fences.
                before = store.service('pi-web-hub')
                store.account_job_result(job['id'])
                self.assertEqual(store.service('pi-web-hub'), before)

        fail_automatic_jobs(10)
        first = next(p for p in self.listing()['policies'] if p['kind'] == 'service')
        self.assertTrue(first['paused'])
        first_resume = dict(id=first['id'], revision=first['revision'], decision_id='a' * 32)
        code, original_receipt = self.post('resume', first_resume)
        self.assertEqual(code, 200, original_receipt)
        self.assertEqual(original_receipt['status'], 'recorded')
        fail_automatic_jobs(20)
        second = next(p for p in self.listing()['policies'] if p['kind'] == 'service')
        self.assertTrue(second['paused'])
        self.assertEqual(store.service('pi-web-hub')['failures'], 3)
        self.assertNotEqual(first['revision'], second['revision'])
        self.assertEqual(store.service('pi-web-hub')['policy_hash'], execution_policy_hash)

        # Persist the new incident across reopening the real Gate/SQLite store.
        self.gate.close()
        self.gate = Gate(self.directory, self.boundary, policy=POLICY)
        self.boundary.store = self.gate.store
        self.http.gate = self.admin.gate = self.gate
        reopened = next(p for p in self.listing()['policies'] if p['kind'] == 'service')
        self.assertEqual(reopened['revision'], second['revision'])
        delayed = {**first_resume, 'decision_id': 'b' * 32}
        self.assertEqual(self.post('resume', delayed)[0], 409)
        self.assertEqual(self.post('resume', first_resume), (200, original_receipt))
        self.assertEqual(self.gate.store.service('pi-web-hub')['failures'], 3)
        self.assertTrue(self.gate.store.service('pi-web-hub')['paused'])
        self.assertEqual(self.gate.store.service('pi-web-hub')['policy_hash'], execution_policy_hash)
        fresh = dict(id=reopened['id'], revision=reopened['revision'], decision_id='c' * 32)
        self.assertEqual(self.post('resume', fresh)[1]['status'], 'recorded')
        self.assertFalse(self.gate.store.service('pi-web-hub')['paused'])

    def test_long_pinned_image_identity_survives_lookup_overview_and_receipt(self):
        for repository_length in (198, 255):
            with self.subTest(repository_length=repository_length):
                repository = 'ghcr.io/' + 'a' * (repository_length - len('ghcr.io/'))
                image = repository + '@sha256:' + 'b' * 64
                identifier = 'image-' + str(repository_length)
                self.gate.store.register_service(image_service(identifier=identifier, target=identifier,
                                                               repository=repository, mode='manual'))
                job = self.gate.submit({'service': identifier, 'image': image})
                self.assertEqual(len(image), 270 if repository_length == 198 else 327)
                task = self.task('deployment', job['id'])
                self.assertEqual(task.get('image'), image)
                self.assertIn('approve', task['actions'])
                overview = next(t for t in self.listing()['tasks'] if t['id'] == job['id'])
                self.assertEqual(overview['image'], image)
                body = self.decision(task, 'approve')
                code, receipt = self.post('decisions', body)
                self.assertEqual(code, 200, receipt)
                self.assertEqual(receipt['status'], 'recorded')
                self.assertEqual(receipt['task']['image'], image)
                self.finish()
                self.assertEqual(self.gate.store.get(job['id'])['status'], 'deployed')
                self.assertEqual(self.task('deployment', job['id'])['image'], image)
                self.assertEqual(self.post('decisions', body), (200, receipt))

    def test_redacted_image_identity_does_not_advertise_execution(self):
        self.gate.store.register_service(image_service(mode='manual'))
        # A digest matching a credential must remain redacted, even with the larger bound.
        image = 'ghcr.io/acme/widget@sha256:' + self.gate.hub_management_token
        job = self.gate.submit({'service': 'widget', 'image': image})
        task = self.task('deployment', job['id'])
        self.assertNotIn('image', task)
        self.assertEqual(task['actions'], ['reject'])
        self.assertNotIn(self.gate.hub_management_token, json.dumps(task))
        self.assertEqual(self.post('decisions', self.decision(task, 'approve'))[0], 409)

    def test_full_runtime_release_fence_is_kept(self):
        job = self.runtime()
        manager = self.gate.runtime_updates
        raw = manager._get(job['id'])
        manager._update(job['id'], release={**raw['release'], 'version': '1.4.0'})
        current = self.task('runtime', job['id'])
        code, receipt = self.post('decisions', self.decision(current, 'approve'))
        self.assertEqual((code, receipt['status']), (200, 'delivery_unknown'))
        self.assertEqual(manager.get(job['id'])['status'], 'pending')

    def test_all_post_intent_dispatch_errors_return_original_unknown(self):
        job = self.pending()
        for error in (RuntimeError('blocked'), ValueError('changed'), KeyError('changed'),
                      TypeError('changed'), OSError('lost'), sqlite3.OperationalError('lost')):
            with self.subTest(error=type(error).__name__):
                body = self.decision(self.task('deployment', job['id']), 'reject')
                expected = {'decision_id': body['decision_id'], 'status': 'delivery_unknown'}
                with patch.object(self.gate.hub_management, '_dispatch', side_effect=error):
                    self.assertEqual(self.post('decisions', body), (200, expected))
                self.assertEqual(self.post('decisions', body), (200, expected))
                self.assertEqual(self.gate.store.get(job['id'])['status'], 'pending')

    def test_receipt_completion_write_failure_returns_durable_unknown(self):
        connection = self.gate.store.db
        class FailingCompletion:
            def execute(self, statement, parameters=()):
                if statement.startswith('UPDATE hub_management_receipts SET receipt='):
                    raise sqlite3.OperationalError('completion write failed')
                return connection.execute(statement, parameters)

            def __getattr__(self, name):
                return getattr(connection, name)
        job = self.pending()
        body = self.decision(self.task('deployment', job['id']), 'reject')
        expected = {'decision_id': body['decision_id'], 'status': 'delivery_unknown'}
        with patch.object(self.gate.store, 'db', FailingCompletion()):
            self.assertEqual(self.post('decisions', body), (200, expected))
        self.assertEqual(self.gate.store.get(job['id'])['status'], 'rejected')
        self.assertEqual(self.post('decisions', body), (200, expected))
        self.assertEqual(self.request(path=ROOT + '/decisions/' + body['decision_id']), (200, expected))

    def test_export_directory_ancestors_and_permissions_are_checked(self):
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        export = namespace.get('export_credential')
        self.assertTrue(callable(export), 'shared private credential export is missing')
        export.__globals__['admin'] = lambda *a, **k: self.fail('unsafe export contacted admin')
        linked = self.directory / 'linked'
        linked.symlink_to(self.directory, target_is_directory=True)
        insecure = self.directory / 'insecure'
        insecure.mkdir()
        insecure.chmod(0o777)
        for path in ('relative.json', str(linked / 'key.json'), str(insecure / 'key.json')):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                export(path, 'hub-management-export')

    def test_management_credential_is_private_regular_unique_nofollow(self):
        from gate.hub_management import credential
        path = self.directory / 'hub-management.token'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(credential(self.directory, (self.gate.token, self.gate.lifecycle_token)),
                         self.gate.hub_management_token)
        self.assertEqual(len({self.gate.token, self.gate.lifecycle_token, self.gate.hub_management_token}), 3)
        for kind in ('symlink', 'hardlink', 'fifo', 'permissions', 'request-token', 'lifecycle-token', 'too-long'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'hub-management.token'
                if kind == 'symlink':
                    target.symlink_to(path)
                elif kind == 'hardlink':
                    os.link(path, target)
                elif kind == 'fifo':
                    os.mkfifo(target, 0o600)
                else:
                    content = (self.gate.token if kind == 'request-token' else
                               self.gate.lifecycle_token if kind == 'lifecycle-token' else 'a' * 64)
                    if kind == 'too-long':
                        content += 'b'
                    target.touch(mode=0o600)
                    # Test fixtures also use the normal private file API.
                    with target.open('w') as stream:
                        stream.write(content)
                    if kind == 'permissions':
                        target.chmod(0o644)
                with self.assertRaises((OSError, ValueError)):
                    credential(Path(directory), (self.gate.token, self.gate.lifecycle_token))

    def test_duplicate_headers_and_framing_are_rejected(self):
        def raw_request(extra):
            with socket.create_connection(self.http.server_address, timeout=3) as peer:
                peer.sendall((f'POST {ROOT}/decisions HTTP/1.1\r\n'
                              f'Host: 127.0.0.1:{self.http.server_address[1]}\r\n'
                              f'Authorization: Bearer {self.gate.hub_management_token}\r\n'
                              'Content-Type: application/json\r\n' + extra + '\r\n{}').encode())
                response = http.client.HTTPResponse(peer)
                response.begin()
                result = response.status
                response.read()
                return result
        for extra in ('Content-Length: 2\r\nContent-Length: 2\r\n',
                      'Content-Length: 2\r\nTransfer-Encoding: chunked\r\n',
                      'Content-Length: 4097\r\n',
                      'Content-Length: 2\r\nAuthorization: Bearer wrong\r\n',
                      'Content-Length: 2\r\nHost: evil.example\r\n',
                      'Content-Length: 2\r\nOrigin: http://localhost\r\nOrigin: http://localhost\r\n'):
            with self.subTest(extra=extra):
                self.assertEqual(raw_request(extra), 400)

    def test_service_images_and_private_state_are_not_projected(self):
        definition = image_service(mode='manual')
        self.gate.store.register_service(definition)
        job = self.gate.submit({'service': 'widget', 'image': 'ghcr.io/acme/widget@sha256:' + 'a' * 64})
        self.gate.store.update(job['id'], error='token=' + self.gate.hub_management_token,
            private_notes={'chat': 'a private conversation'}, environment={'API_KEY': 'hidden'})
        task = self.task('deployment', job['id'])
        self.assertEqual(task['image'], 'ghcr.io/acme/widget@sha256:' + 'a' * 64)
        self.assertNotIn('hidden', json.dumps(task))
        self.assertNotIn('private', json.dumps(task))
        policy = next(p for p in self.listing()['policies'] if p['id'] == 'widget')
        before = self.gate.store.service('widget')
        body = {k: policy[k] for k in ('kind', 'id', 'revision')}
        body.update(mode='auto', decision_id=secrets.token_hex(16))
        self.assertEqual(self.post('policies', body)[0], 200)
        after = self.gate.store.service('widget')
        for field in ('source', 'policy'):
            self.assertEqual(after[field], before[field])
        self.assertEqual(self.post('policies', {**body, 'images': [IMAGE]})[0], 400)

    def test_export_is_admin_only_and_help_is_offline(self):
        for token in (self.gate.token, self.gate.lifecycle_token,
                      getattr(self.gate, 'hub_management_token', 'missing')):
            self.assertIn(self.request('POST', '/admin/hub-management-export', {}, token=token)[0], (401, 404))
        code, value = self.request('POST', '/admin/hub-management-export', {}, admin=True)
        self.assertEqual(code, 200, value)
        self.assertEqual(value, {'token': self.gate.hub_management_token})
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        output = io.StringIO()
        with patch.object(sys, 'argv', ['gatectl', 'hub-management-export', '--help']), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                namespace['main']()
        self.assertEqual(stopped.exception.code, 0)
        self.assertIn('hub-management-export', output.getvalue())

    def test_host_export_creates_once_private_file_without_printing_secret(self):
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        calls = []
        def admin(command, **kwargs):
            calls.append((command, kwargs))
            return {'token': self.gate.hub_management_token}
        namespace['main'].__globals__['admin'] = admin
        output = io.StringIO()
        destination = self.directory / 'export.json'
        with patch.object(sys, 'argv', ['gatectl', 'hub-management-export', str(destination)]), contextlib.redirect_stdout(output):
            namespace['main']()
        self.assertEqual(calls, [('hub-management-export', {'payload': {}})])
        self.assertEqual(json.loads(destination.read_text()), {'token': self.gate.hub_management_token})
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.gate.hub_management_token, output.getvalue())
        for path in (destination, self.directory / 'symlink.json'):
            if path != destination:
                path.symlink_to(destination)
            with self.subTest(path=path), patch.object(sys, 'argv', ['gatectl', 'hub-management-export', str(path)]):
                with self.assertRaises((ValueError, OSError)):
                    namespace['main']()


if __name__ == '__main__':
    unittest.main()

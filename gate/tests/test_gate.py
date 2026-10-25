import concurrent.futures
import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from gate.service import Gate, start_servers

SHA = '1' * 40


class DummyDeployer:
    # Docker is the external trust boundary; request/auth/state code stays real.
    def __init__(self):
        self.called = []
        self.wait = threading.Event()

    def recover(self):
        pass

    def run(self, job):
        self.called.append(job)
        self.wait.wait(2)


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.worker = DummyDeployer()
        self.gate = Gate(Path(self.tmp.name), self.worker)
        self.http, self.admin = start_servers(self.gate, port=0)
        self.addCleanup(self.stop)
        self.port = self.http.server_address[1]

    def stop(self):
        self.worker.wait.set()
        self.http.shutdown()
        self.admin.shutdown()
        self.http.server_close()
        self.admin.server_close()
        self.gate.close()

    def request(self, method, path, value=None, token=True, headers=None, admin=False):
        if admin:
            conn = http.client.HTTPConnection('localhost', timeout=3)
            conn.sock = socket.socket(socket.AF_UNIX)
            conn.sock.connect(str(Path(self.tmp.name) / 'admin.sock'))
        else:
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        fields = {'Content-Type': 'application/json'}
        if token:
            fields['Authorization'] = 'Bearer ' + self.gate.token
        fields.update(headers or {})
        conn.request(method, path, None if value is None else json.dumps(value), fields)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_pending_request_never_deploys(self):
        status, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(status, 201)
        self.assertEqual(job['status'], 'pending')
        self.assertEqual(self.worker.called, [])
        self.assertNotIn(self.gate.token, json.dumps(job))

    def test_http_cannot_approve_even_with_request_token(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(self.request('POST', '/admin/approve', {'id': job['id'], 'commit': SHA})[0], 404)
        self.assertEqual(self.worker.called, [])

    def test_approval_requires_exact_reviewed_commit(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(self.request('POST', '/admin/approve', {'id': job['id'], 'commit': '2' * 40}, admin=True)[0], 409)
        self.assertEqual(self.worker.called, [])
        self.assertEqual(self.request('POST', '/admin/approve', {'id': job['id'], 'commit': SHA}, admin=True)[0], 202)

    def test_auth_origin_and_unknown_fields_are_rejected(self):
        self.assertEqual(self.request('GET', '/v1/requests', token=False)[0], 401)
        self.assertEqual(self.request('GET', '/v1/requests', headers={'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.request('POST', '/v1/requests', {'commit': SHA}, headers={'Origin': 'https://evil.example'})[0], 403)
        for value in ({'commit': 'main'}, {'commit': SHA, 'command': 'rm -rf /'},
                      {'commit': SHA, 'repo': 'evil/repo'}, {'commit': SHA, 'target': 'other'},
                      {'commit': SHA, 'compose': 'arbitrary'}, {'commit': ['bad']}):
            with self.subTest(value=value):
                self.assertEqual(self.request('POST', '/v1/requests', value)[0], 400)

    def test_duplicate_and_concurrent_approvals_are_bounded(self):
        _, first = self.request('POST', '/v1/requests', {'commit': SHA})
        _, second = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(first['id'], second['id'])
        _, other = self.request('POST', '/v1/requests', {'commit': '2' * 40})
        self.assertEqual(self.request('POST', '/admin/approve', {'id': first['id'], 'commit': SHA}, admin=True)[0], 202)
        self.assertEqual(self.request('POST', '/admin/approve', {'id': other['id'], 'commit': '2' * 40}, admin=True)[0], 409)

    def test_private_files_and_admin_socket_not_world_readable(self):
        for name in ('request.token', 'jobs.sqlite3', 'admin.sock'):
            self.assertEqual((Path(self.tmp.name) / name).stat().st_mode & 0o077, 0)

    def test_rejected_job_cannot_be_approved(self):
        _, job = self.request('POST', '/v1/requests', {'commit': SHA})
        self.assertEqual(self.request('POST', '/admin/reject', {'id': job['id']}, admin=True)[0], 200)
        self.assertEqual(self.request('POST', '/admin/approve', {'id': job['id'], 'commit': SHA}, admin=True)[0], 409)

    def test_pending_quota_does_not_start_any_worker(self):
        for char in '12345678':
            self.assertEqual(self.request('POST', '/v1/requests', {'commit': char * 40})[0], 201)
        self.assertEqual(self.request('POST', '/v1/requests', {'commit': '9' * 40})[0], 409)
        self.assertEqual(self.worker.called, [])

    def test_full_request_connection_pool_cannot_block_private_admin(self):
        peers = []
        try:
            for _ in range(32):
                peers.append(socket.create_connection(('127.0.0.1', self.port), timeout=2))
            # A completed authenticated HTTP request fills any accept backlog;
            # wait until all request-side slots have actually been acquired.
            import time
            deadline = time.monotonic() + 2
            while self.http.slots._value and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(self.http.slots._value, 0)
            self.assertEqual(self.request('GET', '/admin/requests', admin=True)[0], 200)
        finally:
            for peer in peers:
                peer.close()

    def test_private_exact_status_is_not_limited_to_recent_hundred(self):
        oldest = self.gate.store.request(SHA)
        self.gate.store.update(oldest['id'], status='rejected')
        for number in range(101):
            job = self.gate.store.request('%040x' % (number + 10))
            self.gate.store.update(job['id'], status='rejected')
        self.assertEqual(self.request('GET', '/admin/requests/' + oldest['id'], admin=True)[1]['id'], oldest['id'])
        self.assertEqual(self.request('GET', '/admin/requests/' + oldest['id'])[0], 404)


if __name__ == '__main__':
    unittest.main()

import http.client
import json
import socket
from pathlib import Path
import tempfile
import unittest

from gate.service import Gate, start_servers
from gate.runtime_catalog import RuntimeCatalog
from test_runtime_catalog import release
from test_runtime_updates import DockerBoundary, InstallBoundary, IMAGE, KEY


class RuntimeHTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gate = Gate(Path(self.tmp.name))
        self.gate.runtime_updates.catalog = RuntimeCatalog(fetch=lambda url: release(url.rsplit('/', 1)[-1]))
        self.http, self.admin = start_servers(self.gate, 0)

    def tearDown(self):
        for server in (self.http, self.admin):
            server.shutdown()
            server.server_close()
        self.gate.close()
        self.tmp.cleanup()

    def request(self, method, path, value=None, token=None):
        connection = http.client.HTTPConnection(*self.http.server_address, timeout=3)
        connection.request(method, path, json.dumps(value) if value else None,
                           {'Authorization': 'Bearer ' + (token or self.gate.token),
                            'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_request_only_client_can_submit_and_query_but_not_approve_or_set_policy(self):
        self.gate.runtime_updates.set_policy({'mode': 'manual', 'images': ['sha256:' + 'a' * 64]})
        code, job = self.request('POST', '/v1/runtime-updates',
                                  {'version': '1.3.0', 'idempotency_key': 'b' * 32})
        self.assertEqual(code, 202)
        self.assertEqual(job['status'], 'pending')
        self.assertEqual(self.request('GET', '/v1/runtime-updates/' + job['id'])[1]['version'], '1.3.0')
        for endpoint in ('/admin/runtime-approve', '/admin/runtime-policy', '/v1/runtime-approve'):
            self.assertEqual(self.request('POST', endpoint, {'id': job['id']})[0], 404)
        self.assertEqual(self.gate.runtime_updates.get(job['id'])['status'], 'pending')
        self.assertEqual(self.request('GET', '/v1/runtime-updates', token=self.gate.lifecycle_token)[0], 401)

    def admin_request(self, path, value):
        connection = http.client.HTTPConnection('localhost', timeout=3)
        connection.sock = socket.socket(socket.AF_UNIX)
        connection.sock.settimeout(3)
        connection.sock.connect(str(self.gate.directory / 'admin.sock'))
        connection.request('POST', path, json.dumps(value), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_runtime_resolution_is_host_only_exact_and_keeps_unknown_outcome(self):
        docker = DockerBoundary()
        self.gate.lifecycle.engine = docker
        manager = self.gate.runtime_updates
        manager.runtime_engine = InstallBoundary(docker)
        manager.set_policy({'mode': 'auto', 'images': [IMAGE]})
        manager.submit({'version': '1.3.0', 'idempotency_key': KEY})
        manager._update(KEY, status='recovery_required', stage='installation_outcome_unknown')
        body = {'id': KEY, 'acknowledge': 'inspected_no_mutation'}
        self.assertEqual(self.request('POST', '/admin/runtime-resolve', body)[0], 404)
        self.assertEqual(self.admin_request('/admin/runtime-resolve', {**body, 'exec': 'id'})[0], 400)
        self.assertEqual(self.admin_request('/admin/runtime-resolve', {**body, 'acknowledge': 'yes'})[0], 400)
        code, value = self.admin_request('/admin/runtime-resolve', body)
        self.assertEqual(code, 200)
        self.assertEqual(value['status'], 'recovery_required')
        self.assertTrue(value['resolved'])
        self.assertEqual(manager.active(), [])


if __name__ == '__main__':
    unittest.main()

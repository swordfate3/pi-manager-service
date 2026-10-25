"""Discovery handler/auth units without sockets; not TCP integration evidence."""
from email.message import Message
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from gate.runtime_catalog import RuntimeCatalog
from gate.service import Gate, Handler


class DiscoveryHTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.gate.close)

    def request(self, method, path, value=None, token=None):
        handler = object.__new__(Handler)
        handler.server = SimpleNamespace(gate=self.gate, is_admin=False, server_address=('127.0.0.1', 12345))
        handler.command, handler.path = method, path
        handler.headers = Message()
        handler.headers['Host'] = '127.0.0.1:12345'
        handler.headers['Authorization'] = 'Bearer ' + (token or self.gate.token)
        replies = []
        handler.reply = lambda status, body: replies.append((status, body))
        handler.dispatch()
        self.assertEqual(len(replies), 1)
        return replies[0]

    def test_catalog_uses_request_only_credential_and_accepts_empty_first_page_cursor(self):
        self.gate.runtime_updates.catalog = RuntimeCatalog(fetch=lambda _: {'versions': {'1.4.0': {}, '1.3.0': {}}})
        code, value = self.request('GET', '/v1/runtime-versions?query=1.&cursor=')
        self.assertEqual(code, 200)
        self.assertEqual(value['versions'], [{'version': '1.4.0'}, {'version': '1.3.0'}])
        self.assertEqual(self.request('GET', '/v1/runtime-versions', token='invalid')[0], 401)
        self.assertEqual(self.request('GET', '/v1/runtime-versions', token=self.gate.lifecycle_token)[0], 401)

    def test_arbitrary_registry_and_repeated_or_unknown_query_fields_are_rejected(self):
        for query in ('registry=https://evil.invalid', 'query=1&query=2', 'query=latest', 'cursor=../secret'):
            with self.subTest(query=query):
                self.assertEqual(self.request('GET', '/v1/runtime-versions?' + query)[0], 400)
        self.assertEqual(self.request('POST', '/v1/runtime-versions', {'version': '1.4.0'})[0], 405)
        self.assertEqual(self.request('GET', '/v1/runtime-readiness?query=1')[0], 400)
        self.assertEqual(self.gate.runtime_updates.jobs(), [])

    def test_readiness_without_docker_engine_is_unavailable_not_ready(self):
        code, result = self.request('GET', '/v1/runtime-readiness')
        self.assertEqual(code, 200)
        self.assertEqual(result, {'status': 'unavailable', 'consumers': []})


if __name__ == '__main__':
    unittest.main()

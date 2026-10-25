import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
from unittest import mock

from gate import admin as admin_module
from gate import client as client_module


ROOT = Path(__file__).resolve().parents[1]
JOB_ID = '1' * 32
IMAGE = 'sha256:' + 'a' * 64


class RecordingOpener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return io.BytesIO(b'{"accepted": true}')


class RuntimeClientTest(unittest.TestCase):
    def invoke(self, args, generated_key=None):
        opener = RecordingOpener()
        self.generated_token_hex_calls = []
        output, errors = io.StringIO(), io.StringIO()
        patches = [
            mock.patch.object(sys, 'argv', ['pi-gate', *args]),
            mock.patch.object(client_module, 'read_token', return_value='b' * 64),
            mock.patch.object(client_module.urllib.request, 'build_opener', return_value=opener),
        ]
        if generated_key is not None:
            def token_hex(byte_count):
                self.generated_token_hex_calls.append(byte_count)
                return generated_key
            patches.append(mock.patch('secrets.token_hex', side_effect=token_hex))
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                try:
                    client_module.main()
                    code = 0
                except SystemExit as error:
                    code = error.code
        return code, output.getvalue(), errors.getvalue(), opener.requests

    def assert_request(self, captured, method, path, body=None):
        self.assertEqual(len(captured), 1)
        request, timeout = captured[0]
        self.assertEqual(timeout, 10)
        self.assertEqual(request.get_method(), method)
        self.assertEqual(request.full_url, 'http://127.0.0.1:16182' + path)
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + 'b' * 64)
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(json.loads(request.data) if request.data is not None else None, body)
        if body is not None:
            self.assertEqual(set(json.loads(request.data)), set(body))

    def test_runtime_update_posts_exact_version_and_supplied_idempotency_key(self):
        code, _, errors, captured = self.invoke(
            ['runtime-update', '12.34.56', '--idempotency-key', JOB_ID])

        self.assertEqual(code, 0, errors)
        self.assert_request(captured, 'POST', '/v1/runtime-updates', {
            'version': '12.34.56',
            'idempotency_key': JOB_ID,
        })

    def test_runtime_update_generates_a_16_byte_hex_idempotency_key(self):
        generated = 'c' * 32
        code, _, errors, captured = self.invoke(['runtime-update', '0.0.0'], generated_key=generated)

        self.assertEqual(code, 0, errors)
        self.assert_request(captured, 'POST', '/v1/runtime-updates', {
            'version': '0.0.0',
            'idempotency_key': generated,
        })
        self.assertEqual(self.generated_token_hex_calls, [16])

    def test_runtime_update_rejects_nonstable_or_noncanonical_versions_before_http(self):
        invalid = ('latest', 'v1.2.3', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03',
                   '1.2.3-alpha', '1.2.3+build', '^1.2.3', ' 1.2.3')
        for version in invalid:
            with self.subTest(version=version):
                code, _, errors, captured = self.invoke(
                    ['runtime-update', version, '--idempotency-key', JOB_ID])
                self.assertEqual(code, 2)
                self.assertIn('stable semver', errors)
                self.assertEqual(captured, [])

    def test_runtime_update_rejects_noncanonical_idempotency_key_before_http(self):
        for identifier in ('1' * 31, '1' * 33, 'g' * 32, 'A' * 32):
            with self.subTest(identifier=identifier):
                code, _, errors, captured = self.invoke(
                    ['runtime-update', '1.2.3', '--idempotency-key', identifier])
                self.assertEqual(code, 2)
                self.assertIn('32', errors)
                self.assertEqual(captured, [])

    def test_runtime_status_gets_collection_or_exact_job(self):
        for args, path in ((['runtime-status'], '/v1/runtime-updates'),
                           (['runtime-status', JOB_ID], '/v1/runtime-updates/' + JOB_ID)):
            with self.subTest(args=args):
                code, _, errors, captured = self.invoke(args)
                self.assertEqual(code, 0, errors)
                self.assert_request(captured, 'GET', path)

    def test_runtime_status_rejects_malformed_job_id_before_http(self):
        code, _, errors, captured = self.invoke(['runtime-status', 'short'])
        self.assertEqual(code, 2)
        self.assertIn('32', errors)
        self.assertEqual(captured, [])

    def test_runtime_help_is_offline_and_exposes_no_admin_controls(self):
        for command in ('runtime-update', 'runtime-status'):
            with self.subTest(command=command):
                result = subprocess.run(
                    ['/usr/bin/python3', str(ROOT / 'gate/client.py'), command, '--help'],
                    capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith('usage: pi-gate '), result.stdout)
                self.assertNotIn('runtime-approve', result.stdout)
                self.assertNotIn('runtime-policy', result.stdout)


class FakeAdminResponse:
    status = 200

    def read(self, limit):
        return b'{"ok": true}'


class FakeAdminConnection:
    def __init__(self, host, timeout):
        self.host = host
        self.timeout = timeout
        self.sock = None
        self.calls = []

    def request(self, method, path, body, headers):
        self.calls.append((method, path, body, headers))

    def getresponse(self):
        return FakeAdminResponse()

    def close(self):
        pass


class FakeUnixSocket:
    def __init__(self):
        self.timeout = None
        self.path = None

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, path):
        self.path = path


class BufferedInput:
    def __init__(self, value):
        self.buffer = io.BytesIO(json.dumps(value).encode())


class RuntimeAdminClientTest(unittest.TestCase):
    def invoke(self, args, payload=None):
        connections = []

        def connection(host, timeout):
            value = FakeAdminConnection(host, timeout)
            connections.append(value)
            return value

        output, errors = io.StringIO(), io.StringIO()
        stdin = BufferedInput(payload) if payload is not None else sys.stdin
        with mock.patch.object(sys, 'argv', ['gate.admin', '--state', '/private-state', *args]), \
                mock.patch.object(sys, 'stdin', stdin), \
                mock.patch.object(admin_module.http.client, 'HTTPConnection', side_effect=connection), \
                mock.patch.object(admin_module.socket, 'socket', side_effect=lambda *a, **k: FakeUnixSocket()), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                admin_module.main()
                code = 0
            except SystemExit as error:
                code = error.code
        return code, output.getvalue(), errors.getvalue(), connections

    def assert_admin_request(self, connections, method, path, value):
        self.assertEqual(len(connections), 1)
        connection = connections[0]
        self.assertEqual((connection.host, connection.timeout), ('localhost', 10))
        self.assertEqual(connection.sock.path, '/private-state/admin.sock')
        self.assertEqual(len(connection.calls), 1)
        actual_method, actual_path, body, headers = connection.calls[0]
        self.assertEqual((actual_method, actual_path), (method, path))
        self.assertEqual(json.loads(body) if body is not None else None, value)
        self.assertEqual(headers, {'Content-Type': 'application/json'})

    def test_runtime_updates_admin_query_maps_collection_and_job_paths(self):
        for args, path in ((['runtime-updates'], '/admin/runtime-updates'),
                           (['runtime-updates', JOB_ID], '/admin/runtime-updates/' + JOB_ID)):
            with self.subTest(args=args):
                code, _, errors, connections = self.invoke(args)
                self.assertEqual(code, 0, errors)
                self.assert_admin_request(connections, 'GET', path, None)

    def test_runtime_admin_mutations_accept_json_stdin_and_preserve_exact_payload(self):
        cases = (
            ('runtime-policy', {'mode': 'manual', 'images': [IMAGE]}),
            ('runtime-approve', {'id': JOB_ID}),
            ('runtime-reject', {'id': JOB_ID}),
            ('runtime-resolve', {'id': JOB_ID, 'acknowledge': 'inspected_no_mutation'}),
        )
        for command, payload in cases:
            with self.subTest(command=command):
                code, _, errors, connections = self.invoke([command, '--json-stdin'], payload)
                self.assertEqual(code, 0, errors)
                self.assert_admin_request(connections, 'POST', '/admin/' + command, payload)


class RuntimeHostClientTest(unittest.TestCase):
    def setUp(self):
        self.namespace = runpy.run_path(str(ROOT / 'gatectl'), run_name='gatectl_runtime_test')
        self.main = self.namespace['main']

    def invoke(self, args, callback):
        self.main.__globals__['admin'] = callback
        self.main.__globals__['docker'] = lambda *a, **k: self.fail('command reached Docker')
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['gatectl', *args]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                self.main()
                code = 0
            except SystemExit as error:
                code = error.code
        return code, output.getvalue(), errors.getvalue()

    def test_runtime_host_help_is_offline_for_every_new_command(self):
        for command in ('runtime-updates', 'runtime-policy', 'runtime-approve', 'runtime-reject',
                        'runtime-resolve'):
            with self.subTest(command=command):
                code, output, errors = self.invoke(
                    [command, '--help'], lambda *a, **k: self.fail('help reached admin'))
                self.assertEqual(code, 0, errors)
                self.assertIn(command, output)

    def test_runtime_host_commands_map_exact_admin_calls(self):
        calls = []

        def admin(*args, **kwargs):
            calls.append((args, kwargs))
            return {'ok': True}

        cases = (
            (['runtime-updates'], (('runtime-updates', None), {})),
            (['runtime-updates', JOB_ID], (('runtime-updates', JOB_ID), {})),
            (['runtime-policy', 'manual', '--image', IMAGE, '--image', 'sha256:' + 'b' * 64],
             (('runtime-policy',), {'payload': {
                 'mode': 'manual', 'images': [IMAGE, 'sha256:' + 'b' * 64]}})),
            (['runtime-approve', JOB_ID], (('runtime-approve',), {'payload': {'id': JOB_ID}})),
            (['runtime-reject', JOB_ID], (('runtime-reject',), {'payload': {'id': JOB_ID}})),
            (['runtime-resolve', JOB_ID, '--acknowledge', 'inspected_no_mutation'],
             (('runtime-resolve',), {'payload': {
                 'id': JOB_ID, 'acknowledge': 'inspected_no_mutation'}})),
        )
        for args, expected in cases:
            with self.subTest(args=args):
                code, _, errors = self.invoke(args, admin)
                self.assertEqual(code, 0, errors)
                self.assertEqual(calls[-1], expected)

    def test_runtime_host_rejects_malformed_ids_and_image_ids_before_admin(self):
        callback = lambda *a, **k: self.fail('invalid input reached admin')
        for args in (
                ['runtime-updates', 'short'],
                ['runtime-approve', 'f' * 31],
                ['runtime-reject', 'G' * 32],
                ['runtime-resolve', JOB_ID, '--acknowledge', 'wrong'],
                ['runtime-policy', 'manual', '--image', 'registry/image@sha256:' + 'a' * 64],
                ['runtime-policy', 'auto', '--image', 'sha256:' + 'A' * 64]):
            with self.subTest(args=args):
                code, _, _ = self.invoke(args, callback)
                self.assertEqual(code, 2)

    def test_gate_upgrade_refuses_any_active_runtime_update(self):
        check = self.namespace['check_upgrade_ready']
        check.__globals__['docker'] = lambda *args, **kwargs: (
            b'abc123\n' if args[0] == 'ps' else
            json.dumps([{'State': {'Running': True}}]).encode())
        check.__globals__['admin'] = lambda *args, **kwargs: {
            'requests': [],
            'lifecycle_active': [],
            'runtime_active': [{'id': JOB_ID, 'status': 'waiting_idle'}],
        }

        with self.assertRaisesRegex(RuntimeError, 'runtime|deployment or recovery active'):
            check()


if __name__ == '__main__':
    unittest.main()

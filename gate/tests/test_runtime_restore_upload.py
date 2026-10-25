"""Fixed upload receiver and real local Unix HTTP/upgrade boundary regressions."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from gate import engine, runtime_restore


CID, EXEC = 'c' * 64, 'e' * 64
HISTORY = b'{"type":"session","saved":"private-history-not-a-command"}\n'
ACK = b'pi-runtime-restore-upload-v1\n'


def envelope(data, **changed):
    metadata = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    metadata.update(changed)
    return json.dumps(metadata, separators=(',', ':')).encode() + b'\n' + data


def frame(data, stream=1):
    return bytes([stream, 0, 0, 0]) + len(data).to_bytes(4, 'big') + data


class FixedReceiver(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(engine, 'RESTORE_UPLOAD_RECEIVER'), 'fixed receiver is missing')
        self.tmp = tempfile.TemporaryDirectory(prefix='restore-receiver-')
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name) / 'input'
        self.directory.mkdir(mode=0o700)

    def receive(self, data, *, directory=None):
        # Execute the production receiver, changing only its fixed entrypoint's
        # private directory for local tests. No production path is touched.
        command = engine.RESTORE_UPLOAD_RECEIVER + '\nreceive(' + repr(str(directory or self.directory)) + ')\n'
        command = 'scope={"__name__":"receiver_test"}\nexec(' + repr(command) + ',scope)\n'
        return subprocess.run([sys.executable, '-I', '-c', command], input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4)

    def test_complete_verified_input_publishes_exact_history_then_fixed_marker(self):
        reply = self.receive(envelope(HISTORY))
        self.assertEqual(reply.returncode, 0, reply.stderr)
        self.assertEqual(reply.stdout, ACK)
        self.assertEqual(reply.stderr, b'')
        self.assertEqual((self.directory / 'session.jsonl').read_bytes(), HISTORY)
        self.assertEqual((self.directory / 'session.jsonl').stat().st_mode & 0o777, 0o400)
        self.assertEqual((self.directory / 'ready').read_bytes(), b'1')

    def test_short_changed_and_extra_input_never_publish_ready_or_echo_history(self):
        for name, data in [('short', envelope(HISTORY)[:-1]),
                           ('changed', envelope(HISTORY, sha256='a' * 64)),
                           ('extra', envelope(HISTORY) + b'extra')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                reply = self.receive(data, directory=directory)
                self.assertNotEqual(reply.returncode, 0)
                self.assertFalse((Path(directory) / 'ready').exists())
                self.assertEqual(reply.stdout, b'')
                self.assertEqual(reply.stderr, b'')

    def test_malformed_oversize_and_nonclosed_metadata_never_publish(self):
        for data in (envelope(HISTORY, bytes=64 * 1024 * 1024 + 1),
                     envelope(HISTORY, bytes=True), envelope(HISTORY, bytes=0),
                     envelope(HISTORY, sha256='unknown'), envelope(HISTORY, path='/elsewhere'),
                     b'not-json\n', b'x' * 1024 + b'\n',
                     b'{"bytes":1,"bytes":2,"sha256":"' + b'a' * 64 + b'"}\nx'):
            with self.subTest(data=data[:40]):
                reply = self.receive(data)
                self.assertNotEqual(reply.returncode, 0)
                self.assertFalse((self.directory / 'ready').exists())
                self.assertEqual(reply.stdout + reply.stderr, b'')

    def test_existing_files_links_and_nonprivate_directory_are_refused(self):
        victim = Path(self.tmp.name) / 'victim'
        victim.write_bytes(b'untouched')
        for kind in ('history', 'marker', 'extra', 'history-link', 'marker-link', 'directory-link', 'permissions'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                path = Path(directory)
                if kind in ('history', 'marker', 'extra'):
                    (path / {'history': 'session.jsonl', 'marker': 'ready', 'extra': 'unexpected'}[kind]).write_bytes(b'existing')
                elif kind in ('history-link', 'marker-link'):
                    (path / ('ready' if kind == 'marker-link' else 'session.jsonl')).symlink_to(victim)
                elif kind == 'directory-link':
                    link = path / 'link'
                    link.symlink_to(self.directory, target_is_directory=True)
                    path = link
                else:
                    path.chmod(0o755)
                reply = self.receive(envelope(HISTORY), directory=path)
                self.assertNotEqual(reply.returncode, 0)
                self.assertEqual(reply.stdout + reply.stderr, b'')
                self.assertEqual(victim.read_bytes(), b'untouched')
                if kind not in ('marker', 'marker-link'):
                    self.assertFalse((path / 'ready').exists())

    def test_ready_is_absent_until_input_eof_even_after_all_declared_bytes(self):
        command = engine.RESTORE_UPLOAD_RECEIVER + '\nreceive(' + repr(str(self.directory)) + ')\n'
        script = 'scope={"__name__":"receiver_test"}\nexec(' + repr(command) + ',scope)\n'
        process = subprocess.Popen([sys.executable, '-I', '-c', script], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(envelope(HISTORY))
            process.stdin.flush()
            end = time.monotonic() + 1
            while not (self.directory / 'session.jsonl').exists() and time.monotonic() < end:
                time.sleep(.005)
            self.assertTrue((self.directory / 'session.jsonl').exists(), 'receiver never consumed header')
            self.assertIsNone(process.poll())
            self.assertFalse((self.directory / 'ready').exists())
            process.stdin.close()
            process.wait(timeout=4)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(process.stdout.read(), ACK)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_receiver_has_its_own_finite_timeout_without_eof_or_more_input(self):
        command = engine.RESTORE_UPLOAD_RECEIVER + '\nreceive(' + repr(str(self.directory)) + ')\n'
        script = 'scope={"__name__":"receiver_test"}\nexec(' + repr(command) + ',scope)\n'
        process = subprocess.Popen([sys.executable, '-I', '-c', script], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(envelope(HISTORY))
            process.stdin.flush()
            process.wait(timeout=14)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(process.stdout.read() + process.stderr.read(), b'')
            self.assertFalse((self.directory / 'ready').exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_receiver_waits_for_the_fixed_private_directory_without_creating_it(self):
        directory = Path(self.tmp.name) / 'not-yet-created'
        create = threading.Timer(.05, lambda: directory.mkdir(mode=0o700))
        create.start()
        try:
            reply = self.receive(envelope(HISTORY), directory=directory)
            self.assertEqual((reply.returncode, reply.stdout, reply.stderr), (0, ACK, b''))
        finally:
            create.cancel()
            create.join()


class UnixDocker:
    """Only the expected create, hijacked start and exec inspect endpoints."""
    def __init__(self, directory, *, handshake=None, output=None, info=None, delay=0, trickle=False,
                 delay_stage='start', hold_open=False, read_input=True, trickle_output=False, created=None):
        self.path = str(Path(directory) / 'docker-test.sock')
        self.listener = socket.socket(socket.AF_UNIX)
        try:
            self.listener.bind(self.path)
        except BaseException:
            self.listener.close()
            raise
        self.listener.listen(4)
        self.listener.settimeout(.05)
        self.stop = threading.Event()
        self.calls, self.input, self.errors = [], b'', []
        self.handshake = handshake or b'HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
        self.output = frame(ACK) if output is None else output
        self.info = {'ID': EXEC, 'ContainerID': CID, 'Running': False, 'ExitCode': 0} if info is None else info
        self.delay, self.trickle = delay, trickle
        self.delay_stage, self.hold_open = delay_stage, hold_open
        self.read_input, self.trickle_output = read_input, trickle_output
        self.created = {'Id': EXEC} if created is None else created
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.listener.close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise AssertionError('synthetic Unix endpoint did not finish')
        if self.errors:
            raise AssertionError(self.errors)

    def serve(self):
        while not self.stop.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                with connection:
                    connection.settimeout(1)
                    raw = bytearray()
                    while not raw.endswith(b'\r\n\r\n'):
                        block = connection.recv(1)
                        if not block:
                            raise ConnectionResetError()
                        raw.extend(block)
                        if len(raw) > 16384:
                            raise AssertionError('request header oversized')
                    lines = raw.decode().split('\r\n')
                    method, path, _ = lines[0].split()
                    headers = dict(line.lower().split(': ', 1) for line in lines[1:] if ': ' in line)
                    body = bytearray()
                    while len(body) < int(headers.get('content-length', 0)):
                        block = connection.recv(int(headers['content-length']) - len(body))
                        if not block:
                            raise ConnectionResetError()
                        body.extend(block)
                    value = json.loads(body) if body else None
                    self.calls.append((method, path, value))
                    if path == '/v1.45/containers/' + CID + '/exec':
                        if self.delay_stage == 'create':
                            self.stop.wait(self.delay)
                        response = json.dumps(self.created).encode()
                    elif path == '/v1.45/exec/' + EXEC + '/start':
                        if self.delay and self.delay_stage == 'start':
                            self.stop.wait(self.delay)
                        if self.trickle:
                            for byte in self.handshake:
                                connection.sendall(bytes([byte]))
                                if self.stop.wait(.025):
                                    return
                        else:
                            connection.sendall(self.handshake)
                        if not self.read_input:
                            self.stop.wait(1)
                            continue
                        while True:
                            data = connection.recv(65536)
                            if not data:
                                break
                            self.input += data
                        if self.trickle_output:
                            for byte in self.output:
                                connection.sendall(bytes([byte]))
                                if self.stop.wait(.025):
                                    return
                        else:
                            connection.sendall(self.output)
                        if self.hold_open:
                            self.stop.wait(1)
                        continue
                    elif path == '/v1.45/exec/' + EXEC + '/json':
                        if self.delay_stage == 'inspect':
                            self.stop.wait(self.delay)
                        response = json.dumps(self.info).encode()
                    else:
                        raise AssertionError('unexpected Docker endpoint: ' + path)
                    connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(response)).encode() +
                                       b'\r\nConnection: close\r\n\r\n' + response)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Expected when the fixed client rejects uncertain input.
            except Exception as error:
                self.errors.append(repr(error))


class UploadTransport(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(engine.Engine, 'restore_upload'), 'exec stdin transport is missing')
        self.tmp = tempfile.TemporaryDirectory(prefix='restore-upload-')
        self.addCleanup(self.tmp.cleanup)

    def endpoint(self, **kwargs):
        endpoint = UnixDocker(self.tmp.name, **kwargs)
        self.addCleanup(endpoint.close)
        return endpoint

    def upload(self, endpoint, **kwargs):
        arguments = {'byte_count': len(HISTORY), 'sha256': hashlib.sha256(HISTORY).hexdigest(), 'timeout': 1}
        arguments.update(kwargs)
        return engine.Engine(endpoint.path).restore_upload(CID, HISTORY, **arguments)

    def test_fixed_exec_uses_stdin_only_and_requires_matching_stopped_exit_zero(self):
        endpoint = self.endpoint()
        self.upload(endpoint)
        self.assertEqual(endpoint.input, envelope(HISTORY))
        self.assertEqual([(m, p) for m, p, _ in endpoint.calls], [
            ('POST', '/v1.45/containers/' + CID + '/exec'),
            ('POST', '/v1.45/exec/' + EXEC + '/start'), ('GET', '/v1.45/exec/' + EXEC + '/json')])
        definition = endpoint.calls[0][2]
        self.assertEqual(definition['Cmd'], ['/usr/bin/python3', '-I', '-c', engine.RESTORE_UPLOAD_RECEIVER])
        self.assertEqual(definition['User'], '1000:1000')
        self.assertIs(definition['Privileged'], False)
        self.assertIs(definition['Tty'], False)
        self.assertIs(definition['AttachStdin'], True)
        self.assertEqual(definition['Env'], ['HOME=/tmp', 'PATH=/usr/bin:/bin', 'NODE_OPTIONS=',
                                            'PYTHONNOUSERSITE=1', 'PYTHONSAFEPATH=1',
                                            'PYTHONDONTWRITEBYTECODE=1'])
        self.assertNotIn(b'private-history-not-a-command', json.dumps(endpoint.calls).encode())

    def test_invalid_arguments_refuse_before_any_socket_or_dispatch(self):
        client = engine.Engine('/nonexistent/never-connect')
        for changed in ({'container_id': 'helper-name'}, {'byte_count': True}, {'byte_count': 0},
                        {'byte_count': 64 * 1024 * 1024 + 1}, {'byte_count': len(HISTORY) + 1},
                        {'sha256': 'f' * 64}, {'sha256': 'bad'}, {'timeout': 0}, {'timeout': float('nan')}):
            with self.subTest(changed=changed):
                args = {'container_id': CID, 'data': HISTORY, 'byte_count': len(HISTORY),
                        'sha256': hashlib.sha256(HISTORY).hexdigest(), 'timeout': 1}
                args.update(changed)
                with self.assertRaises((ValueError, engine.DockerError)):
                    client.restore_upload(**args)

    def test_bad_handshake_never_sends_history_and_dispatches_start_once(self):
        endpoint = self.endpoint(handshake=b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
        with self.assertRaises(engine.DockerError):
            self.upload(endpoint)
        self.assertEqual(endpoint.input, b'')
        self.assertEqual(sum(p.endswith('/start') for _, p, _ in endpoint.calls), 1)

    def test_missing_or_mutable_exec_identity_never_dispatches_start(self):
        for created in ({}, {'Id': 'exec-name'}, [], {'Id': None}):
            with self.subTest(created=created), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                endpoint = UnixDocker(directory, created=created)
                try:
                    with self.assertRaises(engine.DockerError):
                        self.upload(endpoint)
                    self.assertEqual(len(endpoint.calls), 1)
                    self.assertEqual(endpoint.input, b'')
                finally:
                    endpoint.close()

    def test_fragmented_stdout_acknowledgment_is_accepted_without_buffered_read_ahead(self):
        endpoint = self.endpoint(output=b''.join(frame(bytes([byte])) for byte in ACK))
        self.upload(endpoint)
        self.assertEqual(endpoint.input, envelope(HISTORY))

    def test_stderr_malformed_oversize_and_inexact_receipts_are_never_accepted(self):
        for name, output in [('stderr', frame(b'private-history-not-a-command', 2)),
                             ('oversize', frame(b'x' * 16385)), ('bad-stream', frame(ACK, 3)),
                             ('short-frame', frame(ACK)[:-1]), ('wrong-ack', frame(b'wrong\n')),
                             ('extra-ack', frame(ACK + b'extra')), ('empty', b'')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                endpoint = UnixDocker(directory, output=output)
                try:
                    with self.assertRaises(engine.DockerError) as error:
                        self.upload(endpoint)
                    self.assertNotIn('private-history-not-a-command', str(error.exception))
                    self.assertEqual(sum(p.endswith('/start') for _, p, _ in endpoint.calls), 1)
                finally:
                    endpoint.close()

    def test_ambiguous_exit_status_or_wrong_exec_identity_refuses_without_retry(self):
        for changed in ({'Running': True}, {'ExitCode': 1}, {'ExitCode': None}, {'ExitCode': False},
                        {'ID': 'f' * 64}, {'ContainerID': 'd' * 64}):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                endpoint = UnixDocker(directory, info={'ID': EXEC, 'ContainerID': CID,
                    'Running': False, 'ExitCode': 0, **changed})
                try:
                    with self.assertRaises(engine.DockerError):
                        self.upload(endpoint)
                    self.assertEqual(sum(p.endswith('/start') for _, p, _ in endpoint.calls), 1)
                finally:
                    endpoint.close()

    def test_slow_header_is_bounded_by_total_deadline_not_activity(self):
        endpoint = self.endpoint(trickle=True)
        started = time.monotonic()
        with self.assertRaises(engine.DockerError):
            self.upload(endpoint, timeout=.15)
        self.assertLess(time.monotonic() - started, .6)
        self.assertEqual(endpoint.input, b'')
        self.assertEqual(sum(p.endswith('/start') for _, p, _ in endpoint.calls), 1)

    def test_create_send_output_eof_and_inspect_timeouts_never_redispatch(self):
        for stage, options in [('create', {'delay': .4, 'delay_stage': 'create'}),
                               ('send', {'read_input': False}), ('eof', {'hold_open': True}),
                               ('inspect', {'delay': .4, 'delay_stage': 'inspect'}),
                               ('output', {'trickle_output': True})]:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
                endpoint = UnixDocker(directory, **options)
                try:
                    data = b'x' * (8 * 1024 * 1024) if stage == 'send' else HISTORY
                    started = time.monotonic()
                    with self.assertRaises(engine.DockerError):
                        engine.Engine(endpoint.path).restore_upload(CID, data, byte_count=len(data),
                            sha256=hashlib.sha256(data).hexdigest(), timeout=.15)
                    self.assertLess(time.monotonic() - started, .7)
                    self.assertLessEqual(sum(p.endswith('/start') for _, p, _ in endpoint.calls), 1)
                finally:
                    endpoint.close()


class RestoreUploadBoundary(unittest.TestCase):
    def test_pre_stop_upload_is_once_after_inspection_and_failure_never_reaches_restart(self):
        # Real prepare_refresh orchestration; only external Docker/lifecycle
        # boundaries are doubled. The history is carried only by restore_upload.
        events, ledger = [], []
        job = {'id': 'a' * 32, 'run_id': 'b' * 32, 'runtime_id': 'runtime',
               'session_id': 'session', 'leaf_id': None, 'runtime_update_id': 'd' * 32,
               'policy': {}, 'target_hash': 'e' * 64}
        snapshot = {**{k: job[k] for k in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                    'session_file': '/private/session.jsonl', 'cwd': '/workspace', 'version': '1.3.0',
                    'idle': True, 'pending': False, 'busy': False, 'provider': 'faux',
                    'model': 'model', 'thinking': 'medium'}
        frozen = {'contract': 'pi-runtime-restore-v1', 'operation_id': job['id'],
                  'bytes': len(HISTORY), 'sha256': hashlib.sha256(HISTORY).hexdigest(),
                  'session_format': 3, 'snapshot': snapshot}
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as output:
            member = tarfile.TarInfo('session.jsonl')
            member.size = len(HISTORY)
            output.addfile(member, io.BytesIO(HISTORY))
        def call(method, path, **kwargs):
            events.append((method, path))
            if method == 'GET' and '/archive?' in path:
                return archive.getvalue()
            if method == 'DELETE':
                return
            raise AssertionError('archive upload or unexpected Docker mutation')
        def control(cid, request, **kwargs):
            events.append(('control', request['action']))
            if request['action'] == 'prepare_restore':
                return {'ok': True, 'result': frozen}
            if request['action'] == 'cancel_restore':
                return {'ok': True, 'result': {'cancelled': True}}
            raise AssertionError('source stop must never happen')
        def upload(cid, data, **kwargs):
            events.append(('upload', cid))
            self.assertEqual(events[-2], ('inspect', CID))
            self.assertEqual(data, HISTORY)
            self.assertEqual(kwargs['byte_count'], len(HISTORY))
            self.assertEqual(kwargs['sha256'], hashlib.sha256(HISTORY).hexdigest())
            raise engine.DockerError('uncertain upload')
        def update(key, **changes):
            ledger.append(copy.deepcopy(changes))
            job.update(changes)
            return copy.deepcopy(job)
        docker = SimpleNamespace(call=call, lifecycle_control=control, restore_upload=upload)
        parent = {'id': 'd' * 32, 'version': '1.4.0', 'profile': {}}
        life = SimpleNamespace(gate=SimpleNamespace(runtime_volume='pi-runtime',
            runtime_updates=SimpleNamespace(_get=lambda _key: parent)),
            _policy_fence=lambda _job: None, _engine=lambda: docker,
            _update=update, clock=SimpleNamespace(time=lambda: 1))
        def inspect(*args):
            events.append(('inspect', CID))
            return {'Id': CID, 'State': {'Status': 'running', 'Running': True}}
        with patch.object(runtime_restore, 'source_identity', return_value={'version': '1.3.0'}), \
                patch.object(runtime_restore.RestoreEngine, 'create', return_value=CID), \
                patch.object(runtime_restore.RestoreEngine, 'start'), \
                patch.object(runtime_restore.RestoreEngine, 'inspect', side_effect=inspect):
            with self.assertRaisesRegex(engine.DockerError, 'uncertain upload'):
                runtime_restore.prepare_refresh(life, copy.deepcopy(job), {'Id': 'f' * 64}, snapshot,
                                                SimpleNamespace(remaining=lambda: 100))
        self.assertEqual(sum(event[0] == 'upload' for event in events), 1)
        self.assertIn(('control', 'cancel_restore'), events)
        self.assertNotIn(b'private-history-not-a-command', json.dumps(ledger).encode())


if __name__ == '__main__':
    unittest.main()

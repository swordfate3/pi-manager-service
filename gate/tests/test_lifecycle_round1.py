"""Executable regressions for Task2 R1/R2/R3; no live services."""
import copy
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from gate.lifecycle_contract import trusted
from gate.service import start_servers
from test_lifecycle import Gate
import test_lifecycle
from test_lifecycle import BODY, CID, IMAGE, KEY, RUN, FakeEngine


class InterpreterProvenanceTest(unittest.TestCase):
    def test_writable_substitute_cache_cannot_reach_fixed_control(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / 'cache'
            # Build the fixture with the actual control interpreter. The test
            # runner may be a different Python version with a different stdlib
            # path, bytecode magic and marshal format.
            builder = '''import importlib.util, json, marshal, pathlib, struct, sys
sys.pycache_prefix = sys.argv[1]
bytecode = pathlib.Path(importlib.util.cache_from_source(json.__file__))
bytecode.parent.mkdir(parents=True)
code = compile('print("SUBSTITUTE_CACHE_EXECUTED")', json.__file__, 'exec')
bytecode.write_bytes(importlib.util.MAGIC_NUMBER + struct.pack('<I', 1) + b'12345678' + marshal.dumps(code))
'''
            subprocess.run(['/usr/bin/python3', '-I', '-c', builder, str(cache)],
                           capture_output=True, text=True, timeout=3, check=True)
            environment = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                           'PYTHONNOUSERSITE': '1', 'PYTHONSAFEPATH': '1',
                           'PYTHONPYCACHEPREFIX': str(cache)}
            exploited = subprocess.run(['/usr/bin/python3', '-B', '-c', 'import json'],
                                       env=environment, capture_output=True, text=True, timeout=3)
            self.assertEqual(exploited.returncode, 0, exploited.stderr)
            self.assertIn('SUBSTITUTE_CACHE_EXECUTED', exploited.stdout)
            engine = FakeEngine()
            engine.item['Config']['Env'] = [k + '=' + v for k, v in environment.items()]
            with GateContext(Path(directory) / 'state', engine) as gate:
                self.assertEqual(gate.lifecycle.target(RUN), {'managed': False})
                with self.assertRaises(RuntimeError):
                    gate.lifecycle.submit(BODY)
                self.assertEqual(engine.calls, [])

    def test_interpreter_environment_is_closed_not_a_partial_denylist(self):
        original = FakeEngine().item
        for setting in ('PYTHONPYCACHEPREFIX=/workspace/cache', 'PYTHONUSERBASE=/workspace',
                        'PYTHONPLATLIBDIR=lib-other', 'PYTHONINSPECT=1', 'PYTHONWARNINGS=ignore:msg:json.X',
                        'PYTHONSTARTUP=/workspace/start.py', 'PYTHONEXECUTABLE=/workspace/python',
                        '_PYTHON_SYSCONFIGDATA_NAME=evil', 'PYTHONFUTUREOPTION=unreviewed'):
            with self.subTest(setting=setting):
                item = copy.deepcopy(original)
                item['Config']['Env'] = [setting]
                with self.assertRaises(RuntimeError):
                    trusted(item, RUN, [IMAGE])
        original['Config']['Env'] = ['PYTHON=/usr/bin/python3', 'PYTHONUNBUFFERED=1',
                                     'PYTHONDONTWRITEBYTECODE=1']
        self.assertEqual(trusted(original, RUN, [IMAGE])['Id'], CID)


class GateContext:
    def __init__(self, directory, engine=None):
        self.directory, self.engine = directory, engine or FakeEngine()

    def __enter__(self):
        self.gate = Gate(self.directory)
        self.gate.lifecycle.engine = self.engine
        self.gate.lifecycle.set_policy({'mode': 'auto', 'images': [IMAGE]})
        return self.gate

    def __exit__(self, *_):
        self.gate.close()


class UpgradeReservationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gate = Gate(Path(self.tmp.name))
        self.gate.lifecycle.engine = FakeEngine()
        self.gate.lifecycle.set_policy({'mode': 'auto', 'images': [IMAGE]})
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.gate.close())

    def reserve(self):
        self.assertTrue(hasattr(self.gate, 'reserve_upgrade'), 'missing atomic upgrade reservation')
        return self.gate.reserve_upgrade(IMAGE)

    def test_reservation_is_durable_blocks_admission_and_never_clears_on_startup(self):
        reservation = self.reserve()
        key = reservation['id']
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': '1' * 40})
        with self.assertRaises(RuntimeError):
            self.gate.lifecycle.submit(BODY)
        with self.assertRaises(RuntimeError):
            self.gate.reserve_upgrade(IMAGE)
        with self.assertRaises(RuntimeError):
            self.gate.release_upgrade(key, 'finish')  # Same instance did not replace itself.
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        self.assertEqual(self.gate.store.upgrade_reservation()['id'], key)
        self.gate.lifecycle.recover()
        self.gate.tick()
        self.assertIsNone(self.gate.worker)
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': '2' * 40})
        with self.assertRaises(RuntimeError):
            self.gate.release_upgrade('f' * 32, 'finish')
        self.gate.release_upgrade(key, 'finish')
        self.assertIsNone(self.gate.store.upgrade_reservation())
        self.assertEqual(self.gate.submit({'commit': '2' * 40})['status'], 'pending')

    def test_unresolved_lifecycle_or_queued_deployment_prevents_reservation(self):
        self.assertTrue(hasattr(self.gate, 'reserve_upgrade'), 'missing atomic upgrade reservation')
        self.gate.lifecycle.submit(BODY)
        for status in ('pending', 'queued', 'failed', 'recovery_required'):
            with self.subTest(status=status):
                self.gate.lifecycle._update(KEY, status=status)
                with self.assertRaises(RuntimeError):
                    self.gate.reserve_upgrade(IMAGE)
        self.gate.lifecycle._update(KEY, status='rejected')
        job = self.gate.store.request('1' * 40)
        with self.assertRaises(RuntimeError):
            self.gate.reserve_upgrade(IMAGE)
        self.gate.store.update(job['id'], status='queued')
        with self.assertRaises(RuntimeError):
            self.gate.reserve_upgrade(IMAGE)

    def test_explicit_abort_matches_reservation_and_is_audited(self):
        reservation = self.reserve()
        self.gate.release_upgrade(reservation['id'], 'abort')
        self.assertIsNone(self.gate.store.upgrade_reservation())
        self.assertEqual(self.gate.store.events()[0]['action'], 'upgrade_aborted')
        self.assertEqual(self.gate.lifecycle.submit(BODY)['status'], 'queued')

    def test_all_dispatch_and_worker_admission_paths_honor_reservation(self):
        # Prepare terminal historical rollback and detached queued job objects before reserving.
        old = self.gate.store.request('1' * 40)
        self.gate.store.update(old['id'], status='deployed', old_id='old', new_id='new')
        reservation = self.reserve()
        with self.assertRaises(RuntimeError):
            self.gate.rollback(old['id'], commit='1' * 40)
        with self.assertRaises(RuntimeError):
            self.gate.verify_execution(old)
        self.gate.tick()
        self.assertIsNone(self.gate.worker)
        self.assertEqual(self.gate.store.upgrade_reservation()['id'], reservation['id'])

    def host(self):
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        main = namespace['main']
        main.__globals__['docker'] = lambda *a, **k: b'id' if a[0] == 'ps' else json.dumps([
            {'State': {'Running': True}, 'Image': IMAGE}]).encode()
        main.__globals__['verified_image'] = lambda *a: IMAGE
        return main

    def test_intervening_unknown_outcome_after_idle_snapshot_vetoes_replacement(self):
        main = self.host()
        def admin(command, *args, **kwargs):
            if command == 'status':
                self.gate.lifecycle.submit(BODY)
                self.gate.lifecycle._update(KEY, status='recovery_required', stage='control_outcome_unknown')
                return {'requests': [], 'active': [], 'lifecycle_active': []}
            if command == 'upgrade-reserve':
                return self.gate.reserve_upgrade(kwargs['payload']['image'])
            self.fail('unexpected host command ' + command)
        main.__globals__['admin'] = admin
        with mock.patch.object(sys, 'argv', ['gatectl', 'up']), mock.patch('subprocess.run') as replacement:
            with self.assertRaises(RuntimeError):
                main()
            replacement.assert_not_called()

    def test_old_gate_without_reservation_api_cannot_fallback_to_snapshot(self):
        main = self.host()
        def admin(command, *args, **kwargs):
            if command == 'status':
                return {'requests': [], 'active': [], 'lifecycle_active': []}
            raise RuntimeError('old Gate: unsupported private API')
        main.__globals__['admin'] = admin
        with mock.patch.object(sys, 'argv', ['gatectl', 'up']), mock.patch('subprocess.run') as replacement:
            with self.assertRaisesRegex(RuntimeError, 'migration'):
                main()
            replacement.assert_not_called()

    def test_failed_replacement_keeps_reservation_for_explicit_abort(self):
        self.assertTrue(hasattr(self.gate, 'reserve_upgrade'), 'missing atomic upgrade reservation')
        main = self.host()
        def admin(command, *args, **kwargs):
            if command == 'status':
                return {'requests': [], 'active': [], 'lifecycle_active': []}
            if command == 'upgrade-reserve':
                return self.gate.reserve_upgrade(kwargs['payload']['image'])
            self.fail('failure path must not auto-release reservation')
        main.__globals__['admin'] = admin
        with mock.patch.object(sys, 'argv', ['gatectl', 'up']), mock.patch(
                'subprocess.run', side_effect=RuntimeError('fake replacement failure')):
            with self.assertRaises(RuntimeError):
                main()
        self.assertIsNotNone(self.gate.store.upgrade_reservation())
        with self.assertRaises(RuntimeError):
            self.gate.lifecycle.submit(BODY)

    def test_reservation_wins_during_lifecycle_inspection_and_rollback_inspection(self):
        self.gate.lifecycle.engine.on_status = lambda: self.reserve()
        with self.assertRaises(RuntimeError):
            self.gate.lifecycle.submit(BODY)
        self.assertEqual(self.gate.lifecycle.jobs(), [])
        self.gate.release_upgrade(self.gate.store.upgrade_reservation()['id'], 'abort')
        old = self.gate.store.request('1' * 40)
        self.gate.store.update(old['id'], status='deployed', old_id='old', new_id='new')
        def inspect(target):
            self.reserve()
            return {'Id': 'new'}
        self.gate.deployer = SimpleNamespace(policy={'target': 'hub'}, engine=SimpleNamespace(inspect=inspect))
        with self.assertRaises(RuntimeError):
            self.gate.rollback(old['id'], commit='1' * 40)
        self.assertEqual(self.gate.store.get(old['id'])['status'], 'deployed')
        self.assertIsNone(self.gate.worker)

    def test_successful_replacement_releases_only_on_verified_new_instance(self):
        main = self.host()
        def admin(command, *args, **kwargs):
            if command == 'status':
                return {'requests': [], 'active': [], 'lifecycle_active': []}
            if command == 'upgrade-reserve':
                return self.gate.reserve_upgrade(kwargs['payload']['image'])
            if command == 'upgrade-status':
                return self.gate.upgrade_status()
            if command == 'upgrade-finish':
                return self.gate.release_upgrade(kwargs['payload']['id'], 'finish')
            self.fail('unexpected command ' + command)
        def replace(*args, **kwargs):
            self.assertIsNotNone(self.gate.store.upgrade_reservation())
            with self.assertRaises(RuntimeError):
                self.gate.lifecycle.submit(BODY)
            self.gate.close()
            self.gate = Gate(Path(self.tmp.name))
        main.__globals__['admin'] = admin
        with mock.patch.object(sys, 'argv', ['gatectl', 'up']), mock.patch('subprocess.run', side_effect=replace):
            main()
        self.assertIsNone(self.gate.store.upgrade_reservation())
        self.assertEqual(self.gate.store.events()[0]['action'], 'upgrade_finished')

    def test_release_refuses_unresolved_state_even_after_restart(self):
        reservation = self.reserve()
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        # Simulate persisted unresolved state; normal admission is already fenced.
        with mock.patch.object(self.gate.lifecycle, 'active', return_value=[{'status': 'recovery_required'}]):
            for action in ('finish', 'abort'):
                with self.assertRaises(RuntimeError):
                    self.gate.release_upgrade(reservation['id'], action)
        self.assertEqual(self.gate.store.upgrade_reservation(), reservation)


class UpgradeHTTPTest(unittest.TestCase):
    request = test_lifecycle.LifecycleHTTPTest.request

    def test_private_transport_and_public_denial_and_explicit_abort(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(self.gate.close)
        self.http, admin_server = start_servers(self.gate, port=0)
        for server in (self.http, admin_server):
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        def invoke(command, payload=None):
            args = ['/usr/bin/python3', '-m', 'gate.admin', '--state', self.tmp.name, command]
            if payload is not None:
                args.append('--json-stdin')
            result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        for route in ('upgrade-status', 'upgrade-reserve', 'upgrade-finish', 'upgrade-abort'):
            self.assertEqual(self.request('GET' if route == 'upgrade-status' else 'POST',
                                          '/admin/' + route, {}, self.gate.token)[0], 404)
        reservation = invoke('upgrade-reserve', {'image': IMAGE})
        self.assertEqual(invoke('upgrade-status')['reservation'], reservation)
        self.assertEqual(self.request('POST', '/admin/upgrade-abort',
                                      {'id': reservation['id'], 'acknowledge': 'yes'}, admin=True)[0], 400)
        self.assertIsNotNone(self.gate.store.upgrade_reservation())
        self.assertEqual(invoke('upgrade-abort', {'id': reservation['id'],
                         'acknowledge': 'inspected_no_replacement'})['status'], 'aborted')
        self.assertIsNone(invoke('upgrade-status')['reservation'])


class FakeClock:
    def __init__(self):
        self.wall, self.mono = 1800000000.0, 1000.0

    def time(self):
        return self.wall

    def monotonic(self):
        return self.mono

    def sleep(self, seconds):
        self.advance(seconds)

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds


class LifecycleDeadlineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gate = Gate(Path(self.tmp.name))
        self.clock = FakeClock()
        self.life = self.gate.lifecycle
        self.life.clock = self.clock
        self.engine = FakeEngine()
        self.life.engine = self.engine
        self.life.set_policy({'mode': 'auto', 'images': [IMAGE]})
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.gate.close())

    def running(self):
        self.life.submit(BODY)
        start = int(self.clock.time() * 1000)
        self.life._update(KEY, status='running', stage='checking', started_at=start, intent_at=start)
        self.engine.operation = dict(operation_id=KEY, status='running', stage='checking',
                                     old_runtime_id='runtime-old', session_id='session', leaf_id=None)
        return self.life._get(KEY)

    def success(self):
        self.engine.operation.update(status='succeeded', stage='complete', new_runtime_id='runtime-new',
                                     old_version='1.0.0', expected_version='2.0.0', new_version='2.0.0')
        self.engine.snapshot.update(runtime_id='runtime-new', version='2.0.0')

    def test_in_envelope_success_at_160_seconds_is_not_cut_off_at_155(self):
        job = self.running()
        self.clock.advance(154)
        def observe():
            # preflight2 + checking10 + stop29 + readiness119 =160, all in budget.
            if self.clock.monotonic() >= 1160:
                self.success()
        self.engine.on_status = observe
        self.life._poll(job)
        self.assertEqual(self.life.get(KEY)['status'], 'succeeded')
        self.assertEqual(self.life.get(KEY)['started_at'], job['started_at'])
        self.assertGreaterEqual(self.clock.monotonic(), 1160)
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_polling_expires_at_210_without_extending_timestamp(self):
        job = self.running()
        self.clock.advance(209)
        self.life._poll(job)
        self.assertAlmostEqual(self.clock.monotonic(), 1210)
        self.assertEqual(self.life.get(KEY)['status'], 'recovery_required')
        self.assertEqual(self.life.get(KEY)['started_at'], job['started_at'])

    def test_reopened_gate_uses_only_remaining_execution_budget(self):
        job = self.running()
        self.clock.advance(209)
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        self.life = self.gate.lifecycle
        self.life.clock, self.life.engine = self.clock, self.engine
        self.life.recover()
        self.life._poll(self.life._get(KEY))
        self.assertAlmostEqual(self.clock.monotonic(), 1210)
        self.assertEqual(self.life.get(KEY)['started_at'], job['started_at'])
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_each_step_uses_remaining_budget_and_late_result_is_not_success(self):
        job = self.running()
        self.clock.advance(209.6)
        calls = []
        def inspect(identifier, timeout=None):
            calls.append(timeout)
            self.clock.advance(0.25)
            return copy.deepcopy(self.engine.item)
        def status(identifier, request, timeout=None):
            calls.append(timeout)
            self.clock.advance(0.2)
            self.success()
            return {'ok': True, 'result': {**self.engine.snapshot, 'operation': self.engine.operation}}
        self.engine.inspect, self.engine.lifecycle_control = inspect, status
        self.life._poll(job)
        self.assertEqual(len(calls), 2)
        self.assertAlmostEqual(calls[0], .4, places=4)
        self.assertAlmostEqual(calls[1], .15, places=4)
        self.assertEqual(self.life.get(KEY)['status'], 'recovery_required')

    def test_preflight_deadline_is_checked_after_last_inspection_before_restart(self):
        job = self.running()
        count = 0
        def inspect(identifier, timeout=None):
            nonlocal count
            count += 1
            if count == 2:
                self.clock.advance(4.1)
            return copy.deepcopy(self.engine.item)
        self.engine.inspect = inspect
        self.life._execute(job)
        self.assertEqual(self.life.get(KEY)['status'], 'stale')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_acknowledgment_cannot_borrow_past_its_three_second_cap(self):
        job = self.running()
        original = self.engine.lifecycle_control
        def control(identifier, request, timeout=None):
            if request['action'] == 'restart':
                self.clock.advance(3.1)
            return original(identifier, request, timeout)
        self.engine.lifecycle_control = control
        self.life._execute(job)
        self.assertEqual(self.life.get(KEY)['status'], 'recovery_required')

    def test_individual_transport_cannot_borrow_the_four_second_query_budget(self):
        for method in ('inspect', 'lifecycle_control'):
            with self.subTest(method=method):
                original = getattr(self.engine, method)
                def late(*args, **kwargs):
                    self.clock.advance(3.1)
                    return original(*args, **kwargs)
                with mock.patch.object(self.engine, method, side_effect=late):
                    self.assertEqual(self.life.target(RUN), {'managed': False})

    def test_backward_wall_jump_during_ack_does_not_reset_monotonic_outer_cap(self):
        job = self.running()
        original = self.engine.lifecycle_control
        def control(identifier, request, timeout=None):
            value = original(identifier, request, timeout)
            if request['action'] == 'restart':
                self.clock.advance(2)
                self.clock.wall -= 60
                self.engine.operation['status'] = 'running'
                self.engine.operation['stage'] = 'checking'
            return value
        self.engine.lifecycle_control = control
        self.life._execute(job)
        self.assertAlmostEqual(self.clock.monotonic(), 1210)
        self.assertEqual(self.life.get(KEY)['status'], 'recovery_required')
        self.assertEqual(self.life.get(KEY)['started_at'], job['started_at'])

    def test_forward_wall_jump_cannot_accept_late_success(self):
        job = self.running()
        def observe():
            self.clock.wall += 211
            self.success()
        self.engine.on_status = observe
        self.life._poll(job)
        self.assertEqual(self.life.get(KEY)['status'], 'recovery_required')

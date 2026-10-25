"""Real supervisor/capture decisions with only IPC and process boundaries doubled."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch


RUNTIME = Path(__file__).parents[2] / 'runtime'


def load(name):
    spec = importlib.util.spec_from_file_location('fence_' + name, RUNTIME / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Child:
    def __init__(self, on_exit=None):
        self.signals = []
        self.exited = False
        self.on_exit = on_exit

    def poll(self):
        return 0 if self.exited else None

    def send_signal(self, signum):
        self.signals.append(signum)

    def wait(self, timeout):
        if self.on_exit:
            self.on_exit()
        self.exited = True
        return 0


class SupervisorFences(unittest.TestCase):
    def setUp(self):
        self.module = load('pi_supervisor')
        self.identity = load('runtime_identity')
        self.sessions = load('runtime_session')
        self.temporary = tempfile.TemporaryDirectory(prefix='pi-supervisor-fence-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.releases = self.root / 'releases'
        self.task = 'c' * 32
        self.target = self.release(self.releases / self.task, '1.4.0')
        self.other = self.release(self.releases / ('d' * 32), '1.4.0')
        self.source = self.release(self.root / 'old', '1.3.0')
        (self.root / 'bin').mkdir()
        self.entry = self.root / 'bin/pi'
        self.entry.symlink_to(self.target / 'bin/pi')
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.session = self.root / 'session.jsonl'
        self.session.write_text(json.dumps({'type': 'session', 'version': 3,
                                          'id': 'saved-session', 'cwd': str(self.root)}) + '\n')
        with patch.dict(os.environ, {'PI_RUNTIME_RUN_ID': 'a' * 32,
                                    'PI_RUNTIME_DIR': str(self.private), 'NODE_OPTIONS': ''}):
            self.supervisor = self.module.PiSupervisor([str(self.entry), '--offline'], 1, 1)
        self.now = [100.0]
        self.clock = lambda: self.now[0]
        self.frozen = {'run_id': 'a' * 32, 'runtime_id': 'old-runtime', 'session_id': 'saved-session',
                       'leaf_id': None, 'session_file': str(self.session), 'cwd': str(self.root),
                       'version': '1.3.0', 'idle': True, 'pending': False, 'busy': False,
                       'provider': 'faux', 'model': 'faux-1', 'thinking': 'medium'}
        self.live = copy.deepcopy(self.frozen)
        self.successor = {**self.frozen, 'runtime_id': 'new-runtime', 'version': '1.4.0'}
        self.old = Child()
        self.new = Child()
        self.supervisor.child = self.old
        self.supervisor.source_identity = self.identity.measure_package(self.source / 'bin/pi')
        self.capture = self.sessions.SessionCapture(self.private, self.frozen, 'b' * 32, clock=self.clock)
        self.supervisor.restore_capture = self.capture
        self.addCleanup(self.capture.close)
        self.supervisor.snapshot = lambda: copy.deepcopy(
            self.live if self.supervisor.child is self.old else self.successor)
        self.extension_actions = []

        def extension(request):
            self.extension_actions.append(request['action'])
            return copy.deepcopy(self.live)

        self.supervisor.extension_request = extension
        self.supervisor.sync_models_bounded = lambda _timeout: None
        self.proof = {'session_sha256': self.capture.sha256,
                      'expected_hash': self.module.content_digest(self.frozen),
                      'source_hash': self.module.content_digest(self.supervisor.source_identity),
                      'target_tree_sha256': self.identity.tree_digest(self.target),
                      'target_task': self.task, 'version': '1.4.0', 'profile_hash': 'e' * 64}
        self.request = {**{key: self.frozen[key] for key in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                        'action': 'restart', 'operation_id': 'b' * 32, 'restore_proof': self.proof}
        self.launches = []
        self.hash_count = 0
        self.after_hash = None
        original_tree = self.identity.tree_digest

        def measured_tree(path):
            result = original_tree(path)
            if Path(path) == self.target:
                self.hash_count += 1
                if self.after_hash:
                    self.after_hash(self.hash_count)
            return result

        self.identity.tree_digest = measured_tree

    def release(self, prefix, version):
        package = prefix / 'lib/node_modules/@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({
            'name': '@earendil-works/pi-coding-agent', 'version': version,
            'engines': {'node': '>=24.0.0'}, 'bin': {'pi': 'cli.js'}}))
        (package / 'cli.js').write_text('// never executed by these unit tests\n')
        (package / 'dependency.js').write_text(str(prefix))
        (prefix / 'bin').mkdir()
        (prefix / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')
        return prefix

    def run_restart(self):
        def popen(argv, **_kwargs):
            self.launches.append(list(argv))
            return self.new

        def deployed_path(value):
            return self.releases if str(value) == '/home/node/.local/.pi-releases' else Path(value)

        with patch.object(self.module, 'Path', side_effect=deployed_path), \
                patch.object(self.module, 'image_module', side_effect=lambda name: {
                    'runtime_identity': self.identity, 'runtime_session': self.sessions}[name]), \
                patch.object(self.module.time, 'monotonic', side_effect=self.clock), \
                patch.object(self.module.subprocess, 'Popen', side_effect=popen):
            self.supervisor.accept_restart(self.request)
            self.supervisor.perform_restart(self.request)
        return self.supervisor.operation

    def test_matching_target_and_full_snapshot_succeed_without_a_prompt(self):
        operation = self.run_restart()
        self.assertEqual((operation['status'], operation['stage']), ('succeeded', 'complete'))
        self.assertEqual(self.old.signals, [signal.SIGTERM])
        self.assertEqual(self.launches[0][:2], ['/usr/local/bin/node', str((self.target / 'bin/pi').resolve())])
        self.assertNotIn('prompt', self.extension_actions)

    def test_only_isolated_probe_launcher_can_evaluate_same_version_refresh(self):
        probe = load('runtime_probe')
        # Capture the actual probe-owned subclass without starting a server/PTY.
        captured = []
        with patch.dict('sys.modules', {'pi_supervisor': self.module}), \
                patch.dict(os.environ, {'PI_RUNTIME_RUN_ID': 'a' * 32, 'PI_RUNTIME_DIR': str(self.private)}), \
                patch.object(probe, 'isolation'), \
                patch.object(self.module.PiSupervisor, 'run', lambda instance: captured.append(type(instance))):
            probe.probe_supervisor_main(['--', str(self.entry)])
        self.supervisor.__class__ = captured[0]
        self.capture.close()
        self.supervisor.restore_capture = None
        del self.request['restore_proof']
        self.entry.unlink()
        self.entry.symlink_to(self.source / 'bin/pi')
        self.successor['version'] = '1.3.0'
        operation = self.run_restart()
        self.assertEqual((operation['status'], operation['stage']), ('succeeded', 'complete'))
        self.assertEqual(self.launches[0][:2], ['/usr/local/bin/node', str((self.source / 'bin/pi').resolve())])

    def test_probe_launcher_requires_isolation_before_constructing_any_supervisor(self):
        probe = load('runtime_probe')
        with patch.dict('sys.modules', {'pi_supervisor': self.module}), \
                patch.object(probe, 'isolation', side_effect=probe.ProbeFailure('not_isolated')), \
                patch.object(self.module.PiSupervisor, 'run', return_value=0), \
                patch.object(self.module.PiSupervisor, '__init__', return_value=None) as constructed:
            with self.assertRaises(probe.ProbeFailure):
                probe.probe_supervisor_main(['--', str(self.entry)])
        constructed.assert_not_called()

    def test_shared_link_switch_during_shutdown_never_launches_the_other_release(self):
        selected = self.identity.measure_package(self.target / 'bin/pi')

        def switch():
            self.entry.unlink()
            self.entry.symlink_to(self.other / 'bin/pi')

        self.old.on_exit = switch
        operation = self.run_restart()
        self.assertEqual(self.launches[0][:2], ['/usr/local/bin/node', selected['executable']])
        self.assertEqual(self.supervisor.source_identity, selected)
        self.assertEqual(operation['status'], 'succeeded')

    def test_target_dependency_drift_during_shutdown_cannot_be_launched(self):
        self.old.on_exit = lambda: (self.target / 'lib/node_modules/@earendil-works/pi-coding-agent/dependency.js').write_text('changed')
        operation = self.run_restart()
        self.assertEqual(self.launches, [], 'unproved target bytes were executed')
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'starting_failed'))

    def test_unmeasurable_proof_target_cannot_fall_back_to_original_argv(self):
        self.old.on_exit = lambda: (self.target / 'lib/node_modules/@earendil-works/pi-coding-agent/package.json').unlink()
        operation = self.run_restart()
        self.assertEqual(self.launches, [], 'proof restart used the legacy launch fallback')
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'starting_failed'))

    def test_target_prefix_drift_outside_package_is_not_ignored_at_spawn(self):
        self.old.on_exit = lambda: (self.target / 'unproved-extra').write_text('changed prefix')
        operation = self.run_restart()
        self.assertEqual(self.launches, [], 'only package identity, not proved prefix, was rechecked')
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'starting_failed'))

    def test_taint_during_last_expensive_hash_keeps_the_old_child_running(self):
        def taint(count):
            if count == 2:
                self.live['busy'] = True

        self.after_hash = taint
        operation = self.run_restart()
        self.assertEqual(self.old.signals, [], 'old safe snapshot was reused after hashing')
        self.assertEqual(self.launches, [])
        self.assertEqual(operation['status'], 'failed')

    def test_model_drift_during_last_hash_fails_the_full_snapshot_fence(self):
        def change(count):
            if count == 2:
                self.live['model'] = 'other-model'

        self.after_hash = change
        self.run_restart()
        self.assertEqual(self.old.signals, [], 'final fence compared only runtime/session/leaf')

    def test_history_drift_during_last_hash_fails_before_stop(self):
        def change(count):
            if count == 2:
                self.session.write_text(self.session.read_text() + '{}\n')

        self.after_hash = change
        self.run_restart()
        self.assertEqual(self.old.signals, [], 'frozen history was changed during package hashing')

    def test_capture_expiry_during_last_hash_cannot_extend_to_checking_deadline(self):
        self.now[0] = self.capture.deadline - 1

        def expire(count):
            if count == 2:
                self.now[0] += 2

        self.after_hash = expire
        self.run_restart()
        self.assertEqual(self.old.signals, [], '15-second checking window outlived the original lease')
        self.assertEqual(self.launches, [])

    def test_expired_capture_is_not_reprepared_or_renewed(self):
        self.now[0] = self.capture.deadline
        deadline = self.capture.deadline
        self.run_restart()
        self.assertNotIn('prepare', self.extension_actions)
        self.assertEqual(self.capture.deadline, deadline)
        self.assertEqual(self.old.signals, [])

    def prepare_with_slow_freeze(self, delay):
        self.capture.close()
        self.supervisor.restore_capture = None
        capture_type = self.sessions.SessionCapture

        def freeze(request):
            self.extension_actions.append(request['action'])
            if request['action'] == 'prepare':
                self.now[0] += delay
            return copy.deepcopy(self.live)

        def capture(*args):
            return capture_type(*args, clock=self.clock)

        self.supervisor.extension_request = freeze
        with patch.object(self.module, 'image_module', return_value=self.sessions), \
                patch.object(self.sessions, 'SessionCapture', side_effect=capture), \
                patch.object(self.module.time, 'monotonic', side_effect=self.clock), \
                patch.object(self.module.threading, 'Timer'):
            return self.supervisor.prepare_restore({
                key: ('prepare_restore' if key == 'action' else value)
                for key, value in self.request.items() if key != 'restore_proof'})

    def test_capture_lease_is_bounded_by_initial_freeze_not_later_capture_creation(self):
        original_deadline = self.now[0] + self.sessions.LEASE_SECONDS
        try:
            self.prepare_with_slow_freeze(149)
            self.assertLessEqual(self.supervisor.restore_capture.deadline, original_deadline)
        finally:
            self.supervisor.cancel_restore('b' * 32)

    def test_freeze_response_after_original_lease_expiry_cannot_create_a_new_grant(self):
        try:
            with self.assertRaises(self.module.ProtocolError):
                self.prepare_with_slow_freeze(151)
        finally:
            self.supervisor.cancel_restore('b' * 32)
        self.assertEqual(self.old.signals, [])

    def test_successor_provider_mismatch_is_visible_readiness_failure(self):
        self.successor['provider'] = 'other-provider'
        operation = self.run_restart()
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'readiness_mismatch'))

    def test_successor_model_mismatch_is_visible_readiness_failure(self):
        self.successor['model'] = 'other-model'
        operation = self.run_restart()
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'readiness_mismatch'))

    def test_successor_thinking_mismatch_is_visible_readiness_failure(self):
        self.successor['thinking'] = 'high'
        operation = self.run_restart()
        self.assertEqual((operation['status'], operation['stage']), ('failed', 'readiness_mismatch'))


class CaptureExpiry(unittest.TestCase):
    def test_reads_straddling_expiry_cannot_verify_unchanged_history(self):
        module = load('runtime_session')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / 'source.jsonl'
            session.write_text(json.dumps({'type': 'session', 'id': 's', 'version': 3, 'cwd': str(root)}) + '\n')
            snapshot = {'idle': True, 'pending': False, 'busy': False,
                        'session_file': str(session), 'session_id': 's', 'cwd': str(root)}
            now = [100.0]
            capture = module.SessionCapture(root, snapshot, 'b' * 32, clock=lambda: now[0])
            try:
                now[0] = capture.deadline - 1
                read = module._read

                def slow_read(*args):
                    value = read(*args)
                    now[0] += 1
                    return value

                with patch.object(module, '_read', side_effect=slow_read), self.assertRaises(ValueError):
                    capture.verify(snapshot)
                self.assertEqual(session.read_text(), json.dumps({
                    'type': 'session', 'id': 's', 'version': 3, 'cwd': str(root)}) + '\n')
            finally:
                capture.close()


if __name__ == '__main__':
    unittest.main()

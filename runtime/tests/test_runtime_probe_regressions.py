"""Negative probe-driver regressions, not real-Pi compatibility evidence.

Only the process boundary is substituted. The production acceptance logic,
runtime copying/hashing, and disposable JSONL files remain real.
"""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


RUNTIME = Path(__file__).resolve().parents[1]


class NextChild(Exception):
    """Stop after the generation/barrier case, before unrelated experiments."""


class ProbeRegressionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('probe_regressions', RUNTIME / 'runtime_probe.py')
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.temporary = tempfile.TemporaryDirectory(prefix='pi-probe-regression-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def runtime(self, *, measured=False):
        prefix = self.root / 'original'
        package = prefix / 'lib/node_modules/@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({
            'name': '@earendil-works/pi-coding-agent', 'version': '1.4.0',
            'engines': {'node': '>=24.0.0'}, 'bin': {'pi': 'cli.js'},
        }))
        (package / 'cli.js').write_text('// process boundary is substituted in these unit tests\n')
        (package / 'dependency.js').write_text('original dependency\n')
        (prefix / 'bin').mkdir()
        (prefix / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')
        return package if measured else prefix

    def drive_barrier(self, defect=None, *, replay_on='cancel'):
        """Exercise behavioral_checks against a buffering/flushing guard driver.

        An ordinary generation completes first. The faulty boundary can then
        flush held input on cancellation, during settling, or with fresh input.
        Each replay effect is independently observable, so no assertion can
        hide behind another (for example leaf drift behind a provider call).
        """
        candidate = self.runtime()

        class GuardDriver:
            def __init__(driver, directory, *_args, **_kwargs):
                if directory.name != 'generation':
                    raise NextChild()
                directory.mkdir()
                driver.directory = directory
                driver.events = []
                driver.value = {'leaf_id': 'probe-leaf', 'idle': True, 'pending': False, 'busy': False}
                driver.frozen = False
                driver.buffered = b''

            def __enter__(driver):
                return driver

            def __exit__(driver, *_args):
                pass

            def ready(driver, *_args):
                return driver.snapshot()

            def snapshot(driver):
                return dict(driver.value)

            def rows(driver, event):
                return [row for row in driver.events if row['event'] == event]

            def prepare(driver, *_args):
                if driver.value['busy']:
                    return {'ok': False}
                driver.frozen = True
                return {'ok': True}

            def ws(driver, method, params):
                if method != 'prompt' or params != {'message': 'PROBE_GENERATION'}:
                    raise AssertionError('unexpected generation request')
                driver.events.append({'event': 'provider_call', 'generation': True})
                driver.value.update(idle=False, busy=True)
                return {'ok': True}

            def wait(driver, predicate, **_kwargs):
                if (driver.directory / 'release-generation').exists() and not driver.rows('agent_end'):
                    driver.events.append({'event': 'agent_end'})
                    driver.value.update(leaf_id='generated-leaf', idle=True, busy=False)
                result = predicate()
                if not result:
                    raise AssertionError('driver observation never arrived')
                return result

            def flush(driver):
                if not driver.buffered:
                    return
                if defect == 'stdin':
                    driver.events.append({'event': 'stdin', 'safe': False, 'intact': True,
                                          'data': base64.b64encode(driver.buffered).decode()})
                elif defect == 'provider':
                    driver.events.append({'event': 'provider_call', 'generation': False})
                elif defect == 'tool':
                    driver.events.append({'event': 'tool_call'})
                elif defect == 'leaf':
                    driver.value['leaf_id'] = 'replayed-leaf'
                driver.buffered = b''

            def control(driver, action, **_kwargs):
                if action != 'cancel':
                    raise AssertionError('unexpected guard action')
                driver.frozen = False
                if replay_on == 'cancel':
                    driver.flush()
                return {'ok': True}

            def settle(driver, *_args):
                if not driver.frozen and replay_on == 'settle':
                    driver.flush()

            def send(driver, data):
                if driver.frozen:
                    if defect:
                        driver.buffered += data
                    return
                if replay_on == 'fresh':
                    driver.flush()
                driver.events.append({'event': 'stdin', 'safe': False, 'intact': True,
                                      'data': base64.b64encode(data).decode()})
                driver.value.update(busy=True)

        with patch.object(self.probe, 'RealPi', GuardDriver), \
                patch.object(self.probe, 'stage_web', return_value=self.root / 'web'), \
                patch.object(self.probe, 'run_bounded', return_value=b'1.4.0\n'):
            try:
                self.probe.behavioral_checks(self.root, candidate, '1.4.0', '24.0.0')
            except NextChild:
                return
        self.fail('generation driver did not reach the next independent child')

    def test_barrier_accepts_dropped_input_and_fresh_post_release_taint(self):
        self.drive_barrier()

    def test_barrier_rejects_buffered_input_flushed_on_cancel(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_cancel_replay'):
            self.drive_barrier('stdin')

    def test_barrier_observes_delayed_post_cancel_replay_before_fresh_input(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_cancel_replay'):
            self.drive_barrier('stdin', replay_on='settle')

    def test_barrier_rejects_replay_alongside_fresh_input(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_release_replay'):
            self.drive_barrier('stdin', replay_on='fresh')

    def test_barrier_rejects_new_provider_call_after_cancel(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_cancel_replay'):
            self.drive_barrier('provider')

    def test_barrier_rejects_new_tool_call_after_cancel(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_cancel_replay'):
            self.drive_barrier('tool')

    def test_barrier_rejects_leaf_change_after_cancel(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_cancel_replay'):
            self.drive_barrier('leaf')

    def test_barrier_rejects_provider_replay_triggered_by_fresh_input(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_release_replay'):
            self.drive_barrier('provider', replay_on='fresh')

    def test_barrier_rejects_tool_replay_triggered_by_fresh_input(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_release_replay'):
            self.drive_barrier('tool', replay_on='fresh')

    def test_barrier_rejects_leaf_change_triggered_by_fresh_input(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'barrier_release_replay'):
            self.drive_barrier('leaf', replay_on='fresh')

    def drive_restore(self, mutate=None, *, measured=False, header_version=3, sdk_format=3,
                      require_surrogate_cwd=False):
        source = self.runtime(measured=measured)
        source_hash = self.probe.tree_digest(source)
        session = self.root / 'frozen.jsonl'
        self.probe.seed_session(session, '/saved/cwd')
        header, history = session.read_bytes().split(b'\n', 1)
        header = json.loads(header)
        if header_version is None:
            del header['version']
        else:
            header['version'] = header_version
        session.write_bytes(json.dumps(header).encode() + b'\n' + history)
        frozen = session.read_bytes()
        expected = {'session_id': 'probe-saved-session', 'leaf_id': 'probe-leaf', 'cwd': '/saved/cwd',
                    'provider': 'runtime-probe', 'model': 'probe-model', 'thinking': 'medium'}
        work = self.root / 'work'
        work.mkdir(mode=0o700)

        class RestoreDriver(self.probe.RealPi):
            # Real initialization makes exactly the private session/runtime
            # files the production driver uses. Only child execution is absent.
            def __enter__(driver):
                if require_surrogate_cwd:
                    opened_header, opened_history = driver.session.read_bytes().split(b'\n', 1)
                    opened_header = json.loads(opened_header)
                    # Real Pi asks for terminal confirmation when its stored
                    # cwd is absent. The disposable file must use its own cwd.
                    self.assertEqual(opened_header['cwd'], str(driver.cwd))
                    self.assertEqual({**opened_header, 'cwd': '/saved/cwd'}, header)
                    self.assertEqual(opened_history, history)
                driver.trace.write_text(json.dumps({'event': 'session_start', 'session_format': sdk_format}) + '\n')
                return driver

            def __exit__(driver, *_args):
                if mutate:
                    mutate(driver)

            def ready(driver, *_args, **_kwargs):
                return driver.snapshot()

            def snapshot(driver):
                return {**expected, 'cwd': str(driver.cwd), 'idle': True, 'pending': False}

            def settle(driver, *_args):
                pass

        def version_output(argv, *_args, **_kwargs):
            return b'v24.0.0\n' if len(argv) == 2 else b'1.4.0\n'

        try:
            with patch.object(self.probe, 'RealPi', RestoreDriver), \
                    patch.object(self.probe, 'stage_web', return_value=work / 'web'), \
                    patch.object(self.probe, 'run_bounded', side_effect=version_output), \
                    patch.object(self.probe.socket, 'socket') as listener:
                # No child will listen. Keep real file initialization without
                # asking the host/sandbox to allocate an unused network port.
                listener.return_value.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 12345)
                return self.probe.run_restore(source, session, expected, work)
        finally:
            # A refusal must preserve both original inputs, including when the
            # candidate only mutates its disposable state while shutting down.
            self.assertEqual(session.read_bytes(), frozen)
            self.assertEqual(self.probe.tree_digest(source), source_hash)

    def test_restore_accepts_unchanged_disposable_history_and_release(self):
        self.assertIs(self.drive_restore()['ok'], True)

    def test_restore_accepts_unchanged_disposable_history_and_measured_package(self):
        self.assertIs(self.drive_restore(measured=True)['ok'], True)

    def test_restore_maps_only_private_header_cwd_and_preserves_all_original_input(self):
        value = self.drive_restore(require_surrogate_cwd=True)
        self.assertEqual(value['cwd_mode'], 'surrogate')
        self.assertEqual(value['restored']['cwd'], '/saved/cwd')

    def test_restore_rejects_disposable_header_changes_beyond_cwd(self):
        def rewrite(driver):
            first, body = driver.session.read_bytes().split(b'\n', 1)
            header = json.loads(first)
            header['id'] = 'other-session'
            driver.session.write_bytes(json.dumps(header).encode() + b'\n' + body)
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_history_changed'):
            self.drive_restore(rewrite, require_surrogate_cwd=True)

    def test_restore_rejects_future_format_even_when_all_bytes_and_reported_fields_match(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(header_version=999)

    def test_restore_accepts_format_supported_by_actual_sdk_not_a_fixed_format_allowlist(self):
        self.assertIs(self.drive_restore(header_version=999, sdk_format=1000)['ok'], True)

    def test_restore_rejects_noninteger_header_version_even_when_sdk_opens_it(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(header_version='3')

    def test_restore_rejects_boolean_header_version_even_when_sdk_opens_it(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(header_version=True)

    def test_restore_rejects_missing_header_version_even_when_sdk_opens_it(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(header_version=None)

    def test_restore_rejects_uninspectable_selected_sdk_format(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(sdk_format=None)

    def test_restore_rejects_boolean_selected_sdk_format(self):
        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_format'):
            self.drive_restore(sdk_format=True)

    def test_restore_rejects_dropped_history_with_matching_reported_leaf_and_settings(self):
        def truncate(driver):
            lines = driver.session.read_bytes().splitlines(keepends=True)
            driver.session.write_bytes(lines[0] + lines[-1])

        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_history_changed'):
            self.drive_restore(truncate)

    def test_restore_rejects_rewritten_history_with_matching_reported_leaf_and_settings(self):
        def rewrite(driver):
            driver.session.write_bytes(driver.session.read_bytes().replace(
                b'Saved synthetic answer', b'Rewritten history'))

        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_history_changed'):
            self.drive_restore(rewrite)

    def test_restore_rejects_dependency_changed_only_in_executed_release_copy(self):
        def mutate(driver):
            package = driver.candidate / 'lib/node_modules/@earendil-works/pi-coding-agent'
            (package / 'dependency.js').write_text('changed at shutdown\n')

        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_runtime_changed'):
            self.drive_restore(mutate)

    def test_restore_rejects_dependency_changed_only_in_executed_measured_package(self):
        def mutate(driver):
            package = driver.candidate / 'lib/node_modules/@earendil-works/pi-coding-agent'
            (package / 'dependency.js').write_text('changed at shutdown\n')

        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_runtime_changed'):
            self.drive_restore(mutate, measured=True)

    def test_restore_rejects_changed_generated_wrapper_even_if_package_unchanged(self):
        def mutate(driver):
            entry = driver.candidate / 'bin/pi'
            entry.unlink()
            entry.symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/dependency.js')

        with self.assertRaisesRegex(self.probe.ProbeFailure, 'restore_runtime_changed'):
            self.drive_restore(mutate, measured=True)


if __name__ == '__main__':
    unittest.main()

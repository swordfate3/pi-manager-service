"""Installed package metadata is display information, never compatibility proof."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_runtime_updates as base


class InstalledVersion(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).parents[2] / 'runtime/pi_supervisor.py'
        spec = importlib.util.spec_from_file_location('isolated_supervisor', source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.package = self.root / 'lib/node_modules/@earendil-works/pi-coding-agent'
        self.package.mkdir(parents=True)
        (self.package / 'cli.js').write_text('throw new Error("must not execute")')
        (self.package / 'cli.js').chmod(0o755)
        (self.package / 'package.json').write_text(json.dumps({
            'name': '@earendil-works/pi-coding-agent', 'version': '1.4.0'}))
        (self.root / 'bin').mkdir()
        (self.root / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')
        with patch.dict('os.environ', {'PI_RUNTIME_RUN_ID': 'a' * 32}):
            self.supervisor = self.module.PiSupervisor([str(self.root / 'bin/pi')], 1, 1)

    def test_shared_version_is_read_without_executing_candidate_with_consumer_credentials(self):
        with patch.object(self.module.subprocess, 'run', side_effect=AssertionError('candidate executed')):
            try:
                version = self.supervisor.installed_version()
            except AssertionError as error:
                self.fail(str(error))
        self.assertEqual(version, '1.4.0')

    def test_status_distinguishes_running_process_from_shared_installed_version(self):
        snapshot = {'run_id': 'a' * 32, 'runtime_id': 'r', 'session_id': 's', 'leaf_id': None,
                    'version': '1.3.0', 'idle': True, 'pending': False, 'busy': False}
        self.supervisor.safe_snapshot = lambda: snapshot
        with patch.object(self.module.subprocess, 'run', side_effect=AssertionError('candidate executed')):
            value = self.supervisor.status()
        self.assertEqual(value['version'], '1.3.0')
        self.assertEqual(value.get('installed_version'), '1.4.0')

    def test_invalid_package_metadata_is_not_a_reported_version(self):
        (self.package / 'package.json').write_text(json.dumps({'name': 'impostor', 'version': '1.4.0'}))
        with self.assertRaises(self.module.ProtocolError):
            self.supervisor.installed_version()

    def test_optional_nonobject_metadata_does_not_hide_running_or_operation_status(self):
        self.supervisor.safe_snapshot = lambda: {'run_id': 'a' * 32, 'runtime_id': 'r',
            'session_id': 's', 'leaf_id': None, 'version': '1.3.0',
            'idle': True, 'pending': False, 'busy': False}
        self.supervisor.operation = {'status': 'failed', 'stage': 'checking_rejected'}
        for invalid in ([], None, 'not an object', 12):
            with self.subTest(invalid=invalid):
                (self.package / 'package.json').write_text(json.dumps(invalid))
                value = self.supervisor.status()
                self.assertEqual(value['version'], '1.3.0')
                self.assertEqual(value['operation']['stage'], 'checking_rejected')
                self.assertNotIn('installed_version', value)

    def test_bare_pi_entrypoint_resolves_in_launch_path_without_executing_it(self):
        self.supervisor.original_argv = ['pi']
        with patch.dict('os.environ', {'PATH': str(self.root / 'bin')}):
            self.assertEqual(self.supervisor.installed_version(), '1.4.0')


class InstalledReadiness(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager

    def test_readiness_reports_installed_separately_and_does_not_guess_from_running_versions(self):
        manager = self.manager()
        for value in self.docker.states.values():
            value['installed_version'] = '1.4.0'
        readiness = manager.readiness()
        self.assertEqual(readiness.get('installed_version'), '1.4.0')
        self.assertEqual({row['version'] for row in readiness['consumers']}, {'1.1.0'})
        for value in self.docker.states.values():
            value.pop('installed_version')
        self.assertNotIn('installed_version', manager.readiness())

    def test_conflicting_installed_observations_are_not_reported_as_current(self):
        manager = self.manager()
        self.docker.states['1' * 64]['installed_version'] = '1.3.0'
        self.docker.states['2' * 64]['installed_version'] = '1.4.0'
        self.assertEqual(manager.readiness()['status'], 'unavailable')

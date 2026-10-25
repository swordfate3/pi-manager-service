"""Measured launch bytes are distinct from a version label or writable receipt."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class SourceIdentity(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).parents[2] / 'runtime/runtime_identity.py'
        self.assertTrue(source.is_file(), 'image-owned source measurement is missing')
        spec = importlib.util.spec_from_file_location('runtime_source_identity', source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.prefix = Path(self.temporary.name)
        self.package = self.prefix / 'lib/node_modules/@earendil-works/pi-coding-agent'
        self.package.mkdir(parents=True)
        (self.package / 'package.json').write_text(json.dumps({
            'name': '@earendil-works/pi-coding-agent', 'version': '99.2.0', 'engines': {'node': '>=22.19.0'}}))
        (self.package / 'cli.js').write_text('throw new Error("measurement must not execute")')
        (self.package / 'node_modules/dependency').mkdir(parents=True)
        (self.package / 'node_modules/dependency/index.js').write_text('dependency-v1')
        (self.prefix / 'bin').mkdir()
        self.entry = self.prefix / 'bin/pi'
        self.entry.symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')

    def test_future_version_is_measured_without_executing_shared_code(self):
        value = self.module.measure_package(self.entry)
        self.assertEqual(value['contract'], 'pi-runtime-source-v1')
        self.assertEqual(value['version'], '99.2.0')
        self.assertEqual(value['node'], '>=22.19.0')
        self.assertEqual(value['executable'], str(self.package / 'cli.js'))
        self.assertRegex(value['tree_sha256'], '^[0-9a-f]{64}$')

    def test_dependency_drift_or_entrypoint_change_cannot_reuse_launch_identity(self):
        initial = self.module.measure_package(self.entry)
        (self.package / 'node_modules/dependency/index.js').write_text('dependency-v2')
        self.assertNotEqual(self.module.measure_package(self.entry)['tree_sha256'], initial['tree_sha256'])
        self.entry.unlink()
        self.entry.symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            self.module.measure_package(self.entry)

    def test_external_dependency_link_and_nonobject_manifest_are_refused(self):
        outside = self.prefix / 'outside.js'
        outside.write_text('outside')
        link = self.package / 'node_modules/external.js'
        link.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.module.measure_package(self.entry)
        link.unlink()
        (self.package / 'package.json').write_text('[]')
        with self.assertRaises(ValueError):
            self.module.measure_package(self.entry)

    def test_mode_changes_are_part_of_the_identity(self):
        initial = self.module.measure_package(self.entry)
        (self.package / 'node_modules/dependency/index.js').chmod(0o700)
        self.assertNotEqual(self.module.measure_package(self.entry)['tree_sha256'], initial['tree_sha256'])

    def test_supervisor_pins_the_measured_executable_and_reports_it_for_the_actual_child(self):
        source = Path(__file__).parents[2] / 'runtime/pi_supervisor.py'
        spec = importlib.util.spec_from_file_location('measured_supervisor', source)
        supervisor_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(supervisor_module)
        with patch.dict('os.environ', {'PI_RUNTIME_RUN_ID': 'a' * 32}):
            supervisor = supervisor_module.PiSupervisor([str(self.entry)], 1, 1)
        supervisor.extension_socket = self.prefix / 'extension.sock'
        child = unittest.mock.Mock()
        child.pid = 123
        child.poll.return_value = None
        with patch.object(supervisor_module.subprocess, 'Popen', return_value=child) as popen:
            supervisor.spawn([str(self.entry)], str(self.prefix))
        self.assertEqual(popen.call_args.args[0][:2], ['/usr/local/bin/node', str(self.package / 'cli.js')])
        self.assertEqual(supervisor.source_identity['version'], '99.2.0')
        self.assertEqual(supervisor.source_identity['tree_sha256'], self.module.measure_package(self.entry)['tree_sha256'])

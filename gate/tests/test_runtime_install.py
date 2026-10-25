import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_runtime_security import artifact


class RuntimeInstallTest(unittest.TestCase):
    def load(self):
        source = Path(__file__).parents[1] / 'gate/runtime_install.py'
        self.assertTrue(source.exists(), 'staged runtime installer is missing')
        spec = importlib.util.spec_from_file_location('runtime_install', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_candidate_is_verified_before_atomic_entrypoint_switch(self):
        install = self.load()
        data, release = artifact('1.3.0')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'lib/old-pi.js'
            old.parent.mkdir()
            old.write_text('old package remains available')
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../lib/old-pi.js')
            def run(argv, **kwargs):
                if 'install' in argv:
                    self.assertEqual((root / 'bin/pi').resolve(), old)
                    self.assertIn('--ignore-scripts', argv)
                    self.assertNotIn('@earendil-works/pi-coding-agent@1.3.0', argv)
                    prefix = Path(argv[argv.index('--prefix') + 1])
                    (prefix / 'bin').mkdir(parents=True)
                    (prefix / 'bin/pi').write_text('new pi')
                    package = prefix / 'lib/node_modules/@earendil-works/pi-coding-agent'
                    package.mkdir(parents=True)
                    (package / 'package.json').write_text(json.dumps({'name': install.PACKAGE, 'version': '1.3.0'}))
                    return subprocess.CompletedProcess(argv, 0)
                self.fail('candidate must not execute in preparation/activation')
            with patch.object(install.subprocess, 'run', side_effect=run), patch.object(install, 'download', return_value=data):
                result = install.install(root, '1.3.0', 'a' * 32, release=release)
                self.assertEqual((root / 'bin/pi').resolve(), old, 'preparation must not activate')
                # Synthetic Gate authority for the atomic activation unit only;
                # this does not establish real package compatibility.
                candidate, profile = result['candidate'], {'image': 'synthetic'}
                evidence = {'candidate_hash': install.digest(candidate), 'release_hash': install.digest(release),
                            'profile_hash': install.digest(profile), 'node': '24.21.0',
                            'checks': {key: True for key in install.CHECKS}}
                result = install.install(root, '1.3.0', 'a' * 32, 'activate', release=release,
                                         candidate=candidate, evidence=evidence, profile=profile)
            self.assertTrue(result['ok'])
            self.assertEqual((root / 'bin/pi').read_text(), 'new pi')
            self.assertEqual(old.read_text(), 'old package remains available')
            self.assertEqual(result['version'], '1.3.0')

    def test_failed_version_verification_preserves_previous_entrypoint(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            with patch.object(install.subprocess, 'run', return_value=
                              subprocess.CompletedProcess([], 0, stdout='wrong-version\n')):
                result = install.install(root, '1.3.0', 'b' * 32)
            self.assertFalse(result['ok'])
            self.assertEqual((root / 'bin/pi').readlink(), Path('../old'))

    def test_repeated_task_is_unknown_not_a_clean_install_failure(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            (root / 'old').write_text('old')
            (root / '.pi-releases' / ('c' * 32)).mkdir(parents=True)
            result = install.install(root, '1.3.0', 'c' * 32, release=artifact('1.3.0')[1])
            self.assertEqual(result, {'ok': False, 'stage': 'activation_unknown'})

    def test_activation_requires_gate_owned_evidence(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            self.assertIn('action', __import__('inspect').signature(install.install).parameters)
            result = install.install(root, '1.3.0', 'c' * 32, 'activate')
            self.assertFalse(result['ok'])
            self.assertEqual((root / 'bin/pi').readlink(), Path('../old'))

    def test_unpinned_version_refused_before_filesystem_or_npm(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(install.install(root, '1.4.0', 'd' * 32)['ok'])
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

"""Gate launcher boundary: fixed immutable probe, bounded data-only IPC."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from gate import runtime_install as installer
from gate.runtime_engine import RuntimeEngine


class ProbeLauncherTests(unittest.TestCase):
    def test_profile_binds_exact_three_probe_sources(self):
        root = Path(__file__).resolve().parents[2] / 'runtime'
        with patch.dict('os.environ', {}, clear=False):
            import os
            os.environ.pop('PI_MANAGER_LEGACY_WEB_SOURCE', None)
            with self.assertRaisesRegex(RuntimeError, 'legacy Web source is not configured'):
                RuntimeEngine.profile({'policy': {'images': ['sha256:' + 'a' * 64]}})
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'extensions').mkdir()
            (source / 'extensions/legacy-adapter.ts').write_text('export const legacyFixture = true;\n')
            with patch.dict('os.environ', {'PI_MANAGER_LEGACY_WEB_SOURCE': str(source)}):
                profile = RuntimeEngine.profile({'policy': {'images': ['sha256:' + 'a' * 64]}})
        rows = [(name, hashlib.sha256((root / name).read_bytes()).hexdigest()) for name in sorted(
            ('runtime_probe.py', 'runtime_probe_provider.ts', 'runtime_probe_ws.mjs'))]
        self.assertEqual(profile.get('probe_sha256'), hashlib.sha256(
            json.dumps(rows, separators=(',', ':')).encode()).hexdigest())

    def test_missing_or_changed_launcher_fails_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runtime_probe.py').write_text('raise SystemExit(0)')
            profile = {'probe_sha256': '0' * 64}
            with patch.object(installer.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    installer.run_probe({'profile': profile}, root=root)
                run.assert_not_called()

    def test_launcher_uses_fixed_path_and_explicit_clean_environment(self):
        root = Path('/usr/local/lib/pi-runtime')
        request = {'task': 'a' * 32, 'profile': {'probe_sha256': 'a' * 64}}
        with patch.object(installer, 'verify_probe_files'), patch.object(installer.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 0, stdout='{"ok":true}')) as run:
            self.assertEqual(installer.run_probe(request), {'ok': True})
        argv = run.call_args.args[0]
        self.assertEqual(argv, ['/usr/bin/python3', '-I', str(root / 'runtime_probe.py')])
        options = run.call_args.kwargs
        self.assertEqual(json.loads(options['input']), request)
        self.assertEqual(options['env'], {'HOME': '/tmp', 'PATH': '/usr/local/bin:/usr/bin:/bin'})
        self.assertLessEqual(options['timeout'], 260)


if __name__ == '__main__':
    unittest.main()

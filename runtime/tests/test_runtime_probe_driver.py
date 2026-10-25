"""Local real-Pi driver regression, NOT isolated candidate/profile evidence.

Opt in with PI_RUNTIME_PROBE_LOCAL=1. Uses only the checkout's installed packages,
temporary HOME/session/workspace and synthetic provider; no Docker or production
state. External dependency links intentionally make this unsuitable as evidence.
Controller still runs test_runtime_probe_real.py in the read-only offline helper.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[2]


@unittest.skipUnless(os.environ.get('PI_RUNTIME_PROBE_LOCAL') == '1', 'opt-in local real-Pi driver test')
class RealDriverTests(unittest.TestCase):
    def test_real_pi_generation_barrier_and_async_taint(self):
        spec = importlib.util.spec_from_file_location('local_probe_driver', RUNTIME / 'runtime_probe.py')
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        probe.RUNTIME, probe.WEB = RUNTIME, ROOT
        with tempfile.TemporaryDirectory(prefix='pi-probe-driver-') as temporary:
            root = Path(temporary)
            prefix = root / 'prefix'
            modules = prefix / 'lib/node_modules'
            modules.mkdir(parents=True)
            installed = ROOT / 'node_modules'
            shutil.copytree(installed / '@earendil-works', modules / '@earendil-works', symlinks=True)
            for entry in installed.iterdir():
                if entry.name not in ('@earendil-works', '.bin'):
                    (modules / entry.name).symlink_to(entry)
            package = modules / '@earendil-works/pi-coding-agent'
            (prefix / 'bin').mkdir()
            (prefix / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
            import json
            version = json.loads((package / 'package.json').read_text())['version']
            node = probe.run_bounded([str(probe.NODE), '--version'], root, probe.clean_environment(root)).decode().strip()[1:]
            web = probe.stage_web(root / 'web', prefix)
            with probe.RealPi(root / 'case', prefix, web) as pi:
                try:
                    before = pi.ready(version, node)
                    self.assertEqual(before['leaf_id'], 'probe-leaf')
                    self.assertTrue(pi.ws('prompt', {'message': 'PROBE_GENERATION'})['ok'])
                    pi.wait(lambda: pi.rows('provider_call'))
                    self.assertFalse(pi.prepare(pi.snapshot(), '1' * 32)['ok'])
                    (pi.directory / 'release-generation').touch()
                    pi.wait(lambda: pi.rows('agent_end'))
                    after = pi.wait(lambda: (s if (s := pi.snapshot())['idle'] and not s['busy'] and not s['pending'] else None))
                    self.assertTrue(pi.prepare(after, '2' * 32)['ok'])
                    count = len(pi.rows('stdin'))
                    pi.send(b'DROPPED_INPUT\r')
                    pi.settle()
                    self.assertEqual(len(pi.rows('stdin')), count)
                    self.assertTrue(pi.control('cancel', operation_id='2' * 32)['ok'])
                except BaseException:
                    # Only synthetic local TUI output, never captured user state.
                    print(bytes(pi.output).decode(errors='replace')[-8000:])
                    raise
            with probe.RealPi(root / 'async', prefix, web) as pi:
                try:
                    pi.ready(version, node)
                    self.assertTrue(pi.ws('prompt', {'message': '/runtime-probe-async'})['ok'])
                    pi.wait(lambda: pi.rows('async_start'))
                    self.assertTrue(pi.snapshot()['busy'])
                    (pi.directory / 'release-async').touch()
                    pi.wait(lambda: pi.rows('async_complete'))
                    pi.settle()
                    self.assertTrue(pi.snapshot()['busy'])
                    self.assertFalse(pi.prepare(pi.snapshot(), '3' * 32)['ok'])
                except BaseException:
                    print(bytes(pi.output).decode(errors='replace')[-8000:])
                    raise


if __name__ == '__main__':
    unittest.main()

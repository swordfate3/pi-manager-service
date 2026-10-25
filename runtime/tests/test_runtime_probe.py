"""Offline tests for probe boundaries; these are not real-Pi acceptance evidence."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
GATE = RUNTIME.parent / "gate/gate/runtime_install.py"


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((RUNTIME / "runtime_probe.py").exists(), "fixed behavioral probe is not implemented")
        self.probe = module(RUNTIME / "runtime_probe.py", "runtime_probe")
        self.installer = module(GATE, "probe_installer_contract")
        self.temp = tempfile.TemporaryDirectory(prefix="runtime-probe-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def tree(self):
        tree = self.root / "source"
        (tree / "lib").mkdir(parents=True)
        (tree / "bin").mkdir()
        (tree / "lib/cli.js").write_text("// synthetic tree, never behavioral evidence\n")
        (tree / "bin/pi").symlink_to("../lib/cli.js")
        return tree

    def test_candidate_copy_preserves_internal_relative_links_and_installer_digest(self):
        tree = self.tree()
        digest = self.installer.tree_digest(tree)
        copy = self.root / "copy"
        self.probe.copy_candidate(tree, copy, digest)
        self.assertEqual(os.readlink(copy / "bin/pi"), "../lib/cli.js")
        self.assertEqual(self.probe.tree_digest(copy), digest)
        self.assertEqual(self.installer.tree_digest(copy), digest)
        (copy / "lib/cli.js").write_text("scratch writes do not affect source")
        self.assertEqual(self.installer.tree_digest(tree), digest)

    def test_copy_rejects_tree_drift_before_candidate_execution(self):
        tree = self.tree()
        digest = self.installer.tree_digest(tree)
        (tree / "lib/cli.js").write_text("changed dependency")
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.copy_candidate(tree, self.root / "copy", digest)
        self.assertFalse((self.root / "copy").exists())

    def test_reading_candidate_does_not_mistake_atime_change_for_content_drift(self):
        tree = self.tree()
        path = tree / 'lib/cli.js'
        os.utime(path, (1, 2))
        expected = self.installer.tree_digest(tree)
        os.utime(path, (1, 2))
        self.assertEqual(self.probe.tree_digest(tree), expected)

    def test_metadata_only_candidate_cannot_produce_behavioral_checks(self):
        candidate = self.root / 'metadata-only'
        package = candidate / 'lib/node_modules/@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        (package / 'package.json').write_text('{"name":"@earendil-works/pi-coding-agent","version":"1.4.0",'
                                            '"engines":{"node":">=20.0.0"}}')
        (package / 'cli.js').write_text("console.log('1.4.0')")
        (candidate / 'bin').mkdir()
        (candidate / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.behavioral_checks(self.root, candidate, '1.4.0', '24.0.0')

    def test_restore_rejects_wrong_header_and_does_not_touch_source(self):
        session = self.root / 'session.jsonl'
        original = b'{"type":"session","version":3,"id":"other","cwd":"/saved/cwd"}\n'
        session.write_bytes(original)
        expected = {'session_id': 'wanted', 'leaf_id': 'leaf', 'cwd': '/saved/cwd',
                    'provider': 'runtime-probe', 'model': 'probe-model', 'thinking': 'medium'}
        work = self.root / 'restore'
        work.mkdir(mode=0o700)
        self.assertTrue(callable(getattr(self.probe, 'run_restore', None)), 'real restore API missing')
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.run_restore(self.root / 'candidate', session, expected, work)
        self.assertEqual(session.read_bytes(), original)

    def test_restore_rejects_unbounded_unsafe_paths_and_nonprivate_state(self):
        self.assertTrue(callable(getattr(self.probe, 'run_restore', None)), 'real restore API missing')
        session = self.root / 'session.jsonl'
        self.probe.seed_session(session, '/saved/cwd')
        expected = {'session_id': 'probe-saved-session', 'leaf_id': 'probe-leaf', 'cwd': '/saved/cwd',
                    'provider': 'runtime-probe', 'model': 'probe-model', 'thinking': 'medium'}
        alias = self.root / 'alias'
        alias.symlink_to(session)
        work = self.root / 'restore'
        work.mkdir(mode=0o755)
        for selected in (session, alias):
            with self.subTest(path=selected), self.assertRaises(self.probe.ProbeFailure):
                self.probe.run_restore(self.root / 'candidate', selected, expected, work)
        work.chmod(0o700)
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.run_restore(self.root / 'candidate', session, {**expected, 'cwd': 'relative'}, work)

    def test_source_probe_rejects_noncanonical_or_outside_runtime_package(self):
        self.assertTrue(callable(getattr(self.probe, 'probe_source', None)), 'source behavioral API missing')
        source = {'contract': 'pi-runtime-source-v1', 'package': '/home/node/.local/lib/node_modules/pkg',
                  'executable': '/home/node/.local/lib/node_modules/pkg/cli.js', 'version': '1.4.0',
                  'node': '>=24.0.0', 'tree_sha256': 'a' * 64}
        for change in ({'package': '/tmp/shared-package'}, {'package': '/home/node/.local/../other'},
                       {'executable': '/tmp/cli.js'}, {'checks': dict.fromkeys(self.installer.CHECKS, True)},
                       {'version': 'latest'}, {'tree_sha256': 'unbound'}):
            with self.subTest(change=change), self.assertRaises(self.probe.ProbeFailure):
                self.probe.probe_source({**source, **change}, {})

    def test_source_cli_rejects_extra_fields_and_cannot_echo_path_or_check_claims(self):
        result = subprocess.run([sys.executable, '-I', str(RUNTIME / 'runtime_probe.py'), '--source'],
                                input=json.dumps({'source': {}, 'profile': {}, 'checks': {'no_replay': True}}),
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'stage': 'compatibility_probe_failed'})
        self.assertEqual(result.stderr, '')

    def test_ws_driver_rejects_arbitrary_destination_without_connecting(self):
        driver = RUNTIME / 'runtime_probe_ws.mjs'
        self.assertTrue(driver.is_file(), 'fixed WebSocket driver missing')
        node = shutil.which('node')
        result = subprocess.run([node, str(driver)], input='{"url":"https://example.invalid"}',
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"ok": False})
        self.assertEqual(result.stderr, '')

    def test_copy_rejects_escaping_absolute_dangling_links_and_special_files(self):
        tree = self.tree()
        (self.root / "outside").write_text("outside candidate")
        for target in ("../../outside", str(tree / "lib/cli.js"), "missing"):
            with self.subTest(target=target):
                link = tree / "lib/bad"
                link.symlink_to(target)
                with self.assertRaises(self.probe.ProbeFailure):
                    self.probe.tree_digest(tree)
                link.unlink()
        os.mkfifo(tree / "fifo")
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.tree_digest(tree)

    def test_copy_rejects_hardlinks_and_symlinked_root(self):
        tree = self.tree()
        os.link(tree / "lib/cli.js", tree / "hardlink")
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.tree_digest(tree)
        link = self.root / "alias"
        link.symlink_to(tree)
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.tree_digest(link)

    def test_environment_is_explicit_and_all_state_is_disposable(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "never-copy", "NODE_OPTIONS": "--require=evil",
                                     "PI_RUNTIME_CHILD_TOKEN": "ambient", "HTTP_PROXY": "ambient",
                                     "PYTHONPATH": "ambient", "NPM_CONFIG_REGISTRY": "ambient"}):
            env = self.probe.clean_environment(self.root)
        for key in ("OPENAI_API_KEY", "NODE_OPTIONS", "PI_RUNTIME_CHILD_TOKEN", "HTTP_PROXY", "PYTHONPATH",
                    "NPM_CONFIG_REGISTRY", "SSH_AUTH_SOCK", "NODE_PATH"):
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], str(self.root / "home"))
        self.assertEqual(env["PI_CODING_AGENT_DIR"], str(self.root / "agent"))
        self.assertEqual(env["PI_OFFLINE"], "1")

    def test_bounded_process_enforces_output_timeout_and_exit_status(self):
        env = self.probe.clean_environment(self.root)
        self.assertEqual(self.probe.run_bounded([sys.executable, "-I", "-c", "print('24.1.0')"],
                                               self.root, env, timeout=2, limit=100), b"24.1.0\n")
        for script in ("print('x'*10000)", "import time; time.sleep(30)", "raise SystemExit(2)"):
            with self.subTest(script=script), self.assertRaises(self.probe.ProbeFailure):
                self.probe.run_bounded([sys.executable, "-I", "-c", script], self.root, env,
                                       timeout=0.2, limit=100)

    def test_timeout_stops_own_process_group_including_descendant(self):
        pidfile = self.root / 'child.pid'
        script = ('import pathlib,subprocess,sys,time;'
                  'child=subprocess.Popen([sys.executable,"-I","-c","import time;time.sleep(30)"]);'
                  'pathlib.Path(sys.argv[1]).write_text(str(child.pid));time.sleep(30)')
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.run_bounded([sys.executable, '-I', '-c', script, str(pidfile)], self.root,
                                   self.probe.clean_environment(self.root), timeout=.4)
        pid = int(pidfile.read_text())
        state = Path('/proc') / str(pid) / 'stat'
        # An orphan can briefly await init's reap; it must not still execute.
        self.assertTrue(not state.exists() or state.read_text().split(') ', 1)[1].startswith('Z '))

    def test_profile_rejects_missing_image_or_helper_binding(self):
        profile = {'contract': 'pi-runtime-validation-v1', 'probe_sha256': 'a' * 64,
                   'adapter_sha256': 'b' * 64, 'web_sha256': 'c' * 64}
        with self.assertRaises(self.probe.ProbeFailure):
            self.probe.verify_profile(profile)

    def test_closed_evidence_cannot_be_satisfied_by_partial_truthy_or_extra_checks(self):
        candidate, release, profile = {"tree_sha256": "c" * 64}, {"node": ">=24.0.0"}, {"image": "i"}
        checks = dict.fromkeys(self.installer.CHECKS, True)
        good = self.probe.evidence(candidate, release, profile, "24.1.0", checks)
        self.assertEqual(good["candidate_hash"], self.installer.digest(candidate))
        self.assertEqual(good["release_hash"], self.installer.digest(release))
        self.assertEqual(good["profile_hash"], self.installer.digest(profile))
        self.assertEqual(good["checks"], checks)
        invalid = [{**checks, "session_restore": 1}, {**checks, "no_replay": False},
                   {k: v for k, v in checks.items() if k != "pty_guard"}, {**checks, "receipt": True}]
        for value in invalid:
            with self.subTest(checks=value), self.assertRaises(self.probe.ProbeFailure):
                self.probe.evidence(candidate, release, profile, "24.1.0", value)
        for node in ("v24.1.0", "22.0.0", "24.1.0-malformed"):
            with self.subTest(node=node), self.assertRaises(self.probe.ProbeFailure):
                self.probe.evidence(candidate, release, profile, node, checks)

    def test_observation_log_rejects_partial_oversize_and_nonobjects(self):
        trace = self.root / "trace.jsonl"
        self.assertEqual(self.probe.observations(trace), [])
        trace.write_text('{"event":"start"}\n')
        self.assertEqual(self.probe.observations(trace), [{"event": "start"}])
        for raw in ('{"event":', "true\n", "x" * (1024 * 1024 + 1)):
            trace.write_text(raw)
            with self.assertRaises(self.probe.ProbeFailure):
                self.probe.observations(trace)

    def test_source_hash_matches_gate_encoding_and_detects_ts_provider_drift(self):
        (self.root / "runtime_probe.py").write_text("a")
        (self.root / "runtime_probe_provider.ts").write_text("b")
        files = ("runtime_probe.py", "runtime_probe_provider.ts")
        rows = [(name, hashlib.sha256((self.root / name).read_bytes()).hexdigest()) for name in files]
        expected = hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(self.probe.file_set_digest(self.root, files), expected)
        (self.root / files[1]).write_text("changed")
        self.assertNotEqual(self.probe.file_set_digest(self.root, files), expected)

    def test_cli_refuses_extra_fields_without_running_candidate_or_emitting_details(self):
        result = subprocess.run([sys.executable, "-I", str(RUNTIME / "runtime_probe.py")],
                                input=json.dumps({"task": "secret-do-not-echo", "command": "arbitrary"}),
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "stage": "compatibility_probe_failed"})
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()

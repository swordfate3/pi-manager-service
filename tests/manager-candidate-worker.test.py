"""Real worker policy/filesystem tests; no npm, Docker or validation doubles."""
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import ast
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'manager/updates/candidate-worker.py'
WORKER = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location('candidate_worker', SOURCE)
    WORKER = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(WORKER)

INTEGRITY = 'sha512-' + base64.b64encode(bytes(64)).decode()
RELEASE = {'packageName': '@earendil-works/pi-coding-agent', 'version': '1.2.3', 'integrity': INTEGRITY}
TOP = 'node_modules/@earendil-works/pi-coding-agent'

def lock():
    return {'lockfileVersion': 3, 'packages': {
        '': {'name': 'candidate', 'version': '1.0.0', 'dependencies': {RELEASE['packageName']: 'file:/input/artifact.tgz'}},
        TOP: {'version': '1.2.3', 'resolved': 'file:/input/artifact.tgz', 'integrity': INTEGRITY, 'dependencies': {'is-number': '^7.0.0'}},
        'node_modules/is-number': {'version': '7.0.0', 'resolved': 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', 'integrity': INTEGRITY}}}

class CandidateWorker(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(WORKER, 'real bounded candidate worker must exist')

    def bins(self, root, manifests):
        self.assertTrue(callable(getattr(WORKER, 'reconcile_bins', None)), 'installed bin reconciliation required')
        return WORKER.reconcile_bins(root, manifests, WORKER.tree_evidence(root)['rows'])

    def package(self, root, key, name, bins):
        directory = root / key; directory.mkdir(parents=True, exist_ok=True)
        (directory / 'cli.js').write_text('never execute'); (directory / 'cli.js').chmod(0o500)
        return {'name': name, 'bin': bins}

    def test_missing_installed_bin_link_is_not_executable_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); manifest = self.package(root, 'node_modules/x', 'x', 'cli.js')
            with self.assertRaisesRegex(ValueError, 'bin link missing'):
                self.bins(root, {'node_modules/x': manifest})

    def test_internal_but_misdirected_bin_link_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); manifest = self.package(root, 'node_modules/x', 'x', {'x': './cli.js'})
            (root / 'node_modules/x/other.js').write_text('wrong target')
            (root / 'node_modules/.bin').mkdir(); (root / 'node_modules/.bin/x').symlink_to('../x/other.js')
            with self.assertRaisesRegex(ValueError, 'bin link target'):
                self.bins(root, {'node_modules/x': manifest})

    def test_recursive_scoped_and_nested_bin_scopes_are_reconciled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); manifests = {}
            for key, name, bins, link, target in [
                ('node_modules/top', 'top', 'cli.js', 'node_modules/.bin/top', '../top/cli.js'),
                ('node_modules/@scope/tool', '@scope/tool', 'cli.js', 'node_modules/.bin/tool', '../@scope/tool/cli.js'),
                ('node_modules/top/node_modules/@scope/tool', '@scope/tool', {'tool': 'cli.js'},
                 'node_modules/top/node_modules/.bin/tool', '../@scope/tool/cli.js')]:
                manifests[key] = self.package(root, key, name, bins)
                (root / link).parent.mkdir(parents=True, exist_ok=True); (root / link).symlink_to(target)
            result = self.bins(root, manifests)
            self.assertEqual([(x['binLink'], x['relativePath'], x['sha256']) for x in result], [
                ('node_modules/.bin/tool', 'node_modules/@scope/tool/cli.js', hashlib.sha256(b'never execute').hexdigest()),
                ('node_modules/.bin/top', 'node_modules/top/cli.js', hashlib.sha256(b'never execute').hexdigest()),
                ('node_modules/top/node_modules/.bin/tool', 'node_modules/top/node_modules/@scope/tool/cli.js', hashlib.sha256(b'never execute').hexdigest())])
            (root / 'node_modules/top/node_modules/.bin/tool').unlink()
            with self.assertRaisesRegex(ValueError, 'bin link missing'):
                self.bins(root, manifests)

    def test_bin_collisions_in_one_installation_scope_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); manifests = {}
            for name in ['a', 'b']:
                manifests['node_modules/' + name] = self.package(root, 'node_modules/' + name, name, {'same': 'cli.js'})
            (root / 'node_modules/.bin').mkdir(); (root / 'node_modules/.bin/same').symlink_to('../a/cli.js')
            with self.assertRaisesRegex(ValueError, 'bin collision'):
                self.bins(root, manifests)

    def test_bin_target_must_be_regular_executable_and_declared_links_exact(self):
        for kind in ['nonexecutable', 'directory', 'undeclared', 'invalid-name', 'escape']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); manifest = self.package(root, 'node_modules/x', 'x', {'x': 'cli.js'})
                (root / 'node_modules/.bin').mkdir(); (root / 'node_modules/.bin/x').symlink_to('../x/cli.js')
                if kind == 'nonexecutable': (root / 'node_modules/x/cli.js').chmod(0o400)
                elif kind == 'directory':
                    (root / 'node_modules/x/cli.js').unlink(); (root / 'node_modules/x/cli.js').mkdir()
                elif kind == 'undeclared': (root / 'node_modules/.bin/extra').symlink_to('../x/cli.js')
                elif kind == 'invalid-name': manifest['bin'] = {'../escape': 'cli.js'}
                else: manifest['bin'] = {'x': '../other.js'}
                with self.assertRaises(ValueError): self.bins(root, {'node_modules/x': manifest})

    def test_entire_lock_is_validated_and_only_one_local_artifact_is_allowed(self):
        # Removing any recursive source/integrity/link check must fail this test.
        WORKER.validate_lock(lock(), RELEASE)
        for change in [{'resolved': 'https://evil.example/x.tgz'}, {'version': '7.0.0-beta.1'},
                       {'integrity': 'sha1-abc'}, {'link': True}, {'inBundle': True},
                       {'resolved': 'file:/input/artifact.tgz'}, {'name': 'other-name'},
                       {'dependencies': {'x': 'npm:is-number@7.0.0'}},
                       {'optionalDependencies': {'x': 'git+https://evil.example/x'}}]:
            value = lock(); value['packages']['node_modules/is-number'].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                WORKER.validate_lock(value, RELEASE)
        value = lock(); value['packages']['node_modules/../escape'] = value['packages'].pop('node_modules/is-number')
        with self.assertRaises(ValueError): WORKER.validate_lock(value, RELEASE)

    def test_pinned_npm_relative_top_artifact_is_exact_not_a_general_file_exception(self):
        value = lock(); value['packages'][TOP]['resolved'] = 'file:../../input/artifact.tgz'
        WORKER.validate_lock(value, RELEASE)
        for resolved in ['file:../../../input/artifact.tgz', 'file:../../input/other.tgz', 'file:/etc/passwd']:
            value['packages'][TOP]['resolved'] = resolved
            with self.assertRaises(ValueError): WORKER.validate_lock(value, RELEASE)
        value = lock(); value['packages'][TOP]['integrity'] = 'sha512-' + base64.b64encode(b'x' * 64).decode()
        with self.assertRaises(ValueError): WORKER.validate_lock(value, RELEASE)

    def test_hash_changes_for_file_bytes_modes_and_lock_not_just_manifest(self):
        # Hashing only package.json or ignoring modes/lock would miss these mutations.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'data').write_bytes(b'original'); (root / 'package-lock.json').write_text('{}')
            first = WORKER.tree_evidence(root)['sha256']
            (root / 'data').write_bytes(b'changed!')
            self.assertNotEqual(first, WORKER.tree_evidence(root)['sha256'])
            second = WORKER.tree_evidence(root)['sha256']; (root / 'data').chmod(0o500)
            self.assertNotEqual(second, WORKER.tree_evidence(root)['sha256'])
            third = WORKER.tree_evidence(root)['sha256']; (root / 'package-lock.json').write_text('{"tampered":true}')
            self.assertNotEqual(third, WORKER.tree_evidence(root)['sha256'])

    def test_reading_a_file_may_update_atime_without_changing_content_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); file = root / 'data'; file.write_text('unchanged')
            os.utime(file, (1, 2))
            result = WORKER.tree_evidence(root)
            self.assertEqual(result['rows'][0][4], hashlib.sha256(b'unchanged').hexdigest())

    def test_special_hardlinked_escaping_and_nonbin_links_refused(self):
        for kind in ['hardlink', 'fifo', 'escape', 'nonbin']:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); (root / 'data').write_text('x')
                if kind == 'hardlink': os.link(root / 'data', root / 'alias')
                elif kind == 'fifo': os.mkfifo(root / 'fifo')
                else:
                    (root / 'node_modules/.bin').mkdir(parents=True)
                    (root / ('node_modules/.bin/x' if kind == 'escape' else 'alias')).symlink_to('/etc/passwd' if kind == 'escape' else 'data')
                with self.subTest(kind=kind), self.assertRaises(ValueError): WORKER.tree_evidence(root)

    def test_relative_internal_bin_links_are_recorded_with_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'node_modules/.bin').mkdir(parents=True)
            (root / 'node_modules/x').mkdir(); (root / 'node_modules/x/cli.js').write_text('never execute')
            (root / 'node_modules/.bin/x').symlink_to('../x/cli.js')
            self.assertIn(['node_modules/.bin/x', 'link', '../x/cli.js'], WORKER.tree_evidence(root)['rows'])

    def test_link_target_bytes_also_consume_the_export_byte_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'node_modules/.bin').mkdir(parents=True)
            (root / 'node_modules/cli').write_text('x'); (root / 'node_modules/.bin/x').symlink_to('../cli')
            with self.assertRaises(ValueError): WORKER.tree_evidence(root, max_bytes=1)

    def test_tree_byte_entry_depth_limits_fail_during_walk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'file').write_bytes(b'12345')
            with self.assertRaises(ValueError): WORKER.tree_evidence(root, max_bytes=4)
            (root / 'other').write_bytes(b'1')
            with self.assertRaises(ValueError): WORKER.tree_evidence(root, max_entries=1)
            (root / 'a/b').mkdir(parents=True)
            with self.assertRaises(ValueError): WORKER.tree_evidence(root, max_depth=1)

    def test_subprocess_output_and_wall_time_are_hard_bounded(self):
        # Capturing unlimited output then truncating would fail the output flood case.
        with tempfile.TemporaryDirectory() as tmp:
            for code in ["import os; os.write(1,b'x'*1000000)", 'import time; time.sleep(10)']:
                with self.subTest(code=code), self.assertRaises(ValueError):
                    WORKER.run_bounded([sys.executable, '-c', code], cwd=tmp, env={}, timeout=0.2, max_output=1024)

    def test_optional_omissions_require_platform_evidence_not_swallowed_install_failure(self):
        self.assertTrue(hasattr(WORKER, 'optional_omission'), 'platform-aware omission evidence required')
        self.assertEqual(WORKER.optional_omission({'optional': True, 'os': ['darwin']}, 'linux', 'x64', 'glibc'), 'os')
        self.assertEqual(WORKER.optional_omission({'optional': True, 'cpu': ['arm64']}, 'linux', 'x64', 'glibc'), 'cpu')
        self.assertEqual(WORKER.optional_omission({'optional': True, 'os': ['linux'], 'libc': ['musl']}, 'linux', 'x64', 'glibc'), 'libc')
        for item in [{'optional': True}, {'optional': True, 'os': ['linux']}, {'os': ['darwin']}]:
            with self.assertRaises(ValueError): WORKER.optional_omission(item, 'linux', 'x64', 'glibc')

    def test_shared_origin_guard_marks_denial_even_when_js_catches_optional_failure(self):
        # Real builtin calls, not a mock guard: no refused request reaches the network.
        source = ast.parse((SOURCE.parents[2] / 'gate/gate/runtime_install.py').read_text())
        guard = next(ast.literal_eval(n.value) for n in source.body if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'NPM_NETWORK_GUARD' for t in n.targets))
        attempts = ["require('https').request('https://evil.example/a')",
                    "require('http').get('http://registry.npmjs.org/a')",
                    "require('https').get('https://user:secret@registry.npmjs.org/a')",
                    "require('child_process').spawn('/bin/true')",
                    "require('net').connect({path:'/var/run/docker.sock'})"]
        for attempt in attempts:
            with tempfile.TemporaryDirectory() as tmp:
                script = Path(tmp) / 'guard.cjs'; script.write_text(guard)
                result = subprocess.run(['node', '--require', str(script), '-e', 'try {' + attempt + '} catch {}'],
                                        capture_output=True, timeout=5, env={'PATH': os.environ['PATH']})
                self.assertEqual(result.returncode, 0)
                self.assertEqual(Path(str(script) + '.denied').read_text(), 'refused')

if __name__ == '__main__': unittest.main()

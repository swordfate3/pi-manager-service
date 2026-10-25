"""Security boundary tests: real files/ledger, synthetic npm and Docker only."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from gate import runtime_install as installer
from gate.runtime_engine import RuntimeEngine
from test_runtime_engine import DockerAPI


def artifact(version='99.2.0'):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as tar:
        data = json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': version,
                           'engines': {'node': '>=22.0.0'}}).encode()
        member = tarfile.TarInfo('package/package.json')
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
    data = stream.getvalue()
    return data, {'version': version, 'integrity': 'sha512-' + base64.b64encode(
        hashlib.sha512(data).digest()).decode(), 'node': '>=22.0.0',
        'tarball': 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-' + version + '.tgz'}


class CandidateSecurity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'bin').mkdir()
        (self.root / 'old').write_text('original entrypoint')
        (self.root / 'bin/pi').symlink_to('../old')
        self.data, self.release = artifact()
        self.task = 'a' * 32
        self.calls = []

    def npm(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        self.assertEqual(argv[0], '/usr/local/bin/npm', 'preparation must not execute candidate code')
        self.assertIn('--ignore-scripts', argv)
        self.assertIn('--fetch-retries=0', argv)
        self.assertIn('--fetch-timeout=60000', argv)
        self.assertNotIn('@earendil-works/pi-coding-agent@99.2.0', argv,
                         'must install verified bytes, not resolve version a second time')
        self.assertNotIn('SECRET_NPM_TOKEN', kwargs['env'])
        self.assertNotIn('evil', kwargs['env'].get('NODE_OPTIONS', ''))
        self.assertTrue(kwargs['env']['NODE_OPTIONS'].startswith('--require='))
        self.assertEqual(Path(kwargs['env']['NODE_OPTIONS'][10:]).read_text(), installer.NPM_NETWORK_GUARD)
        prefix = Path(argv[argv.index('--prefix') + 1])
        package = prefix / 'lib/node_modules/@earendil-works/pi-coding-agent'
        (package / 'node_modules/dependency').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': '99.2.0'}))
        (package / 'cli.js').write_text('candidate')
        (package / 'node_modules/dependency/index.js').write_text('dependency')
        (prefix / 'bin').mkdir()
        (prefix / 'bin/pi').symlink_to('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js')
        return subprocess.CompletedProcess(argv, 0)

    def prepare(self):
        # Network is an external boundary; bytes/integrity/filesystem are real.
        with patch.object(installer, 'download', return_value=self.data, create=True), \
                patch.object(installer.subprocess, 'run', side_effect=self.npm), \
                patch.dict(os.environ, {'SECRET_NPM_TOKEN': 'private', 'NODE_OPTIONS': '--require=evil'}):
            return installer.install(self.root, '99.2.0', self.task, release=self.release)

    def test_future_release_prepares_verified_bytes_without_candidate_execution(self):
        self.assertIn('release', __import__('inspect').signature(installer.install).parameters)
        value = self.prepare()
        self.assertTrue(value['ok'], value)
        self.assertFalse(value['changed'])
        self.assertEqual((self.root / 'bin/pi').readlink(), Path('../old'))
        self.assertEqual(value['candidate']['integrity'], self.release['integrity'])
        self.assertRegex(value['candidate']['tree_sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(len(self.calls), 1)

    def test_wrong_integrity_never_reaches_npm(self):
        self.assertIn('release', __import__('inspect').signature(installer.install).parameters)
        self.data += b'tamper'
        value = self.prepare()
        self.assertFalse(value['ok'])
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / 'bin/pi').readlink(), Path('../old'))

    def test_npm_success_cannot_hide_a_caught_transport_policy_refusal(self):
        npm = self.npm
        def swallowed(argv, **kwargs):
            result = npm(argv, **kwargs)
            Path(kwargs['env']['NODE_OPTIONS'][10:] + '.denied').write_text('refused')
            return result
        with patch.object(installer, 'download', return_value=self.data), \
                patch.object(installer.subprocess, 'run', side_effect=swallowed):
            value = installer.install(self.root, '99.2.0', self.task, release=self.release)
        self.assertFalse(value['ok'])
        self.assertEqual((self.root / 'bin/pi').readlink(), Path('../old'))

    def test_tree_digest_covers_dependencies_modes_and_internal_symlinks(self):
        self.assertTrue(callable(getattr(installer, 'tree_digest', None)))
        (self.root / 'dependency').write_text('first')
        before = installer.tree_digest(self.root)
        (self.root / 'dependency').write_text('second')
        self.assertNotEqual(before, installer.tree_digest(self.root))
        before = installer.tree_digest(self.root)
        (self.root / 'dependency').chmod(0o700)
        self.assertNotEqual(before, installer.tree_digest(self.root))
        (self.root / 'escape').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            installer.tree_digest(self.root)

    def test_verifiers_own_reads_do_not_count_atime_as_content_drift(self):
        (self.root / 'dependency').write_text('unchanged dependency')
        expected = installer.tree_digest(self.root)
        original = os.fstat
        def read_updates_atime(fd):
            value = original(fd)
            fields = list(value)
            fields[7] += 100
            return os.stat_result(fields, {'st_atime_ns': value.st_atime_ns + 100_000_000_000,
                'st_mtime_ns': value.st_mtime_ns, 'st_ctime_ns': value.st_ctime_ns})
        with patch.object(installer.os, 'fstat', side_effect=read_updates_atime):
            self.assertEqual(installer.tree_digest(self.root), expected)

    def test_volume_receipt_cannot_authorize_activation(self):
        self.assertIn('release', __import__('inspect').signature(installer.install).parameters)
        value = self.prepare()
        release_dir = self.root / '.pi-releases' / self.task
        (release_dir / 'receipt.json').write_text(json.dumps({'validated': True, **value}))
        result = installer.install(self.root, '99.2.0', self.task, 'activate', release=self.release,
                                   candidate=value['candidate'])
        self.assertFalse(result['ok'])
        self.assertEqual((self.root / 'bin/pi').readlink(), Path('../old'))

    def test_validation_without_real_behavioral_probe_is_not_compatibility(self):
        self.assertIn('release', __import__('inspect').signature(installer.install).parameters)
        value = self.prepare()
        result = installer.install(self.root, '99.2.0', self.task, 'validate', release=self.release,
                                   candidate=value['candidate'])
        self.assertEqual(result, {'ok': False, 'stage': 'compatibility_probe_unavailable'})
        self.assertEqual((self.root / 'bin/pi').readlink(), Path('../old'))


class HelperSecurity(unittest.TestCase):
    def setUp(self):
        self.docker = DockerAPI()
        self.engine = RuntimeEngine(self.docker)
        self.job = {'id': 'b' * 32, 'version': '99.2.0', 'release': artifact()[1],
                    'policy': {'images': ['sha256:' + 'c' * 64]}, 'helpers': {}}

    def test_validate_helper_is_networkless_and_readonly(self):
        try:
            definition = self.engine.definition(self.job, 'validate')
        except ValueError:
            self.fail('missing isolated validation phase')
        self.assertEqual(definition['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(definition['HostConfig']['Mounts'][0]['ReadOnly'])
        self.assertEqual(len(definition['HostConfig']['Mounts']), 1)

    def test_extra_healthcheck_cannot_execute_outside_fixed_phase_protocol(self):
        for phase in ('prepare', 'activate'):
            identity = self.engine.create(self.job, phase)
            self.assertEqual(self.docker.items[identity]['Config'].get('Healthcheck'), {'Test': ['NONE']})
            self.docker.items[identity]['Config']['Healthcheck'] = {'Test': ['CMD', '/usr/bin/true']}
            with self.assertRaises(RuntimeError):
                self.engine.inspect(self.job, phase)

    def test_changed_helper_environment_is_rejected(self):
        identity = self.engine.create(self.job, 'prepare')
        self.job['helpers']['prepare'] = {'id': identity}
        self.docker.items[identity]['Config']['Env'].append('NODE_OPTIONS=--require=/tmp/untrusted.cjs')
        with self.assertRaises(RuntimeError):
            self.engine.inspect(self.job, 'prepare')

    def test_host_pid_or_unbounded_resources_are_rejected(self):
        identity = self.engine.create(self.job, 'prepare')
        self.job['helpers']['prepare'] = {'id': identity}
        for field, value in (('PidMode', 'host'), ('Memory', 0), ('PidsLimit', 0), ('NetworkMode', 'container:other')):
            with self.subTest(field=field):
                host = self.docker.items[identity]['HostConfig']
                old = host.get(field)
                host[field] = value
                with self.assertRaises(RuntimeError):
                    self.engine.inspect(self.job, 'prepare')
                if old is None:
                    host.pop(field)
                else:
                    host[field] = old

    def test_inert_image_defaults_are_matched_to_immutable_image_not_a_narrow_whitelist(self):
        self.docker.image_env = ['HF_HOME=/home/node/.cache/huggingface',
            'HF_HUB_CACHE=/home/node/.cache/huggingface/hub', 'PI_CODING_AGENT_DIR=/home/node/.pi/agent',
            'PIP_DISABLE_PIP_VERSION_CHECK=1']
        try:
            identity = self.engine.create(self.job, 'prepare')
        except RuntimeError as error:
            self.fail('inert immutable image defaults rejected: ' + str(error))
        self.job['helpers']['prepare'] = {'id': identity}
        self.docker.items[identity]['Config']['Env'].append('HF_HOME=/tmp/changed')
        with self.assertRaises(RuntimeError):
            self.engine.inspect(self.job, 'prepare')

    def test_image_credentials_and_loader_environment_are_not_inherited(self):
        for value in ('MODEL_API_KEY=private', 'LD_PRELOAD=/tmp/evil.so', 'PYTHONPATH=/tmp/evil'):
            with self.subTest(value=value):
                self.docker.image_env = [value]
                with self.assertRaises(RuntimeError):
                    self.engine.create(self.job, 'prepare')

    def test_zero_retry_default_does_not_change_no_restart_helper_identity(self):
        identity = self.engine.create(self.job, 'prepare')
        self.job['helpers']['prepare'] = {'id': identity}
        self.docker.items[identity]['HostConfig']['RestartPolicy']['MaximumRetryCount'] = 0
        try:
            self.engine.inspect(self.job, 'prepare')
        except RuntimeError as error:
            self.fail('Docker zero-retry normalization rejected: ' + str(error))

"""Fault-test acceptance accounting only: no Docker, sockets, services or browser."""
import json
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import real_launch_acceptance as harness


class RecordingCLI:
    def __init__(self, output, lost='hub'):
        self.output, self.lost = output, lost
        self.volumes, self.containers = {}, {}
        self.calls, self.intents = [], []
        self.remove_fail, self.inspect_fail = set(), set()
        self.delayed, self.inspections = 0, {}
        self.foreign = False
        self.primary = subprocess.TimeoutExpired(['docker', 'create'], 40)

    def intent(self, kind, name):
        evidence = json.loads(self.output.read_text()) if self.output.exists() else {}
        self.intents.append(any(r['kind'] == kind and r['name'] == name for r in evidence.get('resources', [])))

    @staticmethod
    def labels(args):
        return dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')

    def command(self, *args, timeout=40):
        self.calls.append(args)
        if args[:3] == ('docker', 'volume', 'create'):
            name = args[-1]
            self.intent('volume', name)
            self.volumes[name] = {'Name': name, 'Labels': self.labels(args), 'Driver': 'local', 'Options': None}
            if name.endswith('-' + self.lost):
                raise self.primary
            return name
        if args[:2] == ('docker', 'create'):
            name = args[args.index('--name') + 1]
            self.intent('container', name)
            mounts = []
            for i, arg in enumerate(args):
                if arg == '--mount':
                    mount = dict(part.split('=', 1) for part in args[i + 1].split(',') if '=' in part)
                    mounts.append({'Type': mount['type'], 'Name': mount['source'], 'Destination': mount['target']})
            item = {'Id': f'{len(self.containers) + 1:064x}', 'Name': '/' + name,
                    'Image': next(a for a in args if a.startswith('sha256:')),
                    'Config': {'Labels': self.labels(args)}, 'Mounts': mounts}
            if self.foreign and name.endswith('-hub'):
                item['Config']['Labels'] = {'pi.launch.acceptance': 'foreign'}
            self.containers[name] = item
            if name.endswith('-' + self.lost):
                raise self.primary
            return item['Id']
        if args[:2] == ('docker', 'start'):
            return ''
        if args[:3] == ('docker', 'volume', 'inspect'):
            kind, target, records = 'volume', args[-1], self.volumes
        elif args[:2] == ('docker', 'inspect') or args[:3] == ('docker', 'container', 'inspect'):
            kind, target, records = 'container', args[-1], self.containers
        else:
            kind = None
        if kind:
            if target in self.inspect_fail:
                raise subprocess.CalledProcessError(1, args, stderr='permission denied')
            self.inspections[target] = self.inspections.get(target, 0) + 1
            item = records.get(target) or next((r for r in records.values() if r.get('Id') == target), None)
            if target.endswith('-' + self.lost) and self.inspections[target] <= self.delayed:
                item = None
            if item is None:
                message = (f'Error: No such container: {target}' if kind == 'container' else
                           f'Error response from daemon: get {target}: no such volume')
                raise subprocess.CalledProcessError(1, args, stderr=message)
            return json.dumps([item])
        if args[:2] == ('docker', 'rm'):
            target = args[-1]
            name = next((n for n, r in self.containers.items() if r['Id'] == target or n == target), None)
            if name in self.remove_fail:
                raise subprocess.CalledProcessError(1, args, stderr='injected remove failure')
            if name:
                del self.containers[name]
            return target
        if args[:3] == ('docker', 'volume', 'rm'):
            target = args[-1]
            if target in self.remove_fail or any(m['Name'] == target for c in self.containers.values() for m in c['Mounts']):
                raise subprocess.CalledProcessError(1, args, stderr='volume is in use')
            self.volumes.pop(target, None)
            return target
        raise AssertionError('Unexpected external operation: ' + repr(args))

    def run(self, args, **kwargs):
        # Cover the original harness's direct subprocess inspections too. This
        # is a hard boundary: no subprocess is ever launched by these tests.
        try:
            output = self.command(*args)
            result = subprocess.CompletedProcess(args, 0, output, '')
        except subprocess.CalledProcessError as error:
            result = subprocess.CompletedProcess(args, error.returncode, '', error.stderr)
        if not kwargs.get('text'):
            result.stdout, result.stderr = result.stdout.encode(), result.stderr.encode()
        return result


class AcceptanceCleanupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.acceptance-fault-', dir=harness.ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.namespace = 'a' * 32
        self.prefix = 'pi-launch-test-' + self.namespace
        self.output = self.root / '.tmp/launch-acceptance' / self.namespace / 'evidence.json'
        self.cli = RecordingCLI(self.output)
        self.env = {'PI_REAL_DOCKER_TEST': '1', 'PI_LAUNCH_TEST_IMAGE': 'sha256:' + '1' * 64,
                    'PI_LAUNCH_TEST_HUB_IMAGE': 'sha256:' + '2' * 64}

    def execute(self):
        failure = None
        with patch.object(harness, 'ROOT', self.root), patch.dict(harness.os.environ, self.env), \
                patch.object(harness.uuid, 'uuid4', return_value=SimpleNamespace(hex=self.namespace)), \
                patch.object(harness, 'command', side_effect=self.cli.command), \
                patch.object(harness.subprocess, 'run', side_effect=self.cli.run), \
                patch.object(harness.time, 'sleep'), patch.object(harness, 'Gate', side_effect=AssertionError('No services')):
            try:
                harness.main()
            except Exception as error:
                failure = error
        self.assertIs(failure, self.cli.primary, 'cleanup must preserve the original failure')
        self.assertTrue(self.output.exists(), 'final evidence must survive primary/teardown failures')
        return json.loads(self.output.read_text())

    def test_successful_hub_create_lost_reply_is_reconciled_and_removed_by_id(self):
        evidence = self.execute()
        self.assertEqual(self.cli.containers, {})
        self.assertEqual(self.cli.volumes, {})
        self.assertTrue(all(self.cli.intents), 'persist every exact intent before create')
        self.assertTrue(evidence['cleanup'])
        self.assertEqual(evidence['primary_failure'], 'TimeoutExpired')
        self.assertTrue(all(re.fullmatch('[a-f0-9]{64}', c[-1]) for c in self.cli.calls if c[:2] == ('docker', 'rm')))

    def test_successful_volume_create_lost_reply_is_still_owned_and_removed(self):
        self.cli.lost = 'runtime'
        evidence = self.execute()
        self.assertEqual(self.cli.volumes, {})
        self.assertTrue(all(self.cli.intents))
        self.assertTrue(evidence['cleanup'])

    def test_teardown_failure_preserves_primary_writes_evidence_and_continues(self):
        self.cli.remove_fail.add(self.prefix + '-seed')
        evidence = self.execute()
        self.assertFalse(evidence['cleanup'])
        self.assertTrue(evidence['cleanup_errors'])
        self.assertTrue(any(r['name'] == self.prefix + '-seed' for r in evidence['residual_targets']))
        self.assertNotIn(self.prefix + '-hub', self.cli.containers)
        attempted = [c[-1] for c in self.cli.calls if c[:3] == ('docker', 'volume', 'rm')]
        self.assertEqual(set(attempted), set(evidence['volumes']))

    def test_inspect_failure_is_not_absence_and_never_authorizes_removal(self):
        self.cli.inspect_fail.add(self.prefix + '-hub')
        evidence = self.execute()
        self.assertFalse(evidence['cleanup'])
        self.assertIn(self.prefix + '-hub', self.cli.containers)
        self.assertNotIn(self.prefix + '-seed', self.cli.containers)
        self.assertTrue(any(r['name'] == self.prefix + '-hub' for r in evidence['residual_targets']))

    def test_bounded_reconciliation_finds_late_create_without_replaying_it(self):
        self.cli.delayed = 2
        evidence = self.execute()
        self.assertTrue(evidence['cleanup'])
        self.assertEqual(self.cli.containers, {})
        creates = [c for c in self.cli.calls if c[:2] == ('docker', 'create') and self.prefix + '-hub' in c]
        self.assertEqual(len(creates), 1)

    def test_absence_during_unresolved_create_is_reported_uncertain(self):
        self.cli.delayed = 1000
        evidence = self.execute()
        self.assertFalse(evidence['cleanup'])
        self.assertLess(self.cli.inspections.get(self.prefix + '-hub', 0), 10)
        self.assertTrue(any(r['name'] == self.prefix + '-hub' and r['cleanup'] == 'uncertain'
                            for r in evidence['residual_targets']))

    def test_foreign_namespace_label_never_authorizes_cleanup(self):
        self.cli.foreign = True
        evidence = self.execute()
        self.assertFalse(evidence['cleanup'])
        self.assertIn(self.prefix + '-hub', self.cli.containers)
        self.assertNotIn(self.prefix + '-seed', self.cli.containers)

    def journal(self):
        self.output.parent.mkdir(parents=True, exist_ok=True)
        return harness.DisposableResources({'namespace': self.namespace, 'cleanup': False}, self.output)

    def test_gate_close_failure_still_cleans_resources_and_persists_failure(self):
        resources = self.journal()
        with patch.object(harness, 'command', side_effect=self.cli.command):
            resources.create_volume(self.prefix + '-home')
            gate = SimpleNamespace(close=lambda: (_ for _ in ()).throw(OSError('close failed')))
            self.assertFalse(resources.finish(gate))
        evidence = json.loads(self.output.read_text())
        self.assertEqual(self.cli.volumes, {})
        self.assertEqual(evidence['cleanup_errors'][0]['operation'], 'gate.close')
        self.assertEqual(evidence['residual_targets'], [])

    def test_temporary_directory_teardown_failure_preserves_primary_and_evidence(self):
        base = self.root / 'synthetic-temporary'
        base.mkdir()

        class Temporary:
            name = str(base)

            def __enter__(self):
                return self.name

            def __exit__(self, *_):
                self.cleanup()

            def cleanup(self):
                raise OSError('temporary teardown failed')

        with patch.object(harness.tempfile, 'TemporaryDirectory', return_value=Temporary()):
            evidence = self.execute()
        self.assertFalse(evidence['cleanup'])
        self.assertTrue(any(e['operation'] == 'temporary.cleanup' for e in evidence['cleanup_errors']))
        self.assertEqual(self.cli.containers, {})
        self.assertEqual(self.cli.volumes, {})

    def test_gate_launch_cleanup_requires_exact_policy_image_and_namespace_volumes(self):
        resources = self.journal()
        names = [self.prefix + '-' + key for key in ('home', 'runtime', 'config', 'credentials', 'cache', 'hub_runtime')]
        resource = resources.intent('container', 'pi-gate-launch-' + 'b' * 32, image='sha256:' + '1' * 64,
                                    launch_id='b' * 32, policy_revision='c' * 64, volumes=names)
        good = {'Id': 'd' * 64, 'Name': '/' + resource['name'], 'Image': resource['image'],
                'Config': {'Labels': {'cn.swordfate.pi.launch-id': 'b' * 32, 'cn.swordfate.pi.launch-policy': 'c' * 64}},
                'Mounts': [{'Type': 'volume', 'Name': name} for name in names]}
        for changed in (dict(good, Image='sha256:' + 'e' * 64), dict(good, Name='/unrelated'),
                        dict(good, Config={'Labels': {'cn.swordfate.pi.launch-id': 'b' * 32}}),
                        dict(good, Mounts=[{'Type': 'volume', 'Name': 'production-volume'}])):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                resources.prove(resource, changed)
        self.cli.containers[resource['name']] = good
        with patch.object(harness, 'command', side_effect=self.cli.command):
            self.assertTrue(resources.finish())
        self.assertEqual(self.cli.containers, {})
        self.assertIn(('docker', 'rm', '-f', 'd' * 64), self.cli.calls)


if __name__ == '__main__':
    unittest.main()

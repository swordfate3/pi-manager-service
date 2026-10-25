"""Measured-source admission: real Gate ledger, substituted Docker boundary only."""
import ast
import copy
import io
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

from gate.runtime_engine import RuntimeEngine
from gate.runtime_install import CHECKS, digest
from gate.runtime_updates import RuntimeUpdates
from gate.service import Gate
from test_runtime_engine import DockerAPI
import test_runtime_updates as base


def source(version='1.1.0', tree='7'):
    package = '/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent'
    return {'contract': 'pi-runtime-source-v1', 'package': package,
            'executable': package + '/dist/cli.js', 'version': version,
            'node': '>=24.0.0', 'tree_sha256': tree * 64}


def proof(identity, profile):
    return {'ok': True, 'source_hash': digest(identity), 'profile_hash': digest(profile),
            'node': '24.21.0', 'checks': {name: True for name in CHECKS}}


class HelperDocker(DockerAPI):
    def call(self, method, path, value=None, **kwargs):
        result = super().call(method, path, value, **kwargs)
        if path.startswith('/containers/create?'):
            self.items[result['Id']]['Mounts'][0]['RW'] = not value['HostConfig']['Mounts'][0]['ReadOnly']
        return result


class SourceHelperTests(unittest.TestCase):
    def setUp(self):
        self.docker = HelperDocker()
        self.engine = RuntimeEngine(self.docker)
        self.identity = source()
        self.key = digest(self.identity)
        self.phase = 'source-' + self.key
        self.job = {'id': 'b' * 32, 'version': '1.4.0', 'policy': {'images': [base.IMAGE]},
                    'profile': {'contract': 'test-profile', 'probe_sha256': '8' * 64, 'image': base.IMAGE},
                    'sources': {self.key: {'identity': self.identity}}, 'helpers': {}}

    def exited(self, value):
        cid = self.engine.create(self.job, self.phase)
        self.job['helpers'][self.phase] = {'id': cid, 'intent_at': 1}
        self.docker.items[cid]['State'] = {'Status': 'exited', 'Running': False, 'ExitCode': 0}
        self.docker.logs[cid] = value
        return cid

    def test_source_helper_is_fixed_offline_readonly_and_identity_specific(self):
        definition = self.engine.definition(self.job, self.phase)
        self.assertEqual(definition['Image'], base.IMAGE)
        self.assertEqual(definition['Entrypoint'], ['/usr/bin/python3', '-I', '-c'])
        self.assertEqual(json.loads(definition['Cmd'][-1]),
                         {'source': self.identity, 'profile': self.job['profile']})
        self.assertEqual(definition['User'], '1000:1000')
        self.assertEqual(definition['Healthcheck'], {'Test': ['NONE']})
        self.assertEqual(definition['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(definition['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(definition['HostConfig']['Mounts'], [{'Type': 'volume', 'Source': 'pi-runtime',
            'Target': '/home/node/.local', 'ReadOnly': True, 'VolumeOptions': {'NoCopy': True}}])
        self.assertEqual(set(definition['HostConfig']['Tmpfs']), {'/tmp'})
        self.assertTrue(self.engine.name(self.job, self.phase).endswith(self.phase))

    def test_source_helper_refuses_profile_for_another_approved_image(self):
        other = 'sha256:' + 'e' * 64
        self.job['policy']['images'].append(other)
        self.job['profile']['image'] = other
        with self.assertRaisesRegex(RuntimeError, 'image_profile_mismatch'):
            self.engine.create(self.job, self.phase)
        self.assertEqual(self.docker.calls, [])

    def test_embedded_entry_calls_fixed_source_launcher_and_bounds_failure(self):
        definition = self.engine.definition(self.job, self.phase)
        statements = ast.parse(definition['Cmd'][0]).body
        namespace = {'__name__': 'source_helper_test'}
        exec(compile(ast.Module(body=statements[:-3], type_ignores=[]), '<helper>', 'exec'), namespace)
        seen = []
        expected = proof(self.identity, self.job['profile'])
        def launch(request, *, mode):
            seen.append((request, mode))
            return expected
        namespace['run_probe'] = launch
        entry = compile(ast.Module(body=statements[-3:], type_ignores=[]), '<entry>', 'exec')
        output = io.StringIO()
        with patch.object(sys, 'argv', ['-c', definition['Cmd'][-1]]), patch('sys.stdout', output):
            with self.assertRaises(SystemExit) as exited:
                exec(entry, namespace)
        self.assertEqual(exited.exception.code, 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertEqual(seen, [({'source': self.identity, 'profile': self.job['profile']}, '--source')])
        def refuse(*args, **kwargs):
            raise RuntimeError('sensitive child details')
        namespace['run_probe'] = refuse
        output = io.StringIO()
        with patch.object(sys, 'argv', ['-c', definition['Cmd'][-1]]), patch('sys.stdout', output):
            with self.assertRaises(SystemExit) as exited:
                exec(entry, namespace)
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'stage': 'compatibility_probe_failed'})

    def test_closed_identity_and_phase_hash_are_checked_before_create(self):
        for change in ({'package': '/tmp/untrusted'}, {'executable': '/home/node/.local/other.js'},
                       {'tree_sha256': 'not-a-hash'}, {'extra': True}, {'version': 'latest'}):
            with self.subTest(change=change):
                self.job['sources'][self.key]['identity'] = {**self.identity, **change}
                with self.assertRaises(ValueError):
                    self.engine.create(self.job, self.phase)
        self.assertEqual(self.docker.calls, [])

    def test_only_closed_all_observed_bound_source_evidence_succeeds(self):
        expected = proof(self.identity, self.job['profile'])
        cid = self.exited(expected)
        self.assertEqual(self.engine.poll(self.job, self.phase), {'state': 'succeeded', 'evidence': expected})
        mutations = [{'source_hash': '0' * 64}, {'profile_hash': '0' * 64}, {'node': '23.0.0'},
                     {'node': '24.0'}, {'checks': {name: 1 for name in CHECKS}},
                     {'checks': {name: True for name in CHECKS[:-1]}}, {'extra': True}, {'ok': 1}]
        for change in mutations:
            with self.subTest(change=change):
                self.docker.logs[cid] = {**expected, **change}
                self.assertEqual(self.engine.poll(self.job, self.phase), {'state': 'unknown'})

    def test_inspection_rejects_source_helper_mutation(self):
        cid = self.exited(proof(self.identity, self.job['profile']))
        original = copy.deepcopy(self.docker.items[cid])
        for mutate in (lambda item: item['Mounts'][0].update(RW=True),
                       lambda item: item['HostConfig'].update(NetworkMode='host'),
                       lambda item: item['Config'].update(Healthcheck={'Test': ['CMD', 'true']}),
                       lambda item: item['Config']['Env'].append('NODE_OPTIONS=--require=/tmp/evil'),
                       lambda item: item['Config']['Cmd'].append('/tmp/evil')):
            self.docker.items[cid] = copy.deepcopy(original)
            mutate(self.docker.items[cid])
            with self.assertRaises(RuntimeError):
                self.engine.inspect(self.job, self.phase)

    def test_source_helper_is_included_in_recovery_quiescence(self):
        cid = self.exited(proof(self.identity, self.job['profile']))
        self.engine.quiescent(self.job)
        self.docker.items[cid]['State'] = {'Status': 'running', 'Running': True}
        with self.assertRaises(RuntimeError):
            self.engine.quiescent(self.job)

    def test_created_orphan_is_adopted_but_a_running_source_orphan_is_not_replayed(self):
        cid = self.engine.create(self.job, self.phase)
        self.assertEqual(self.engine.create(self.job, self.phase), cid)
        self.docker.items[cid]['State'] = {'Status': 'running', 'Running': True}
        with self.assertRaises(RuntimeError):
            self.engine.create(self.job, self.phase)
        self.job['helpers'][self.phase] = {'id': cid, 'intent_at': 1}
        self.docker.items.pop(cid)
        calls = len(self.docker.calls)
        with self.assertRaises(RuntimeError):
            self.engine.create(self.job, self.phase)
        self.assertEqual(self.engine.poll(self.job, self.phase), {'state': 'unknown'})
        self.assertEqual(len(self.docker.calls), calls)

    def test_explicit_source_probe_failure_is_bounded_and_non_successful(self):
        cid = self.exited({'ok': False, 'stage': 'compatibility_probe_failed'})
        self.docker.items[cid]['State']['ExitCode'] = 1
        self.assertEqual(self.engine.poll(self.job, self.phase),
                         {'state': 'failed', 'stage': 'compatibility_probe_failed'})


class SourceBoundary(base.InstallBoundary):
    consumer_blocker = staticmethod(RuntimeEngine.consumer_blocker)

    def __init__(self, docker):
        super().__init__(docker)
        self.source_starts = []
        self.pending_sources = set()
        self.bad_source = False
        self.on_source_create = lambda job, phase: None

    def create(self, job, phase):
        if not phase.startswith('source-'):
            return super().create(job, phase)
        key = digest({'phase': phase, 'job': job['id']})
        if key not in self.helpers:
            self.helpers[key] = {'State': {'Status': 'created', 'Running': False}, 'phase': phase}
        self.on_source_create(job, phase)
        return key

    def start(self, job, phase=None):
        if not phase or not phase.startswith('source-'):
            return super().start(job, phase)
        self.before_start(job, phase)
        self.source_starts.append(phase)
        self.helpers[job['helpers'][phase]['id']]['State'].update(Status='running', Running=True)

    def poll(self, job, phase=None):
        if not phase or not phase.startswith('source-'):
            return super().poll(job, phase)
        helper = self.helpers.get(job['helpers'][phase]['id'])
        if helper is None or helper['State']['Status'] == 'created':
            return {'state': 'unknown'}
        if phase in self.pending_sources:
            return {'state': 'running'}
        identity = job['sources'][phase[7:]]['identity']
        evidence = proof(identity, job['profile'])
        if self.bad_source:
            evidence['checks']['no_replay'] = False
        helper['State'].update(Status='exited', Running=False)
        return {'state': 'succeeded', 'evidence': evidence}


class SourceSchedulerTests(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp

    def manager(self):
        manager = base.RuntimeUpdatesTest.manager(self)
        self.install = SourceBoundary(self.docker)
        manager.runtime_engine = self.install
        for state in self.docker.states.values():
            state['source_identity'] = source()
        return manager

    def submit(self):
        manager = self.manager()
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        return manager

    def install_until(self, manager, stage, limit=20):
        for _ in range(limit):
            job = manager._get(base.KEY)
            if job['stage'] == stage or job['status'] not in ('queued', 'running'):
                return job
            manager._install(job)
        self.fail('source scheduler did not reach ' + stage)

    def test_readiness_is_evaluable_not_compatible_and_never_starts_helper(self):
        manager = self.manager()
        readiness = manager.readiness()
        self.assertEqual(readiness['status'], 'ready')
        self.assertEqual({row['source_status'] for row in readiness['consumers']}, {'evaluable'})
        self.assertEqual(self.install.helpers, {})
        for state in self.docker.states.values():
            state.pop('source_identity')
        self.assertEqual(manager.readiness()['status'], 'blocked')

    def test_other_approved_image_is_blocked_in_readiness_without_probing(self):
        manager = self.manager()
        other = 'sha256:' + 'e' * 64
        manager.set_policy({'mode': 'auto', 'images': [base.IMAGE, other]})
        self.docker.items['2' * 64]['Image'] = other
        readiness = manager.readiness()
        self.assertEqual(readiness['status'], 'blocked')
        rows = {row['run_id']: row for row in readiness['consumers']}
        self.assertTrue(rows['1' * 32]['ready'])
        self.assertFalse(rows['2' * 32]['ready'])
        self.assertEqual(rows['2' * 32]['reason'], 'image_profile_mismatch')
        self.assertNotEqual(rows['2' * 32].get('source_status'), 'verified')
        self.assertEqual(self.install.helpers, {})

    def test_other_approved_image_cannot_launch_a_source_probe_or_prepare(self):
        manager = self.manager()
        other = 'sha256:' + 'e' * 64
        manager.set_policy({'mode': 'auto', 'images': [base.IMAGE, other]})
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.docker.items['2' * 64]['Image'] = other
        manager._install(manager._get(base.KEY))
        self.assertEqual(self.install.source_starts, [])
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_proof_is_not_transferable_to_another_policy_approved_image(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        item, state = manager._inventory(job)[0]
        other = 'sha256:' + 'e' * 64
        job['policy'] = {**job['policy'], 'images': [base.IMAGE, other]}
        self.assertEqual(manager.source_proof(job, item, state), proof(source(), job['profile']))
        with self.assertRaisesRegex(RuntimeError, 'image_profile_mismatch'):
            manager.source_proof(job, {**item, 'Image': other}, state)
        job['profile'] = {**job['profile'], 'image': other}
        job['sources'][digest(source())]['evidence'] = proof(source(), job['profile'])
        with self.assertRaisesRegex(RuntimeError, 'image_profile_mismatch'):
            manager.source_proof(job, {**item, 'Image': other}, state)

    def test_invalid_or_missing_identity_never_prepares_or_activates(self):
        manager = self.submit()
        self.docker.states['1' * 64].pop('source_identity')
        manager._install(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'failed')
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(self.install.source_starts, [])
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_one_proof_for_identical_sources_is_durable_and_bound_before_start(self):
        manager = self.submit()
        observed = []
        def before_start(job, phase):
            saved = manager._get(base.KEY)
            self.assertEqual(saved['helpers'][phase]['id'], job['helpers'][phase]['id'])
            self.assertGreater(saved['helpers'][phase]['intent_at'], 0)
            if phase.startswith('source-'):
                self.assertEqual(saved['sources'][phase[7:]]['identity'], source())
                observed.append(phase)
        self.install.before_start = before_start
        job = self.install_until(manager, 'refreshing')
        self.assertEqual(job['stage'], 'refreshing')
        self.assertEqual(len(observed), 1)
        self.assertEqual(self.docker.installed, '1.4.0')
        self.assertEqual(manager.readiness()['consumers'][0]['source_status'], 'verified')
        item, state = manager._inventory(job)[0]
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        restored = RuntimeUpdates(self.gate)
        restored.runtime_engine = self.install
        restored.gate.lifecycle.engine = self.docker
        self.assertEqual(restored.source_proof(restored._get(base.KEY), item, state),
                         proof(source(), job['profile']))

    def test_later_source_invalid_evidence_is_not_hidden_by_an_earlier_new_source(self):
        manager = self.submit()
        job = self.install_until(manager, 'validated')
        changed = source(tree='9')
        self.docker.states['1' * 64]['source_identity'] = changed
        sources = copy.deepcopy(job['sources'])
        sources[digest(source())]['evidence']['checks']['no_replay'] = False
        job = manager._update(base.KEY, sources=sources)
        with self.assertRaises(ValueError):
            manager._ensure_sources(job, manager._inventory(job))
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_source_running_is_polled_after_restart_without_restarting(self):
        manager = self.submit()
        phase = 'source-' + digest(source())
        self.install.pending_sources.add(phase)
        manager._install(manager._get(base.KEY))
        self.assertEqual(self.install.source_starts, [phase])
        self.assertEqual(self.install.starts, 0)
        restored = RuntimeUpdates(self.gate)
        restored.runtime_engine, restored.catalog = self.install, manager.catalog
        restored._install(restored._get(base.KEY))
        self.assertEqual(self.install.source_starts, [phase])
        self.install.pending_sources.clear()
        self.assertEqual(self.install_until(restored, 'refreshing')['stage'], 'refreshing')

    def test_disappearing_consumer_does_not_abandon_an_inflight_source_helper(self):
        manager = self.submit()
        phase = 'source-' + digest(source())
        self.install.pending_sources.add(phase)
        manager._install(manager._get(base.KEY))
        self.docker.items.clear()
        self.docker.states.clear()
        manager._install(manager._get(base.KEY))
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        self.install.pending_sources.clear()
        self.assertEqual(self.install_until(manager, 'refreshing')['stage'], 'refreshing')

    def test_persisted_source_intent_never_reissues_start_when_still_created(self):
        manager = self.submit()
        def interrupted_start(job, phase):
            if phase.startswith('source-'):
                raise TimeoutError('start transport result lost')
            return base.InstallBoundary.start(self.install, job, phase)
        self.install.start = interrupted_start
        manager._install(manager._get(base.KEY))
        job = manager._get(base.KEY)
        self.assertEqual(job['status'], 'recovery_required')
        saved = next(iter(job['helpers'].values()))
        self.assertGreater(saved['intent_at'], 0)
        self.assertEqual(self.install.starts, 0)

    def test_recovered_created_source_intent_polls_once_without_reissuing_start(self):
        manager = self.submit()
        phase, identity = 'source-' + digest(source()), source()
        job = manager._update(base.KEY, status='running', stage='preparing',
                              sources={digest(identity): {'identity': identity}}, helpers={})
        cid = self.install.create(job, phase)
        manager._update(base.KEY, helpers={phase: {'id': cid, 'intent_at': 1}})
        manager._install(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(self.install.source_starts, [])
        self.assertEqual(self.install.starts, 0)

    def test_helper_failure_or_unbound_proof_never_activates(self):
        manager = self.submit()
        self.install.bad_source = True
        self.install_until(manager, 'refreshing')
        self.assertNotEqual(manager.get(base.KEY)['status'], 'succeeded')
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertEqual(self.install.starts, 0)

    def test_new_source_between_validation_and_activation_is_evaluated(self):
        manager = self.submit()
        job = self.install_until(manager, 'validated')
        self.assertEqual(job['stage'], 'validated')
        changed = source(tree='9')
        self.docker.states['2' * 64]['source_identity'] = changed
        phase = 'source-' + digest(changed)
        self.install.pending_sources.add(phase)
        manager._install(job)
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertIn(phase, self.install.source_starts)
        self.install.pending_sources.clear()
        self.assertEqual(self.install_until(manager, 'refreshing')['stage'], 'refreshing')

    def test_source_drift_during_activation_create_is_reinventoried(self):
        manager = self.submit()
        job = self.install_until(manager, 'validated')
        original = self.install.create
        changed = source(tree='9')
        def create(job, phase):
            result = original(job, phase)
            if phase == 'activate':
                self.docker.states['2' * 64]['source_identity'] = changed
            return result
        self.install.create = create
        self.install.pending_sources.add('source-' + digest(changed))
        manager._install(job)
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_unknown_source_after_activation_is_recovery_not_a_version_grant(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        self.docker.states['1' * 64].update(version='1.4.0', source_identity=source('1.4.0', '9'))
        manager._refresh(job)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(self.gate.lifecycle._jobs(), [])
        self.assertEqual(len(self.install.source_starts), 1)

    def completed_changed_source_child(self, manager, job):
        manager._refresh(job)
        child = self.gate.lifecycle._jobs()[0]
        identity = source('1.4.0', '9')
        package = '/home/node/.local/.pi-releases/' + base.KEY + '/lib/node_modules/@earendil-works/pi-coding-agent'
        identity.update(package=package, executable=package + '/dist/cli.js')
        original = self.docker.lifecycle_control
        def control(cid, request, timeout=None):
            response = original(cid, request, timeout)
            if request['action'] == 'restart':
                self.docker.states[cid]['source_identity'] = copy.deepcopy(identity)
            return response
        self.docker.lifecycle_control = control
        child = self.gate.lifecycle._update(child['id'], status='running', stage='validating',
                                           started_at=int(time.time() * 1000))
        self.gate.lifecycle._execute(child)
        child = self.gate.lifecycle._get(child['id'])
        self.assertEqual(child['status'], 'succeeded')
        self.assertEqual(self.docker.states[child['container_id']]['source_identity'], identity)
        return child, identity

    def test_successful_child_new_source_is_probed_before_next_child_or_completion(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        phase = 'source-' + digest(identity)
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        result = manager._get(base.KEY)
        self.assertEqual(result['status'], 'running')
        self.assertEqual(result['targets'][0]['status'], 'validating_source')
        self.assertEqual(result['targets'][0]['source_adoption']['source_hash'], digest(identity))
        self.assertEqual(result['targets'][0]['source_adoption']['restart_id'], child['id'])
        self.assertIn(phase, self.install.source_starts)
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        self.assertEqual(len(self.docker.restarts), 1)
        self.install.pending_sources.clear()
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(len(self.gate.lifecycle._jobs()), 2)
        item = self.docker.items[child['container_id']]
        state = self.docker.states[child['container_id']]
        self.assertEqual(manager.source_proof(manager._get(base.KEY), item, state),
                         proof(identity, result['profile']))

    def test_target_source_adoption_survives_gate_restart_without_restarting_probe(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        phase = 'source-' + digest(identity)
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        restored = self.gate.runtime_updates
        restored.runtime_engine = self.install
        self.gate.lifecycle.engine = self.docker
        restored._refresh(restored._get(base.KEY))
        self.assertEqual(self.install.source_starts.count(phase), 1)
        self.install.pending_sources.clear()
        restored._refresh(restored._get(base.KEY))
        restored._refresh(restored._get(base.KEY))
        self.assertEqual(restored._get(base.KEY)['targets'][0]['status'], 'succeeded')
        self.assertEqual(self.install.source_starts.count(phase), 1)
        self.assertEqual(len(self.docker.restarts), 1)

    def test_target_source_adoption_rechecks_exact_identity_after_probe(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        phase = 'source-' + digest(identity)
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        self.install.pending_sources.clear()
        original = self.install.poll
        def poll(job, current_phase=None):
            outcome = original(job, current_phase)
            if current_phase == phase:
                self.docker.states[child['container_id']]['source_identity']['tree_sha256'] = '8' * 64
            return outcome
        self.install.poll = poll
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)

    def test_failed_target_source_probe_never_completes_or_dispatches_another_child(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        self.completed_changed_source_child(manager, job)
        self.install.bad_source = True
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)

    def test_completion_requires_observed_target_source_and_fresh_inventory(self):
        manager = self.submit()
        self.docker.items.pop('2' * 64)
        self.docker.states.pop('2' * 64)
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        phase = 'source-' + digest(identity)
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        self.install.pending_sources.clear()
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'succeeded')
        self.assertEqual(len(self.docker.restarts), 1)
        self.assertEqual(manager._get(base.KEY)['sources'][digest(identity)]['evidence'],
                         proof(identity, job['profile']))

    def test_child_adoption_rejects_unverified_or_mismatched_success_claims(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        job = manager._get(base.KEY)
        target = job['targets'][0]
        item, state = next(pair for pair in manager._inventory(job) if pair[0]['Id'] == child['container_id'])
        for change in ({'status': 'running'}, {'runtime_update_id': 'f' * 32},
                       {'container_id': 'f' * 64}, {'new_runtime_id': 'unobserved-runtime'},
                       {'expected_version': '99.0.0'}, {'session_id': 'other-session'},
                       {'leaf_id': 'other-leaf'}, {'source_hash': '0' * 64}):
            with self.subTest(change=change), self.assertRaises((ValueError, RuntimeError)):
                manager._target_adoption(job, target, item, state, {**child, **change})

    def test_exited_adoption_consumer_does_not_abandon_pending_source_helper(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        phase = 'source-' + digest(identity)
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        self.docker.items.pop(child['container_id'])
        self.docker.states.pop(child['container_id'])
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'running')
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        self.install.pending_sources.clear()
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(len(self.gate.lifecycle._jobs()), 2)

    def test_activation_intent_reconciles_outcome_before_new_source_recovery(self):
        manager = self.submit()
        job = self.install_until(manager, 'validated')
        cid = self.install.create(job, 'activate')
        job = manager._update(base.KEY, stage='activating', helpers={**job['helpers'],
            'activate': {'id': cid, 'intent_at': 1}})
        self.docker.installed = '1.4.0'
        self.docker.states['1' * 64]['source_identity'] = source(tree='9')
        manager._install(job)
        self.assertEqual(manager.get(base.KEY)['stage'], 'refreshing')
        manager._refresh(manager._get(base.KEY))
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')

    def test_proof_binding_and_authorize_child_reject_source_drift(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        item, state = manager._inventory(job)[0]
        expected = proof(source(), job['profile'])
        self.assertEqual(manager.source_proof(job, item, state), expected)
        for changed in ({**state, 'source_identity': source(tree='9')},
                        {**state, 'version': '1.4.0'}):
            with self.subTest(changed=changed), self.assertRaises((ValueError, RuntimeError)):
                manager.source_proof(job, item, changed)
        job['profile'] = {**job['profile'], 'probe_sha256': 'different'}
        with self.assertRaises((ValueError, RuntimeError)):
            manager.source_proof(job, item, state)

    def test_child_authorization_rechecks_live_source_and_bound_child_hash(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        manager._refresh(job)
        child = self.gate.lifecycle._jobs()[0]
        self.assertEqual(child['source_hash'], digest(source()))
        manager.authorize_child(child)
        self.docker.states[child['container_id']]['source_identity'] = source(tree='9')
        with self.assertRaises((ValueError, RuntimeError)):
            manager.authorize_child(child)

    def test_child_without_exact_source_hash_cannot_use_an_existing_proof(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        manager._refresh(job)
        child = self.gate.lifecycle._jobs()[0]
        child.pop('source_hash')
        with self.assertRaises(RuntimeError):
            manager.authorize_child(child)

    def test_restore_pre_stop_refusal_blocks_parent_without_busy_retry(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        manager._refresh(job)
        child = self.gate.lifecycle._jobs()[0]
        self.gate.lifecycle._update(child['id'], status='stale', stage='restore_pre_stop_failed')
        manager._refresh(manager._get(base.KEY))
        result = manager.get(base.KEY)
        self.assertEqual(result['status'], 'recovery_required')
        self.assertEqual(result['stage'], 'restore_pre_stop_failed')
        self.assertEqual(result['targets'][0]['status'], 'blocked')
        self.assertEqual(result['targets'][0]['wait_reason'], 'restore_pre_stop_failed')
        self.assertEqual(self.docker.restarts, [])
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)


if __name__ == '__main__':
    unittest.main()

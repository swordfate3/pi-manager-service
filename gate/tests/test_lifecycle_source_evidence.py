"""R2: ordinary lifecycle admission and real supervisor no-proof integration.

Docker, offline helper and child process boundaries are synthetic; these tests
are not real Pi acceptance. No production endpoints or sessions are touched.
"""
import copy
from pathlib import Path
import tempfile
import unittest

from gate.runtime_install import digest
from gate.service import Gate
import test_lifecycle as lifecycle_base
import test_runtime_updates as base
from test_runtime_source_validation import proof
import test_runtime_supervisor_fences as supervisor_base


class LifecycleSourceEvidence(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager
    pump = base.RuntimeUpdatesTest.pump

    def setup_restart(self, evidence=True):
        manager = self.manager()
        self.life = self.gate.lifecycle
        self.life.set_policy({'mode': 'auto', 'images': [base.IMAGE]})
        self.cid = '1' * 64
        state = self.docker.states[self.cid]
        state.update(version='99.0.0', source_identity=base.measured_source('99.0.0'))
        self.docker.installed = '99.0.0'
        self.body = {**{k: state[k] for k in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                     'idempotency_key': 'a' * 32}
        if evidence:
            manager.submit({'version': '99.0.0', 'idempotency_key': base.KEY})
            job = manager._get(base.KEY)
            job = manager._update(base.KEY, candidate=self.install.candidate(job))
            manager._update(base.KEY, status='succeeded', stage='complete',
                            evidence=self.install.evidence(job), installed_version='99.0.0',
                            sources={digest(state['source_identity']): {
                                'identity': copy.deepcopy(state['source_identity']),
                                'evidence': proof(state['source_identity'], job['profile'])}})
        return manager

    def attempt(self):
        try:
            self.life.submit(self.body)
        except (RuntimeError, ValueError):
            return
        self.pump()

    def test_unproved_future_stable_release_cannot_dispatch_ordinary_restart(self):
        self.setup_restart(evidence=False)
        self.attempt()
        self.assertEqual(self.docker.restarts, [])

    def test_target_explains_missing_evidence_without_claiming_the_container_is_legacy(self):
        self.setup_restart(evidence=False)
        self.assertEqual(self.life.target(self.body['run_id']),
                         {'managed': False, 'reason': 'source_evidence_unavailable'})

    def test_matching_source_target_is_available_even_when_update_policy_is_disabled(self):
        manager = self.setup_restart()
        manager.set_policy({'mode': 'disabled', 'images': [base.IMAGE]})
        target = self.life.target(self.body['run_id'])
        self.assertTrue(target['managed'])
        self.assertEqual(target['version'], '99.0.0')

    def test_matching_gate_evidence_keeps_validated_restart_useful_with_restore_grant(self):
        self.setup_restart()
        requests = []
        control = self.docker.lifecycle_control
        def capture(cid, request, timeout=None):
            if request['action'] == 'restart':
                requests.append(copy.deepcopy(request))
            return control(cid, request, timeout=timeout)
        self.docker.lifecycle_control = capture
        self.attempt()
        self.assertEqual(self.life.get(self.body['idempotency_key'])['status'], 'succeeded')
        self.assertEqual(len(requests), 1)
        self.assertIn('restore_proof', requests[0], 'ordinary restart bypassed existing restore machinery')

    def test_source_mutation_after_submit_is_refused_at_live_boundary(self):
        self.setup_restart()
        self.life.submit(self.body)
        self.docker.states[self.cid]['source_identity']['tree_sha256'] = '8' * 64
        self.pump()
        self.assertEqual(self.docker.restarts, [])

    def test_profile_change_after_submit_invalidates_existing_record(self):
        self.setup_restart()
        self.life.submit(self.body)
        profile = self.install.profile
        self.install.profile = lambda job: {**profile(job), 'adapter_sha256': 'f' * 64}
        self.pump()
        self.assertEqual(self.docker.restarts, [])

    def test_mismatched_gate_profile_cannot_admit_restart(self):
        manager = self.setup_restart()
        saved = manager._get(base.KEY)
        manager._update(base.KEY, profile={**saved['profile'], 'adapter_sha256': 'f' * 64})
        self.attempt()
        self.assertEqual(self.docker.restarts, [])

    def test_restore_work_cannot_make_the_final_source_or_profile_fence_stale(self):
        from unittest.mock import patch
        manager = self.setup_restart()
        for field in ('source', 'profile'):
            with self.subTest(field=field):
                key = ('c' if field == 'source' else 'd') * 32
                self.body['idempotency_key'] = key
                original = copy.deepcopy(self.docker.states[self.cid]['source_identity'])
                profile = self.install.profile
                def restored(life, job, item, state, outer):
                    job = life._update(job['id'], restore_proof={'synthetic_scheduler_fixture': True})
                    if field == 'source':
                        self.docker.states[self.cid]['source_identity']['tree_sha256'] = '8' * 64
                    else:
                        self.install.profile = lambda current: {**profile(current), 'adapter_sha256': 'f' * 64}
                    return job
                with patch('gate.runtime_restore.prepare_refresh', side_effect=restored):
                    self.life.submit(self.body)
                    self.pump()
                self.assertEqual(self.docker.restarts, [])
                self.assertNotIn('intent_at', self.life._get(key))
                self.docker.states[self.cid]['source_identity'] = original
                self.install.profile = profile


class LifecycleSupervisorNoProof(unittest.TestCase):
    setUp = supervisor_base.SupervisorFences.setUp
    release = supervisor_base.SupervisorFences.release
    run_restart = supervisor_base.SupervisorFences.run_restart

    def same_version(self):
        self.capture.close()
        self.supervisor.restore_capture = None
        self.request.pop('restore_proof')
        self.entry.unlink()
        self.entry.symlink_to(self.source / 'bin/pi')
        self.successor['version'] = '1.3.0'
        self.supervisor.installed_version = lambda: '1.3.0'

    def test_live_supervisor_denies_same_version_restart_without_proof(self):
        self.same_version()
        self.run_restart()
        self.assertEqual(self.old.signals, [], 'no-proof live restart signaled the original child')
        self.assertEqual(self.launches, [])

    def test_probe_environment_cannot_enable_no_proof_live_restart(self):
        from unittest.mock import patch
        self.same_version()
        with patch.dict('os.environ', {'PI_RUNTIME_PROBE_STATE': str(self.root),
                                      'PI_RUNTIME_PROBE_LOCAL': '1',
                                      'PI_RUNTIME_ALLOW_UNPROVED_RESTART': '1'}):
            self.run_restart()
        self.assertEqual(self.old.signals, [])
        self.assertEqual(self.launches, [])

    def test_source_change_after_prepare_is_caught_before_the_final_stop(self):
        extension = self.supervisor.extension_request
        def changed(request):
            response = extension(request)
            if request['action'] == 'prepare':
                (self.source / 'lib/node_modules/@earendil-works/pi-coding-agent/dependency.js').write_text('changed')
            return response
        self.supervisor.extension_request = changed
        self.run_restart()
        self.assertEqual(self.old.signals, [])
        self.assertEqual(self.launches, [])

    def test_actual_lifecycle_to_supervisor_path_cannot_stop_an_unproved_source(self):
        self.same_version()
        temporary = tempfile.TemporaryDirectory(prefix='lifecycle-evidence-')
        self.addCleanup(temporary.cleanup)
        gate = Gate(Path(temporary.name))
        self.addCleanup(gate.close)
        engine = lifecycle_base.FakeEngine()
        life = gate.lifecycle
        life.engine = engine
        life.set_policy({'mode': 'auto', 'images': [base.IMAGE]})

        def control(cid, request, timeout=None):
            self.assertEqual(cid, lifecycle_base.CID)
            if request['action'] == 'restart':
                self.request = request
                operation = self.run_restart()
                return {'ok': True, 'result': operation}
            self.assertEqual(request, {'action': 'status'})
            return {'ok': True, 'result': {**self.supervisor.snapshot(), 'managed': True,
                                          'operation': self.supervisor.operation}}

        engine.lifecycle_control = control
        body = {**{k: self.frozen[k] for k in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                'idempotency_key': 'b' * 32}
        try:
            life.submit(body)
        except (RuntimeError, ValueError):
            pass
        else:
            gate.tick()
            if gate.worker:
                gate.worker.join(3)
                self.assertFalse(gate.worker.is_alive())
        self.assertEqual(self.old.signals, [], 'Gate and supervisor both accepted an unproved live source')
        self.assertEqual(self.launches, [])

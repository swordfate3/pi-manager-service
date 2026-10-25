"""Real ledger/scheduler regressions; only Docker boundaries are substituted."""
import unittest

import test_runtime_updates as base


class RuntimeRegressions(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager
    pump = base.RuntimeUpdatesTest.pump

    def submit(self, mode='auto'):
        manager = self.manager(mode)
        manager.submit({'version': '1.3.0', 'idempotency_key': base.KEY})
        return manager

    def seed_validated_refresh(self, manager):
        # Recovery tests begin after synthetic helper validation, not a legacy
        # job whose version string is accidentally treated as authorization.
        job = manager._get(base.KEY)
        candidate = self.install.candidate(job)
        job['candidate'] = candidate
        # This fixture starts after the separate measured-source helper phase.
        # Bind the synthetic proof to each actual scheduler fixture identity;
        # a version label alone must never bypass production source admission.
        sources = {}
        for state in self.docker.states.values():
            identity = state['source_identity']
            key = base.digest(identity)
            sources[key] = {'identity': identity, 'evidence': {
                'ok': True, 'source_hash': key, 'profile_hash': base.digest(job['profile']),
                'node': '24.21.0', 'checks': {name: True for name in base.CHECKS}}}
        manager._update(base.KEY, status='running', stage='refreshing', candidate=candidate,
                        evidence=self.install.evidence(job), sources=sources)

    def test_new_official_target_can_be_requested_without_activating_before_approval(self):
        manager = self.manager('manual')
        job = manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.assertEqual(job['status'], 'pending')
        self.pump(2)
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_unaudited_persisted_job_cannot_be_approved_or_dispatched(self):
        manager = self.submit('manual')
        manager._update(base.KEY, version='1.4.0')
        with self.assertRaises(RuntimeError):
            manager.approve(base.KEY)
        manager._update(base.KEY, status='queued')
        self.pump(2)
        self.assertEqual(manager.get(base.KEY)['status'], 'stale')
        self.assertEqual(self.install.starts, 0)

    def test_unaudited_prepared_target_cannot_activate(self):
        manager = self.submit()
        self.pump(1)
        manager._update(base.KEY, version='1.4.0', stage='prepared')
        self.pump(2)
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertNotIn('activate', manager._get(base.KEY)['helpers'])

    def test_successful_rejection_during_inventory_prevents_install(self):
        manager = self.submit()
        original = self.install.consumers
        def consumers():
            manager.reject(base.KEY)
            return original()
        self.install.consumers = consumers
        self.pump(1)
        self.assertEqual(manager.get(base.KEY)['status'], 'rejected')
        self.assertEqual(self.install.starts, 0)

    def test_deployment_submission_blocked_by_runtime_reservation(self):
        self.submit('manual')
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': 'c' * 40})
        self.assertEqual(self.gate.store.list(), [])

    def test_deployment_validation_rechecks_runtime_admission_after_source_lookup(self):
        from test_multiservice import POLICY
        manager = self.manager('manual')
        self.gate.policy = POLICY
        self.gate.store.bootstrap(POLICY)
        def lookup(source):
            manager.submit({'version': '1.3.0', 'idempotency_key': base.KEY})
            return 'c' * 40
        self.gate.head_resolver = lookup
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': 'c' * 40})
        self.assertEqual(self.gate.store.list(), [])

    def test_stale_retry_observes_busy_to_idle_transition_without_repeating_unchanged_state(self):
        manager = self.submit()
        self.docker.states['2' * 64].update(version='1.3.0', source_identity=base.measured_source('1.3.0'))
        self.pump(6)  # Two measured sources, prepare, validate, activate, enqueue.
        child = self.gate.lifecycle._jobs()[0]
        self.gate.lifecycle._update(child['id'], status='stale', stage='execution_precondition_changed')
        self.pump(3)
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)
        self.docker.states['1' * 64].update(idle=False, busy=True)
        self.pump(2)
        self.docker.states['1' * 64].update(idle=True, busy=False)
        self.pump()
        self.assertEqual(manager.get(base.KEY)['status'], 'succeeded')

    def test_busy_rejection_does_not_starve_other_idle_target(self):
        self.submit()
        def race(cid):
            if cid == '1' * 64:
                self.docker.states[cid].update(idle=False, busy=True)
        self.docker.before_restart = race
        self.pump(12)
        self.assertEqual(self.docker.states['2' * 64]['version'], '1.3.0')
        self.assertEqual(self.docker.restarts.count('1' * 64), 1)

    def test_parent_resolution_cannot_bypass_uninspected_child(self):
        manager = self.submit()
        self.seed_validated_refresh(manager)
        self.pump(1)
        child = self.gate.lifecycle._jobs()[0]
        self.gate.lifecycle._update(child['id'], status='recovery_required', stage='control_outcome_unknown')
        manager._update(base.KEY, status='recovery_required', stage='refresh_requires_inspection')
        with self.assertRaises(RuntimeError):
            manager.resolve(base.KEY, 'inspected_no_mutation')
        self.assertTrue(manager.active())

    def test_unmanaged_consumer_arriving_after_prepare_blocks_activation(self):
        manager = self.submit()
        self.install.on_prepare = lambda: self.docker.items['2' * 64]['Config'].update(Labels={})
        self.pump()
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertNotEqual(manager.get(base.KEY)['status'], 'succeeded')

    def test_helper_identity_and_intent_committed_before_start(self):
        manager = self.submit()
        observed = []
        def before_start(job, phase):
            saved = manager._get(base.KEY)['helpers'][phase]
            self.assertEqual(saved['id'], job['helpers'][phase]['id'])
            self.assertGreater(saved['intent_at'], 0)
            observed.append(phase)
        self.install.before_start = before_start
        self.pump()
        source_phases = [phase for phase in observed if phase.startswith('source-')]
        self.assertEqual(len(source_phases), 2)  # Initial source and refreshed source.
        self.assertEqual([phase for phase in observed if not phase.startswith('source-')],
                         ['prepare', 'validate', 'activate'])

    def test_missing_dispatched_helper_is_not_recreated(self):
        manager = self.submit()
        manager._update(base.KEY, status='running', stage='preparing',
                        helpers={'prepare': {'id': 'f' * 64, 'intent_at': 1}}, install_started_at=1)
        self.pump(1)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(self.install.starts, 0)
        self.assertTrue(all(item['phase'].startswith('source-') for item in self.install.helpers.values()))
        self.assertNotIn('f' * 64, self.install.helpers)

    def test_waiting_consumer_exiting_inside_inventory_is_reconciled(self):
        manager = self.submit()
        self.docker.states['2' * 64].update(idle=False, busy=True)
        self.pump()
        original = self.docker.inspect
        def inspect(cid, timeout=None):
            if cid == '2' * 64:
                self.docker.items.pop(cid, None)
                self.docker.states.pop(cid, None)
            return original(cid, timeout)
        self.docker.inspect = inspect
        self.pump()
        self.assertEqual(manager.get(base.KEY)['status'], 'succeeded')
        self.assertIn('exited', [target['status'] for target in manager.get(base.KEY)['targets']])

    def test_trusted_consumer_startup_gap_waits_then_proceeds(self):
        manager = self.submit()
        original = self.docker.lifecycle_control
        ready = False
        def control(cid, request, timeout=None):
            if cid == '2' * 64 and not ready:
                raise RuntimeError('extension starting')
            return original(cid, request, timeout)
        self.docker.lifecycle_control = control
        self.pump(3)
        self.assertIn(manager.get(base.KEY)['status'], ('queued', 'running'))
        self.assertEqual(self.docker.installed, '1.1.0')
        ready = True
        self.pump()
        self.assertEqual(manager.get(base.KEY)['status'], 'succeeded')

    def test_persistent_idle_pre_stop_rejection_does_not_spin(self):
        manager = self.submit()
        original = self.docker.lifecycle_control
        def control(cid, request, timeout=None):
            if request['action'] == 'restart' and cid == '1' * 64:
                self.docker.restarts.append(cid)
                state = self.docker.states[cid]
                self.docker.operations[cid] = dict(operation_id=request['operation_id'], status='failed',
                    stage='checking_rejected', old_runtime_id=state['runtime_id'],
                    session_id=state['session_id'], leaf_id=state['leaf_id'])
                return {'ok': True, 'result': {'operation_id': request['operation_id'],
                                               'status': 'running', 'stage': 'checking'}}
            return original(cid, request, timeout)
        self.docker.lifecycle_control = control
        self.pump(24)
        self.assertEqual(self.docker.restarts.count('1' * 64), 1)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')

    def test_recovery_resolution_preserves_outcome_and_releases_reservation(self):
        manager = self.submit()
        manager._update(base.KEY, status='recovery_required', stage='installation_outcome_unknown')
        self.assertTrue(callable(getattr(manager, 'resolve', None)), 'host runtime resolution is missing')
        result = manager.resolve(base.KEY, 'inspected_no_mutation')
        self.assertEqual(result['status'], 'recovery_required')
        self.assertTrue(result['resolved'])
        self.assertEqual(result['resolution'], 'inspected_no_mutation')
        self.assertEqual(manager.active(), [])
        self.gate.reserve_upgrade(base.IMAGE)

    def test_parent_resolution_rejects_live_helper_and_live_supervisor(self):
        manager = self.submit()
        manager._update(base.KEY, status='recovery_required', stage='installation_outcome_unknown')
        self.assertTrue(callable(getattr(manager, 'resolve', None)))
        self.install.helpers['f' * 64] = {'State': {'Running': True}}
        with self.assertRaises(RuntimeError):
            manager.resolve(base.KEY, 'inspected_no_mutation')
        self.install.helpers.clear()
        self.docker.operations['1' * 64] = {'status': 'running'}
        with self.assertRaises(RuntimeError):
            manager.resolve(base.KEY, 'inspected_no_mutation')
        self.assertTrue(manager.active())

    def test_own_failed_child_can_be_inspected_before_parent_resolution(self):
        manager = self.submit()
        state = self.docker.states['1' * 64]
        self.install.failure = True
        self.seed_validated_refresh(manager)
        self.gate.tick()
        self.gate.worker.join(3)
        child = self.gate.lifecycle._jobs()[0]
        self.gate.lifecycle._update(child['id'], status='failed', stage='checking_rejected')
        manager._update(base.KEY, status='recovery_required', stage='refresh_requires_inspection')
        resolved = self.gate.lifecycle.resolve(child['id'], state['runtime_id'], 'inspected_no_retry')
        self.assertTrue(resolved['resolved'])
        self.assertTrue(manager.resolve(base.KEY, 'inspected_no_mutation')['resolved'])

    def test_confirmed_exited_own_child_can_be_inspected_without_inventing_live_runtime(self):
        manager = self.submit()
        self.seed_validated_refresh(manager)
        self.pump(1)
        child = self.gate.lifecycle._jobs()[0]
        self.gate.lifecycle._update(child['id'], status='recovery_required', stage='control_outcome_unknown')
        manager._update(base.KEY, status='recovery_required', stage='refresh_requires_inspection')
        self.docker.items.pop(child['container_id'])
        self.docker.states.pop(child['container_id'])
        result = self.gate.lifecycle.resolve(child['id'], child['runtime_id'], 'inspected_no_retry')
        self.assertTrue(result['resolved'])
        saved = self.gate.lifecycle._get(child['id'])
        self.assertTrue(saved['inspected_target_exited'])
        self.assertEqual(saved['status'], 'recovery_required')
        self.assertTrue(manager.resolve(base.KEY, 'inspected_no_mutation')['resolved'])


if __name__ == '__main__':
    unittest.main()

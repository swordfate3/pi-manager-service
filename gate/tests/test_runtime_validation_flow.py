"""Durable validation phases, policy fencing and explicit missing-proof refusal."""
import copy
import unittest

from gate.runtime_engine import RuntimeEngine
from gate.runtime_install import CHECKS, digest
import test_runtime_updates as base


class ValidationFlow(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager
    pump = base.RuntimeUpdatesTest.pump

    def submit(self):
        manager = self.manager()
        self.install.profile = lambda job: {'image': base.IMAGE, 'contract': 'test-only-boundary'}
        self.install.consumer_blocker = lambda item, state: None
        original = self.install.poll

        def poll(job, phase=None):
            if phase == 'prepare':
                return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                        'candidate': {'version': job['version'], 'integrity': job['release']['integrity'],
                            'tree_sha256': 'a' * 64, 'previous_target': '../old', 'previous_identity': 'b' * 64}}
            if phase == 'validate':
                return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                        'evidence': {'candidate_hash': digest(job['candidate']),
                            'release_hash': digest(job['release']), 'profile_hash': digest(job['profile']),
                            'node': '24.21.0', 'checks': {key: True for key in CHECKS}}}
            return original(job, phase)

        self.install.poll = poll
        # These are synthetic Docker observations, not compatibility proof.
        original_start = self.install.start
        self.install.start = lambda job, phase: (job['helpers'][phase]['id'] if phase == 'validate'
                                                 else original_start(job, phase))
        manager.submit({'version': '99.2.0', 'idempotency_key': base.KEY})
        return manager

    def test_prepare_validation_and_evidence_are_durable_before_activation(self):
        manager = self.submit()
        self.pump(1)
        prepared = manager._get(base.KEY)
        self.assertIn('candidate', prepared)
        self.assertEqual(self.docker.installed, '1.1.0')
        self.pump(1)
        validated = manager._get(base.KEY)
        self.assertIn('evidence', validated)
        self.assertIn('validate', validated['helpers'])
        self.assertEqual(self.docker.installed, '1.1.0')
        self.pump(1)
        self.assertEqual(self.docker.installed, '99.2.0')

    def test_missing_behavioral_validation_blocks_activation(self):
        manager = self.submit()
        original = self.install.poll
        self.install.poll = lambda job, phase: ({'state': 'failed', 'stage': 'compatibility_probe_unavailable'}
                                                if phase == 'validate' else original(job, phase))
        self.pump()
        self.assertEqual(manager.get(base.KEY)['stage'], 'compatibility_probe_unavailable')
        self.assertNotIn('activate', manager._get(base.KEY)['helpers'])
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertEqual(self.docker.restarts, [])

    def test_changed_execution_profile_blocks_reuse_of_prepared_candidate(self):
        manager = self.submit()
        self.pump(1)
        self.install.profile = lambda job: {'image': base.IMAGE, 'contract': 'changed'}
        self.pump(1)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertNotIn('activate', manager._get(base.KEY)['helpers'])
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_forged_or_incomplete_validation_is_not_persisted_as_authority(self):
        manager = self.submit()
        original = self.install.poll
        def poll(job, phase):
            result = original(job, phase)
            if phase == 'validate':
                result['evidence']['checks']['session_restore'] = False
            return result
        self.install.poll = poll
        self.pump()
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertNotIn('evidence', manager._get(base.KEY))

    def test_missing_source_evidence_blocks_before_activation(self):
        manager = self.submit()
        self.install.consumer_blocker = lambda item, state: 'source_evidence_unavailable'
        self.pump()
        self.assertEqual(manager.get(base.KEY)['stage'], 'unmanaged_or_unavailable_consumer')
        self.assertNotIn('activate', manager._get(base.KEY).get('helpers', {}))
        self.assertEqual(self.docker.restarts, [])

    def test_real_engine_does_not_grandfather_legacy_source_versions(self):
        engine = RuntimeEngine(object())
        self.assertTrue(callable(getattr(engine, 'consumer_blocker', None)))
        for state in self.docker.states.values():
            legacy = {k:v for k,v in state.items() if k != 'source_identity'}
            self.assertEqual(engine.consumer_blocker({}, legacy), 'source_evidence_unavailable')

    def test_policy_change_at_helper_create_is_fenced_before_start(self):
        manager = self.submit()
        create = self.install.create
        def changed(job, phase):
            identity = create(job, phase)
            # Simulate external durable policy replacement (normal setter refuses running jobs).
            with manager.store.lock, manager.store._write_transaction():
                import json
                policy = copy.deepcopy(manager.policy())
                policy['policy_hash'] = 'changed'
                manager.store.db.execute('UPDATE runtime_policy SET data=? WHERE id=1', (json.dumps(policy),))
            return identity
        self.install.create = changed
        self.pump(1)
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')

    def test_recovered_legacy_refresh_cannot_bypass_validation(self):
        manager = self.submit()
        manager._update(base.KEY, status='running', stage='refreshing')
        self.pump(1)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required')
        self.assertEqual(self.gate.lifecycle._jobs(), [])
        self.assertEqual(self.docker.restarts, [])

    def test_dispatched_activation_is_reconciled_before_new_source_admission(self):
        manager = self.submit()
        self.pump(2)
        manager._update(base.KEY, stage='activating', helpers={
            **manager._get(base.KEY)['helpers'], 'activate': {'id': 'c' * 64, 'intent_at': 1}})
        self.install.consumer_blocker = lambda item, state: 'source_evidence_unavailable'
        self.pump(1)
        self.assertEqual(manager.get(base.KEY)['status'], 'recovery_required',
                         'an unobserved dispatched activation cannot become a clean source refusal')

"""Confirm persisted targets by immutable ID before accepting filtered-list exit."""
import copy
import unittest

import test_runtime_source_validation as source_validation
import test_runtime_updates as base
from test_runtime_inspect_transport import inspect_response


def omit_consumer(boundary, container_id):
    consumers = boundary.consumers

    def filtered(*, timeout=3):
        return [item for item in consumers(timeout=timeout) if item.get('Id') != container_id]

    boundary.consumers = filtered


def fail_exact_inspect(docker, container_id, error):
    inspect = docker.inspect

    def unavailable(candidate, timeout=None):
        if candidate == container_id:
            raise error
        return inspect(candidate, timeout=timeout)

    docker.inspect = unavailable


def assert_malformed_inspect_requires_recovery(test, manager, container_id):
    initial = manager._get(base.KEY)
    inspect = test.docker.inspect
    for body in (b'null', b''):
        with test.subTest(body=body), inspect_response(200, body) as engine:
            def exact(candidate, timeout=None):
                if candidate == container_id:
                    return engine.inspect(candidate, timeout=timeout)
                return inspect(candidate, timeout=timeout)
            test.docker.inspect = exact
            manager._update(base.KEY, status='running', stage=initial['stage'],
                            targets=copy.deepcopy(initial['targets']))
            manager._refresh(manager._get(base.KEY))
            saved = manager._get(base.KEY)
            target = next(item for item in saved['targets'] if item['container_id'] == container_id)
            test.assertEqual((saved['status'], saved['stage']),
                             ('recovery_required', 'refresh_requires_inspection'))
            test.assertNotEqual(target['status'], 'exited')


class WaitingTargetExitConfirmationTests(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager
    pump = base.RuntimeUpdatesTest.pump

    def waiting_target(self):
        manager = self.manager()
        container_id = '2' * 64
        self.docker.states[container_id].update(idle=False, busy=True)
        manager.submit({'version': '1.3.0', 'idempotency_key': base.KEY})
        self.pump()
        target = next(item for item in manager._get(base.KEY)['targets']
                      if item['container_id'] == container_id)
        self.assertEqual(target['status'], 'waiting_for_idle')
        omit_consumer(self.install, container_id)
        return manager, container_id

    def test_filtered_running_paused_or_restarting_target_remains_pending(self):
        manager, container_id = self.waiting_target()
        for status in ('running', 'paused', 'restarting'):
            with self.subTest(status=status):
                self.docker.items[container_id]['State'].update(Status=status, Running=True)
                manager._refresh(manager._get(base.KEY))
                saved = manager._get(base.KEY)
                target = next(item for item in saved['targets']
                              if item['container_id'] == container_id)
                self.assertEqual(saved['status'], 'running')
                self.assertEqual(target['status'], 'waiting_for_idle')

    def test_filtered_target_inspect_timeout_requires_recovery(self):
        manager, container_id = self.waiting_target()
        fail_exact_inspect(self.docker, container_id, TimeoutError('inspect timed out'))
        manager._refresh(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        target = next(item for item in saved['targets'] if item['container_id'] == container_id)
        self.assertEqual((saved['status'], saved['stage']),
                         ('recovery_required', 'refresh_requires_inspection'))
        self.assertNotEqual(target['status'], 'exited')

    def test_filtered_target_inspect_error_requires_recovery(self):
        manager, container_id = self.waiting_target()
        fail_exact_inspect(self.docker, container_id, RuntimeError('inspect unavailable'))
        manager._refresh(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        target = next(item for item in saved['targets'] if item['container_id'] == container_id)
        self.assertEqual((saved['status'], saved['stage']),
                         ('recovery_required', 'refresh_requires_inspection'))
        self.assertNotEqual(target['status'], 'exited')

    def test_filtered_target_malformed_success_requires_recovery(self):
        manager, container_id = self.waiting_target()
        assert_malformed_inspect_requires_recovery(self, manager, container_id)

    def test_filtered_target_with_changed_run_identity_requires_recovery(self):
        manager, container_id = self.waiting_target()
        self.docker.items[container_id]['State'].update(Status='exited', Running=False)
        self.docker.items[container_id]['Config']['Labels']['cn.swordfate.pi.run-id'] = '9' * 32
        manager._refresh(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        target = next(item for item in saved['targets'] if item['container_id'] == container_id)
        self.assertEqual((saved['status'], saved['stage']),
                         ('recovery_required', 'refresh_requires_inspection'))
        self.assertNotEqual(target['status'], 'exited')

    def test_filtered_terminal_exit_is_confirmed(self):
        manager, container_id = self.waiting_target()
        self.docker.items[container_id]['State'].update(Status='exited', Running=False, ExitCode=0)
        manager._refresh(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        target = next(item for item in saved['targets'] if item['container_id'] == container_id)
        self.assertEqual(saved['status'], 'succeeded')
        self.assertEqual(target['status'], 'exited')


class AdoptionTargetExitConfirmationTests(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = source_validation.SourceSchedulerTests.manager
    submit = source_validation.SourceSchedulerTests.submit
    install_until = source_validation.SourceSchedulerTests.install_until
    completed_changed_source_child = source_validation.SourceSchedulerTests.completed_changed_source_child

    def omitted_succeeded_child(self):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, _ = self.completed_changed_source_child(manager, job)
        omit_consumer(self.install, child['container_id'])
        return manager, child

    def test_succeeded_child_omitted_while_running_paused_or_restarting_waits_for_adoption(self):
        manager, child = self.omitted_succeeded_child()
        container_id = child['container_id']
        for status in ('running', 'paused', 'restarting'):
            with self.subTest(status=status):
                self.docker.items[container_id]['State'].update(Status=status, Running=True)
                manager._refresh(manager._get(base.KEY))
                saved = manager._get(base.KEY)
                target = next(item for item in saved['targets']
                              if item['container_id'] == container_id)
                self.assertEqual(saved['status'], 'running')
                self.assertEqual(target['status'], 'validating_source')
                self.assertEqual(target['wait_reason'],
                                 'target_source_validation' if status == 'running' else 'consumer_not_ready')
                self.assertEqual(len(self.gate.lifecycle._jobs()), 1)

    def test_succeeded_child_ambiguous_exit_inspection_requires_recovery(self):
        manager, child = self.omitted_succeeded_child()
        fail_exact_inspect(self.docker, child['container_id'], TimeoutError('inspect timed out'))
        manager._refresh(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        target = next(item for item in saved['targets']
                      if item['container_id'] == child['container_id'])
        self.assertEqual((saved['status'], saved['stage']),
                         ('recovery_required', 'refresh_requires_inspection'))
        self.assertNotEqual(target['status'], 'exited')
        self.assertEqual(len(self.gate.lifecycle._jobs()), 1)

    def test_succeeded_child_terminal_exit_is_confirmed(self):
        manager, child = self.omitted_succeeded_child()
        container_id = child['container_id']
        self.docker.items[container_id]['State'].update(Status='exited', Running=False, ExitCode=0)
        manager._refresh(manager._get(base.KEY))
        target = next(item for item in manager._get(base.KEY)['targets']
                      if item['container_id'] == container_id)
        self.assertEqual(target['status'], 'exited')

    def test_succeeded_child_malformed_inspect_success_requires_recovery(self):
        manager, child = self.omitted_succeeded_child()
        assert_malformed_inspect_requires_recovery(self, manager, child['container_id'])

    def reconcile_omitted_adopter_helper(self, status, outcome):
        manager = self.submit()
        job = self.install_until(manager, 'refreshing')
        child, identity = self.completed_changed_source_child(manager, job)
        source_key = source_validation.digest(identity)
        phase = 'source-' + source_key
        self.install.pending_sources.add(phase)
        manager._refresh(manager._get(base.KEY))
        before = manager._get(base.KEY)
        helper = copy.deepcopy(before['helpers'][phase])
        self.assertGreater(helper['intent_at'], 0)
        self.assertEqual(self.install.source_starts.count(phase), 1)
        container_id = child['container_id']
        omit_consumer(self.install, container_id)
        self.docker.items[container_id]['State'].update(Status=status, Running=True)
        # Resume through a new scheduler instance using only persisted intent.
        restored = source_validation.RuntimeUpdates(self.gate)
        restored.runtime_engine, restored.catalog = self.install, manager.catalog
        restored._refresh(restored._get(base.KEY))
        self.assertNotIn('evidence', restored._get(base.KEY)['sources'][source_key])
        self.install.pending_sources.clear()
        poll = self.install.poll
        if outcome == 'failed':
            def failed(job, current_phase=None):
                if current_phase == phase:
                    self.install.helpers[helper['id']]['State'].update(Status='exited', Running=False)
                    return {'state': 'failed', 'stage': 'compatibility_probe_failed'}
                return poll(job, current_phase)
            self.install.poll = failed
        elif outcome == 'invalid':
            self.install.bad_source = True
        restored._refresh(restored._get(base.KEY))
        saved = restored._get(base.KEY)
        target = next(item for item in saved['targets'] if item['container_id'] == container_id)
        if outcome == 'succeeded':
            self.assertIn('evidence', saved['sources'][source_key])
            self.assertEqual(saved['sources'][source_key]['evidence'],
                             source_validation.proof(identity, saved['profile']))
            self.assertEqual(saved['status'], 'running')
            self.assertEqual(target['status'], 'validating_source')
            # Evidence alone cannot complete adoption. The next fresh inventory
            # can recover an omitted running ID through exact inspection/status;
            # paused/restarting IDs still cannot complete adoption.
            restored._refresh(restored._get(base.KEY))
            self.assertEqual(restored._get(base.KEY)['targets'][0]['status'],
                             'succeeded' if status == 'running' else 'validating_source')
            self.assertEqual(restored._get(base.KEY)['status'], 'running')
        else:
            self.assertEqual((saved['status'], saved['stage']),
                             ('recovery_required', 'refresh_requires_inspection'))
            self.assertNotIn('evidence', saved['sources'][source_key])
        self.assertEqual(saved['helpers'][phase], helper)
        self.assertFalse(self.install.helpers[helper['id']]['State']['Running'])
        self.assertEqual(self.install.source_starts.count(phase), 1)
        children = self.gate.lifecycle._jobs()
        self.assertEqual(sum(item['container_id'] == container_id for item in children), 1)
        self.assertEqual(len(children), 2 if status == 'running' and outcome == 'succeeded' else 1)
        self.assertEqual(len(self.docker.restarts), 1)

    def test_running_omitted_adopter_reconciles_completed_helper(self):
        self.reconcile_omitted_adopter_helper('running', 'succeeded')

    def test_paused_omitted_adopter_reconciles_completed_helper(self):
        self.reconcile_omitted_adopter_helper('paused', 'succeeded')

    def test_restarting_omitted_adopter_reconciles_completed_helper(self):
        self.reconcile_omitted_adopter_helper('restarting', 'succeeded')

    def test_paused_omitted_adopter_reconciles_failed_helper(self):
        self.reconcile_omitted_adopter_helper('paused', 'failed')

    def test_restarting_omitted_adopter_rejects_invalid_helper_evidence(self):
        self.reconcile_omitted_adopter_helper('restarting', 'invalid')


if __name__ == '__main__':
    unittest.main()

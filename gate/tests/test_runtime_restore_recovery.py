"""Interrupted offline restore is reconciled, never silently retried."""
import copy
import unittest
from unittest.mock import patch

import test_lifecycle as base

BODY, KEY, CID = base.BODY, base.KEY, base.CID


class RestoreRecovery(unittest.TestCase):
    def setUp(self):
        self.fixture = base.LifecycleTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.life = self.fixture.lifecycle()
        self.life.submit(BODY)
        self.life._update(KEY, status='running', stage='restore_preparing', started_at=1,
                          restore_intent_at=2, runtime_update_id='a' * 32)
        self.events = []
        self.helper = None
        original_inspect = self.fixture.engine.inspect
        self.fixture.engine.inspect = lambda key, timeout=None: (
            None if key.startswith('pi-runtime-restore-') else original_inspect(key, timeout))
        self.original_control = self.fixture.engine.lifecycle_control
        def control(cid, request, timeout=None):
            self.events.append(('control', copy.deepcopy(request)))
            if request['action'] == 'cancel_restore':
                return {'ok': True, 'result': {'cancelled': True}}
            return self.original_control(cid, request, timeout)
        self.fixture.engine.lifecycle_control = control
        def call(method, path, **kwargs):
            self.events.append((method, path))
            if method == 'DELETE' and path == '/containers/' + 'f' * 64 + '?force=1&v=1':
                self.helper = None
                return None
            raise AssertionError('unexpected Docker mutation')
        self.fixture.engine.call = call

    def inspect(self, job, phase):
        self.assertEqual(job['id'], KEY)
        self.assertEqual(phase, 'validate')
        self.events.append(('inspect_helper', phase))
        return self.helper

    def reconcile(self):
        with patch('gate.runtime_restore.RestoreEngine.inspect', side_effect=self.inspect):
            self.life.recover()
            self.assertEqual(self.events, [], 'startup must never perform Docker I/O')
            self.fixture.finish()

    def test_crash_after_freeze_cancels_exact_capture_without_restarting(self):
        self.reconcile()
        saved = self.life._get(KEY)
        self.assertEqual(saved['stage'], 'restore_pre_stop_failed')
        self.assertEqual(saved['status'], 'stale')
        self.assertTrue(saved['restore_reconciled'])
        actions = [row[1]['action'] for row in self.events if row[0] == 'control']
        self.assertEqual(actions, ['status', 'cancel_restore'])
        self.assertFalse(any(row[0] == 'DELETE' for row in self.events))

    def test_crash_windows_cleanup_recorded_or_deterministically_named_helper_only(self):
        for state in ('created', 'running', 'exited'):
            with self.subTest(state=state):
                self.events.clear()
                self.helper = {'Id': 'f' * 64, 'State': {'Status': state}}
                plan = {'id': KEY, 'frozen': {'synthetic': True}, 'helpers': {}}
                if state != 'created':
                    plan['helpers']['validate'] = {'id': 'f' * 64, 'intent_at': 3}
                self.life._update(KEY, status='running', stage='restore_validating', restore_helper=plan)
                self.reconcile()
                self.assertEqual(self.life._get(KEY)['stage'], 'restore_pre_stop_failed')
                self.assertEqual([row for row in self.events if row[0] == 'DELETE'],
                                 [('DELETE', '/containers/' + 'f' * 64 + '?force=1&v=1')])
                self.assertFalse(any(row[0] == 'control' and row[1]['action'] in ('restart', 'prepare_restore')
                                     for row in self.events))

    def test_cancel_or_helper_identity_uncertainty_keeps_recovery_required(self):
        def reject(*args, **kwargs):
            raise RuntimeError('unknown helper identity')
        self.life._update(KEY, restore_helper={'id': KEY, 'helpers': {}})
        with patch('gate.runtime_restore.RestoreEngine.inspect', side_effect=reject):
            self.life.recover()
            self.fixture.finish()
        self.assertEqual(self.life._get(KEY)['status'], 'recovery_required')
        self.assertEqual(self.life._get(KEY)['stage'], 'restore_recovery_unknown')
        self.assertFalse(any(row[0] == 'DELETE' for row in self.events))

    def test_without_saved_plan_unexpected_helper_is_not_deleted_or_adopted(self):
        original = self.fixture.engine.inspect
        def inspect(key, timeout=None):
            if key.startswith('pi-runtime-restore-'):
                return {'Id': 'f' * 64}
            return original(key, timeout)
        self.fixture.engine.inspect = inspect
        self.reconcile()
        self.assertEqual(self.life._get(KEY)['status'], 'recovery_required')
        self.assertFalse(any(row[0] == 'DELETE' for row in self.events))

    def test_uncertain_cancellation_never_deletes_a_helper(self):
        for reply in (None, {'ok': True, 'result': {'cancelled': False}}):
            with self.subTest(reply=reply):
                self.events.clear()
                self.life._update(KEY, status='running', stage='restore_recovery_pending')
                def control(cid, request, timeout=None):
                    if request['action'] == 'cancel_restore':
                        if reply is None:
                            raise TimeoutError('lost cancellation reply')
                        return reply
                    return self.original_control(cid, request, timeout)
                self.fixture.engine.lifecycle_control = control
                self.reconcile()
                self.assertEqual(self.life._get(KEY)['stage'], 'restore_recovery_unknown')
                self.assertFalse(any(row[0] == 'DELETE' for row in self.events))


if __name__ == '__main__':
    unittest.main()

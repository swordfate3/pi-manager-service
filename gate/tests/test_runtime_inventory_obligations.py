"""R1: real discovery/orchestration with an inert Docker listing boundary."""
import json
import unittest
from urllib.parse import parse_qs, urlsplit

from gate.runtime_engine import RuntimeEngine
from gate.runtime_updates import RuntimeUpdates
import test_runtime_updates as base


class InventoryObligations(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager
    pump = base.RuntimeUpdatesTest.pump

    def discovery(self):
        self.omitted = set()
        for item in self.docker.items.values():
            item['State'].update(Status='running', Paused=False, Restarting=False)

        def listing(method, path, **kwargs):
            self.assertEqual(method, 'GET')
            self.assertEqual(urlsplit(path).path, '/containers/json')
            query = parse_qs(urlsplit(path).query)
            filters = json.loads(query.get('filters', ['{}'])[0])
            statuses = filters.get('status', [])
            return [{'Id': cid} for cid, item in self.docker.items.items()
                    if cid not in self.omitted
                    and (not statuses or item['State']['Status'] in statuses)
                    and (query.get('all') == ['1'] or item['State']['Status'] == 'running')]

        self.docker.call = listing
        self.install.consumers = RuntimeEngine(self.docker).consumers
        control = self.docker.lifecycle_control

        def unavailable_when_paused(cid, request, timeout=None):
            if self.docker.items[cid]['State']['Status'] in ('paused', 'restarting'):
                raise TimeoutError('fixture cannot execute in a paused/restarting consumer')
            return control(cid, request, timeout=timeout)

        self.docker.lifecycle_control = unavailable_when_paused

    def test_managed_paused_consumer_blocks_readiness_and_activation(self):
        manager = self.manager()
        self.discovery()
        self.docker.items['2' * 64]['State'].update(Status='paused', Paused=True)
        self.assertEqual(manager.readiness()['status'], 'blocked')
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.pump()
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertNotEqual(manager.get(base.KEY)['status'], 'succeeded')

    def test_unmanaged_paused_consumer_cannot_disappear_from_admission(self):
        manager = self.manager()
        self.discovery()
        item = self.docker.items['2' * 64]
        item['State'].update(Status='paused', Paused=True)
        item['Config']['Labels'] = {}
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.pump()
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertEqual(self.docker.restarts, [])

    def test_restarting_nonrunning_consumer_is_not_a_terminal_exit(self):
        manager = self.manager()
        self.discovery()
        self.docker.items['2' * 64]['State'].update(Status='restarting', Running=False, Restarting=True)
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.pump()
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertNotEqual(manager.get(base.KEY)['status'], 'succeeded')

    def test_omission_after_preparation_cannot_erase_a_required_consumer(self):
        manager = self.manager()
        self.discovery()
        def disappear():
            self.omitted.add('2' * 64)
            self.docker.items['2' * 64]['State'].update(Status='paused', Paused=True)
        self.install.on_prepare = disappear
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        self.pump()
        self.assertEqual(self.docker.installed, '1.1.0')
        self.assertNotEqual(manager.get(base.KEY)['status'], 'succeeded')

    def first_refresh_omission(self, status, unavailable=False):
        manager = self.manager()
        self.discovery()
        def after_activation(job, phase):
            if phase == 'activate':
                self.omitted.add('2' * 64)
                self.docker.items['2' * 64]['State'].update(
                    Status=status, Running=status not in ('exited', 'dead'))
                if unavailable:
                    inspect = self.docker.inspect
                    def inspect_exact(cid, timeout=None):
                        if cid == '2' * 64:
                            raise TimeoutError('exact inspection unavailable')
                        return inspect(cid, timeout=timeout)
                    self.docker.inspect = inspect_exact
        self.install.before_start = after_activation
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        for _ in range(20):
            if manager._get(base.KEY)['stage'] == 'refreshing':
                break
            manager._install(manager._get(base.KEY))
        self.assertEqual(manager._get(base.KEY)['stage'], 'refreshing')
        # New scheduler instance must recover obligations from the ledger, not memory.
        restored = RuntimeUpdates(self.gate)
        restored.runtime_engine, restored.catalog = self.install, manager.catalog
        self.gate.runtime_updates = restored
        self.pump()
        return restored._get(base.KEY)

    def test_omission_before_first_refresh_survives_scheduler_restart(self):
        saved = self.first_refresh_omission('paused')
        self.assertNotEqual(saved['status'], 'succeeded')
        self.assertEqual(self.docker.states['2' * 64]['version'], '1.1.0')

    def test_unavailable_inspection_before_first_target_never_means_exit(self):
        saved = self.first_refresh_omission('running', unavailable=True)
        self.assertEqual(saved['status'], 'recovery_required')

    def test_confirmed_exit_before_first_refresh_remains_an_explicit_obligation(self):
        saved = self.first_refresh_omission('exited')
        self.assertEqual(saved['status'], 'succeeded')
        target = next((t for t in saved['targets'] if t['container_id'] == '2' * 64), None)
        self.assertIsNotNone(target, 'an early required identity was silently forgotten')
        self.assertEqual(target['status'], 'exited')

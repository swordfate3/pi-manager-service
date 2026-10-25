"""Dynamic release admission and read-only readiness, not fake activation evidence."""
import copy
import json
import threading
import unittest
from unittest.mock import patch

from gate.runtime_catalog import RuntimeCatalog, RegistryUnavailable
from test_runtime_catalog import release
import test_runtime_updates as base
KEY = base.KEY


class DynamicVersionTest(unittest.TestCase):
    setUp = base.RuntimeUpdatesTest.setUp
    manager = base.RuntimeUpdatesTest.manager

    def observe_follower_join(self, manager, thread_name='runtime-submit-follower'):
        attempted = threading.Event()
        joined = threading.Event()
        original = manager._join_submit_flight

        def observed(key, version):
            if threading.current_thread().name == thread_name:
                attempted.set()
            result = original(key, version)
            if threading.current_thread().name == thread_name:
                joined.set()
            return result

        manager._join_submit_flight = observed
        return attempted, joined

    def source(self, manager):
        calls = []
        def fetch(url):
            calls.append(url)
            return release(url.rsplit('/', 1)[-1])
        manager.catalog = RuntimeCatalog(fetch=fetch)
        return calls

    def test_new_official_version_can_be_requested_and_pins_artifact_before_approval(self):
        manager = self.manager('manual')
        self.source(manager)
        result = manager.submit({'version': '1.4.0', 'idempotency_key': KEY})
        self.assertEqual(result['status'], 'pending')
        saved = manager._get(KEY)
        self.assertEqual(saved['release']['version'], '1.4.0')
        self.assertEqual(saved['release']['integrity'], release()['dist']['integrity'])
        self.assertEqual(self.install.starts, 0)
        self.assertNotIn('tarball', json.dumps(result), 'internal source pin is not a browser execution field')

    def test_repeated_request_returns_original_job_without_network_resolution(self):
        manager = self.manager('manual')
        calls = self.source(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        first = manager.submit(payload)
        manager.catalog.fetch = lambda _: (_ for _ in ()).throw(RegistryUnavailable())
        self.assertEqual(manager.submit(payload), first)
        self.assertEqual(len(calls), 1)

    def test_concurrent_same_key_resolution_is_single_flight_without_store_starvation(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        duplicate_fetch = threading.Event()
        calls = []
        calls_lock = threading.Lock()

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            with calls_lock:
                calls.append(version)
                if len(calls) > 1:
                    duplicate_fetch.set()
            entered.set()
            if not allow_resolution.wait(2):
                raise AssertionError('test did not release registry resolution')
            return release(version)

        manager.catalog.fetch = fetch
        _, follower_joined = self.observe_follower_join(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        results, errors = [], []

        def submit():
            try:
                results.append(manager.submit(payload))
            except Exception as error:  # Captured for assertions in the test thread.
                errors.append(error)

        leader = threading.Thread(target=submit, name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        follower = threading.Thread(target=submit, name='runtime-submit-follower')
        follower.start()
        self.assertTrue(follower_joined.wait(1), 'follower never joined the in-flight request')

        observed = threading.Event()
        observer_result = []

        def observe_store():
            observer_result.append((manager.jobs(), manager.policy()))
            observed.set()

        observer = threading.Thread(target=observe_store, name='runtime-store-observer')
        observer.start()
        self.assertTrue(observed.wait(1), 'registry wait must not hold the global store lock')
        self.assertFalse(duplicate_fetch.is_set(), 'follower resolved instead of waiting for the leader')
        allow_resolution.set()
        for thread in (leader, follower, observer):
            thread.join(2)
            self.assertFalse(thread.is_alive(), 'concurrency test thread did not finish boundedly')

        self.assertEqual(errors, [])
        self.assertEqual(calls, ['1.4.0'])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(manager.jobs()), 1)
        self.assertEqual(observer_result[0][0], [])
        saved = manager._get(KEY)['release']
        self.assertEqual(set(saved), {'version', 'integrity', 'tarball', 'node'})
        self.assertEqual(saved['version'], '1.4.0')

    def test_follower_cannot_miss_flight_after_initial_lookup_and_resolve_again(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        follower_at_join = threading.Event()
        allow_follower_join = threading.Event()
        leader_done = threading.Event()
        calls = []

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            calls.append(version)
            if len(calls) == 1:
                entered.set()
                if not allow_resolution.wait(2):
                    raise AssertionError('test did not release leader resolution')
            return release(version)

        manager.catalog.fetch = fetch
        original_join = manager._join_submit_flight

        def paused_join(key, version):
            if threading.current_thread().name == 'runtime-submit-follower':
                follower_at_join.set()
                if not allow_follower_join.wait(2):
                    raise AssertionError('test did not release follower join')
            return original_join(key, version)

        manager._join_submit_flight = paused_join
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        results, errors = [], []

        def submit(done=None):
            try:
                results.append(manager.submit(payload))
            except Exception as error:  # Captured for assertions in the test thread.
                errors.append(error)
            finally:
                if done is not None:
                    done.set()

        leader = threading.Thread(target=submit, args=(leader_done,), name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        follower = threading.Thread(target=submit, name='runtime-submit-follower')
        follower.start()
        self.assertTrue(follower_at_join.wait(1), 'follower never reached the join boundary')
        allow_resolution.set()
        leader_done.wait(0.25)  # Old code can finish and remove the flight in this explicit gap.
        allow_follower_join.set()
        for thread in (leader, follower):
            thread.join(2)
            self.assertFalse(thread.is_alive(), 'lookup/join race thread did not finish boundedly')

        self.assertEqual(errors, [])
        self.assertEqual(calls, ['1.4.0'])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], results[1])

    def test_inflight_limit_rejects_new_key_but_preserves_same_key_join(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        calls = []

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            calls.append(version)
            entered.set()
            if not allow_resolution.wait(2):
                raise AssertionError('test did not release bounded in-flight resolution')
            return release(version)

        manager.catalog.fetch = fetch
        _, follower_joined = self.observe_follower_join(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        results, errors = [], []

        def submit():
            try:
                results.append(manager.submit(payload))
            except Exception as error:  # Captured for assertions in the test thread.
                errors.append(error)

        with patch('gate.runtime_updates.MAX_SUBMIT_FLIGHTS', 1, create=True):
            leader = threading.Thread(target=submit, name='runtime-submit-leader')
            leader.start()
            self.assertTrue(entered.wait(1), 'leader never occupied the in-flight slot')
            follower = threading.Thread(target=submit, name='runtime-submit-follower')
            follower.start()
            self.assertTrue(follower_joined.wait(1), 'same-key follower was not admitted at capacity')
            with self.assertRaisesRegex(RuntimeError, 'too many runtime submissions'):
                manager.submit({'version': '1.5.0', 'idempotency_key': 'a' * 32})
            self.assertEqual(calls, ['1.4.0'])
            allow_resolution.set()
            for thread in (leader, follower):
                thread.join(2)
                self.assertFalse(thread.is_alive(), 'capacity test thread did not finish boundedly')

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], results[1])

    def test_follower_timeout_is_ambiguous_503_while_leader_can_still_persist(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        calls = []

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            calls.append(version)
            entered.set()
            if not allow_resolution.wait(2):
                raise AssertionError('test did not release timeout leader')
            return release(version)

        manager.catalog.fetch = fetch
        _, follower_joined = self.observe_follower_join(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        leader_results, leader_errors, follower_errors = [], [], []

        def lead():
            try:
                leader_results.append(manager.submit(payload))
            except Exception as error:  # Captured for assertions in the test thread.
                leader_errors.append(error)

        def follow():
            try:
                manager.submit(payload)
            except Exception as error:  # Captured for assertions in the test thread.
                follower_errors.append(error)

        leader = threading.Thread(target=lead, name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        with patch('gate.runtime_updates.SUBMIT_SINGLE_FLIGHT_WAIT', 0.05):
            follower = threading.Thread(target=follow, name='runtime-submit-follower')
            follower.start()
            self.assertTrue(follower_joined.wait(1), 'timeout follower never joined the in-flight request')
            follower.join(1)
        self.assertFalse(follower.is_alive(), 'timeout follower did not finish boundedly')
        self.assertEqual(len(follower_errors), 1)
        self.assertIs(type(follower_errors[0]), RegistryUnavailable,
                      'ambiguous overlap must use the existing HTTP 503 exception path')
        self.assertEqual(calls, ['1.4.0'])
        self.assertEqual(manager.jobs(), [])

        allow_resolution.set()
        leader.join(2)
        self.assertFalse(leader.is_alive(), 'leader did not finish after follower timeout')
        self.assertEqual(leader_errors, [])
        self.assertEqual(len(leader_results), 1)
        self.assertEqual(manager.get(KEY)['version'], '1.4.0')

    def test_policy_change_after_resolution_preserves_leader_conflict_and_cleans_flight(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        calls = []
        calls_lock = threading.Lock()

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            with calls_lock:
                calls.append(version)
                first = len(calls) == 1
            if first:
                entered.set()
                if not allow_resolution.wait(2):
                    raise AssertionError('test did not release policy-change resolution')
            return release(version)

        manager.catalog.fetch = fetch
        _, follower_joined = self.observe_follower_join(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        leader_errors, follower_errors = [], []

        def lead():
            try:
                manager.submit(payload)
            except Exception as error:  # Captured for assertions in the test thread.
                leader_errors.append(error)

        def follow():
            try:
                manager.submit(payload)
            except Exception as error:  # Captured for assertions in the test thread.
                follower_errors.append(error)

        leader = threading.Thread(target=lead, name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        follower = threading.Thread(target=follow, name='runtime-submit-follower')
        follower.start()
        self.assertTrue(follower_joined.wait(1), 'follower never joined before the policy change')

        manager.set_policy({'mode': 'auto', 'images': [base.IMAGE]})
        allow_resolution.set()
        for thread in (leader, follower):
            thread.join(2)
            self.assertFalse(thread.is_alive(), 'policy-change thread did not finish boundedly')

        self.assertEqual(len(leader_errors), 1)
        self.assertIs(type(leader_errors[0]), RuntimeError)
        self.assertNotIsInstance(leader_errors[0], RegistryUnavailable)
        self.assertEqual(str(leader_errors[0]), 'runtime policy changed during resolution')
        self.assertEqual(len(follower_errors), 1)
        self.assertIs(type(follower_errors[0]), RegistryUnavailable)
        self.assertEqual(manager.jobs(), [])
        self.assertEqual(manager._submit_flights, {})

        retry = manager.submit(payload)
        self.assertEqual(retry['status'], 'queued')
        self.assertEqual(calls, ['1.4.0', '1.4.0'])

    def test_concurrent_different_version_for_same_key_rejects_without_resolving(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_resolution = threading.Event()
        calls = []

        def fetch(url):
            version = url.rsplit('/', 1)[-1]
            calls.append(version)
            if version == '1.4.0':
                entered.set()
                if not allow_resolution.wait(2):
                    raise AssertionError('test did not release registry resolution')
            return release(version)

        manager.catalog.fetch = fetch
        follower_attempted, _ = self.observe_follower_join(manager)
        leader_errors = []

        def lead():
            try:
                manager.submit({'version': '1.4.0', 'idempotency_key': KEY})
            except Exception as error:  # Captured for assertions in the test thread.
                leader_errors.append(error)

        leader = threading.Thread(target=lead, name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        follower_results, follower_errors = [], []

        def conflict():
            try:
                follower_results.append(
                    manager.submit({'version': '1.5.0', 'idempotency_key': KEY}))
            except Exception as error:  # Captured for assertions in the test thread.
                follower_errors.append(error)

        follower = threading.Thread(target=conflict, name='runtime-submit-follower')
        follower.start()
        self.assertTrue(follower_attempted.wait(1), 'conflicting follower never reached the in-flight request')
        try:
            follower.join(1)
            self.assertFalse(follower.is_alive(), 'conflicting follower did not reject boundedly')
            self.assertEqual(follower_results, [])
            self.assertEqual(len(follower_errors), 1)
            with self.assertRaisesRegex(RuntimeError, 'idempotency conflict'):
                raise follower_errors[0]
        finally:
            allow_resolution.set()
            leader.join(2)
        self.assertFalse(follower.is_alive(), 'conflicting follower did not finish boundedly')
        self.assertFalse(leader.is_alive(), 'leader did not finish boundedly')
        self.assertEqual(leader_errors, [])
        self.assertEqual(calls, ['1.4.0'])
        self.assertEqual(manager.get(KEY)['version'], '1.4.0')

    def test_concurrent_resolution_failure_is_shared_and_later_retry_can_resolve(self):
        manager = self.manager('manual')
        entered = threading.Event()
        allow_failure = threading.Event()
        duplicate_fetch = threading.Event()
        calls = []
        calls_lock = threading.Lock()

        def fail(url):
            version = url.rsplit('/', 1)[-1]
            with calls_lock:
                calls.append(version)
                if len(calls) > 1:
                    duplicate_fetch.set()
            entered.set()
            if not allow_failure.wait(2):
                raise AssertionError('test did not release registry failure')
            raise RuntimeError('secret upstream failure detail')

        manager.catalog.fetch = fail
        _, follower_joined = self.observe_follower_join(manager)
        payload = {'version': '1.4.0', 'idempotency_key': KEY}
        failures = []

        def submit():
            try:
                manager.submit(payload)
            except Exception as error:  # Captured for assertions in the test thread.
                failures.append((type(error), str(error)))

        leader = threading.Thread(target=submit, name='runtime-submit-leader')
        leader.start()
        self.assertTrue(entered.wait(1), 'leader never reached registry resolution')
        follower = threading.Thread(target=submit, name='runtime-submit-follower')
        follower.start()
        self.assertTrue(follower_joined.wait(1), 'follower never joined the failing in-flight request')
        self.assertFalse(duplicate_fetch.is_set(), 'follower fetched instead of sharing the leader failure')
        allow_failure.set()
        for thread in (leader, follower):
            thread.join(2)
            self.assertFalse(thread.is_alive(), 'failure-sharing thread did not finish boundedly')

        self.assertEqual(calls, ['1.4.0'])
        self.assertEqual(failures, [(RegistryUnavailable, str(RegistryUnavailable()))] * 2)
        self.assertNotIn('secret upstream failure detail', repr(failures))
        self.assertEqual(manager.jobs(), [])

        manager.catalog.fetch = lambda url: calls.append(url.rsplit('/', 1)[-1]) or release(url.rsplit('/', 1)[-1])
        result = manager.submit(payload)
        self.assertEqual(result['version'], '1.4.0')
        self.assertEqual(calls, ['1.4.0', '1.4.0'])

    def test_persisted_release_tampering_invalidates_manual_approval(self):
        manager = self.manager('manual')
        self.source(manager)
        manager.submit({'version': '1.4.0', 'idempotency_key': KEY})
        changed = copy.deepcopy(manager._get(KEY)['release'])
        changed['integrity'] = release()['dist']['integrity'].replace('eH', 'aH')
        manager._update(KEY, release=changed)
        with self.assertRaises(RuntimeError):
            manager.approve(KEY)
        self.assertEqual(self.install.starts, 0)

    def test_unavailable_registry_creates_no_update_job(self):
        manager = self.manager('manual')
        self.source(manager)
        manager.catalog.fetch = lambda _: (_ for _ in ()).throw(RegistryUnavailable())
        with self.assertRaises(RegistryUnavailable):
            manager.submit({'version': '1.4.0', 'idempotency_key': KEY})
        self.assertEqual(manager.jobs(), [])

    def test_readiness_projects_legacy_blockers_without_container_or_path_disclosure(self):
        manager = self.manager()
        ready = manager.readiness()
        self.assertEqual(ready['status'], 'ready')
        self.assertEqual(len(ready['consumers']), 2)
        self.assertEqual(ready['consumers'][0]['version'], '1.1.0')
        self.docker.items['2' * 64]['Config']['Labels'] = {}
        blocked = manager.readiness()
        self.assertEqual(blocked['status'], 'blocked')
        self.assertTrue(any(not row['ready'] for row in blocked['consumers']))
        for private in ('2' * 64, '/var/lib/docker', 'Mounts', 'Config'):
            self.assertNotIn(private, json.dumps(blocked))

    def test_readiness_has_one_inventory_budget_not_a_fresh_timeout_per_consumer(self):
        manager = self.manager()
        elapsed = [0.0]
        requests = []
        original = self.docker.inspect

        def inspect(cid, timeout=None):
            requests.append(timeout)
            elapsed[0] += 2.1
            return original(cid, timeout)

        self.docker.inspect = inspect
        with patch('gate.runtime_updates.time.monotonic', side_effect=lambda: elapsed[0]):
            result = manager.readiness()
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['consumers'], [])
        self.assertEqual(len(requests), 2, 'budget exhaustion must stop further Docker inspection')
        self.assertLessEqual(requests[1], 1.9)


if __name__ == '__main__':
    unittest.main()

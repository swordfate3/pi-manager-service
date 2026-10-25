"""Real inventory/scheduler with faults only at external Docker boundaries."""
import copy
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest

from gate.engine import DockerError, DockerTimeout
from gate.runtime_catalog import RuntimeCatalog
from gate.runtime_engine import RuntimeEngine
from gate.service import Gate
from test_runtime_catalog import release
from test_runtime_source_validation import proof
import test_runtime_updates as base


CID = '1' * 64


class InventoryDocker(base.DockerBoundary):
    def __init__(self):
        super().__init__()
        self.items.pop('2' * 64)
        self.states.pop('2' * 64)
        self.events = []
        self.list_outcomes = []
        self.inspect_outcomes = []
        self.resolve_error = self.status_error = None
        self.confirm_outcomes = []

    @staticmethod
    def outcome(queue, normal):
        value = queue.pop(0) if queue else normal()
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def call(self, method, path, value=None, **kwargs):
        if method != 'GET' or not path.startswith('/containers/json?all=1&filters='):
            raise AssertionError('unexpected inventory transport operation')
        self.events.append(('list', method, path, kwargs.get('timeout')))
        return self.outcome(self.list_outcomes, lambda: [{'Id': CID}])

    def inspect(self, cid, timeout=None):
        self.events.append(('inspect', cid, timeout))
        return self.outcome(self.inspect_outcomes, lambda: self.items.get(cid))

    def list_lifecycle(self, run, timeout=None):
        self.events.append(('resolve', run, timeout))
        if self.resolve_error is not None:
            self.inspect_outcomes = list(self.confirm_outcomes)
            raise self.resolve_error
        return super().list_lifecycle(run, timeout=timeout)

    def lifecycle_control(self, cid, request, timeout=None):
        self.events.append(('control', cid, request['action'], timeout))
        if self.status_error is not None:
            self.inspect_outcomes = list(self.confirm_outcomes)
            raise self.status_error
        return super().lifecycle_control(cid, request, timeout=timeout)


class InventoryRuntime(base.InstallBoundary):
    def __init__(self, docker):
        super().__init__(docker)
        self.helper_events = []

    def consumers(self, *, timeout=3):
        return RuntimeEngine(self.docker).consumers(timeout=timeout)

    def create(self, job, phase):
        self.helper_events.append(('create', phase))
        return super().create(job, phase)

    def start(self, job, phase):
        self.helper_events.append(('start', phase))
        return super().start(job, phase)

    def poll(self, job, phase):
        self.helper_events.append(('poll', phase))
        return super().poll(job, phase)


class InventoryRetryTests(unittest.TestCase):
    def case(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        gate = Gate(Path(temporary.name))
        self.addCleanup(gate.close)
        docker = InventoryDocker()
        runtime = InventoryRuntime(docker)
        gate.lifecycle.engine = docker
        manager = gate.runtime_updates
        manager.runtime_engine = runtime
        manager.catalog = RuntimeCatalog(fetch=lambda url: release(url.rsplit('/', 1)[-1]))
        manager.set_policy({'mode': 'auto', 'images': [base.IMAGE]})
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        return SimpleNamespace(gate=gate, docker=docker, runtime=runtime, manager=manager,
                               job=manager._get(base.KEY))

    @staticmethod
    def faults(case, boundary):
        return case.docker.list_outcomes if boundary == 'list' else case.docker.inspect_outcomes

    def assert_same_reads(self, events, boundary, count):
        self.assertEqual(len(events), count)
        self.assertTrue(all(event[0] == boundary for event in events))
        self.assertTrue(all(event == events[0] for event in events))
        self.assertEqual(events[0][-1], 3)
        if boundary == 'inspect':
            self.assertEqual(events[0][1], CID)
        else:
            self.assertEqual(events[0][1], 'GET')

    def test_timeout_then_valid_inventory_retries_only_same_read(self):
        for boundary in ('list', 'inspect'):
            for failures in (1, 3):
                with self.subTest(boundary=boundary, failures=failures):
                    case = self.case()
                    self.faults(case, boundary).extend(DockerTimeout('read timeout') for _ in range(failures))
                    try:
                        inventory = case.manager._inventory(case.job)
                    except DockerTimeout:
                        self.fail('pure inventory GET did not retry typed timeout')
                    self.assertEqual(len(inventory), 1)
                    self.assertEqual(inventory[0][0]['Id'], CID)
                    self.assertEqual(inventory[0][1]['version'], '1.1.0')
                    offset = 0 if boundary == 'list' else 1
                    self.assert_same_reads(case.docker.events[offset:offset + failures + 1], boundary, failures + 1)
                    self.assertEqual(case.manager._get(base.KEY), case.job)
                    self.assertEqual(case.runtime.helper_events, [])

    def test_four_total_attempts_exhaust_without_persisting_inventory(self):
        for boundary in ('list', 'inspect'):
            with self.subTest(boundary=boundary):
                case = self.case()
                errors = [DockerTimeout('read timeout') for _ in range(5)]
                self.faults(case, boundary).extend(errors)
                with self.assertRaises(DockerTimeout) as caught:
                    case.manager._inventory(case.job)
                self.assertIs(caught.exception, errors[3])
                self.assertEqual(self.faults(case, boundary), errors[4:])
                self.assert_same_reads([e for e in case.docker.events if e[0] == boundary], boundary, 4)
                self.assertEqual(case.manager._get(base.KEY), case.job)

    def test_http_and_untyped_errors_are_never_retried(self):
        for boundary in ('list', 'inspect'):
            for error in (DockerError('Docker operation failed (HTTP 404)'),
                          DockerError('Docker operation failed (HTTP 500)'),
                          DockerError('Docker operation timed out'), ValueError('malformed response'),
                          OSError('connection unavailable')):
                with self.subTest(boundary=boundary, error=repr(error)):
                    case = self.case()
                    sentinel = DockerTimeout('must remain unused')
                    self.faults(case, boundary).extend([error, sentinel])
                    with self.assertRaises(type(error)) as caught:
                        case.manager._inventory(case.job)
                    self.assertIs(caught.exception, error)
                    self.assertEqual(self.faults(case, boundary), [sentinel])
                    self.assert_same_reads([e for e in case.docker.events if e[0] == boundary], boundary, 1)

    def test_confirmed_missing_or_exited_consumer_is_not_retried(self):
        for result in (None, {'Id': CID, 'State': {'Running': False, 'Status': 'exited'}}):
            with self.subTest(result=result):
                case = self.case()
                case.docker.inspect_outcomes.extend([result, DockerTimeout('must remain unused')])
                self.assertEqual(case.manager._inventory(case.job), [])
                self.assert_same_reads([e for e in case.docker.events if e[0] == 'inspect'], 'inspect', 1)
                self.assertEqual(len(case.docker.inspect_outcomes), 1)

    def test_malformed_inventory_results_are_not_retried(self):
        for boundary in ('list', 'inspect'):
            with self.subTest(boundary=boundary):
                case = self.case()
                self.faults(case, boundary).extend([{}, DockerTimeout('must remain unused')])
                with self.assertRaises((RuntimeError, ValueError)):
                    case.manager._inventory(case.job)
                self.assert_same_reads([e for e in case.docker.events if e[0] == boundary], boundary, 1)
                self.assertEqual(len(self.faults(case, boundary)), 1)

    def test_identity_and_image_profile_failure_do_not_repeat_resolution(self):
        for field in ('identity', 'profile'):
            with self.subTest(field=field):
                case = self.case()
                if field == 'identity':
                    case.docker.items[CID]['Config']['User'] = '0:0'
                else:
                    case.docker.items[CID]['Image'] = 'sha256:' + 'a' * 64
                with self.assertRaises(RuntimeError):
                    case.manager._inventory(case.job)
                self.assertEqual([e[0] for e in case.docker.events],
                                 ['list', 'inspect', 'resolve', 'inspect', 'inspect'])

    def test_confirmatory_inspects_retry_without_repeating_resolve_or_status(self):
        for boundary in ('resolve', 'status'):
            with self.subTest(boundary=boundary):
                case = self.case()
                setattr(case.docker, boundary + '_error', DockerTimeout('not retryable operation'))
                case.docker.confirm_outcomes = [DockerTimeout('confirmatory GET timeout'), None]
                try:
                    inventory = case.manager._inventory(case.job)
                except DockerTimeout:
                    self.fail('confirmatory inventory inspect did not retry')
                self.assertEqual(inventory, [])
                self.assert_same_reads(case.docker.events[-2:], 'inspect', 2)
                self.assertEqual(len([e for e in case.docker.events if e[0] == 'resolve']), 1)
                controls = [e for e in case.docker.events if e[0] == 'control']
                self.assertEqual(len(controls), 1 if boundary == 'status' else 0)

    def test_confirmatory_inspect_exhaustion_remains_conservative(self):
        for boundary in ('resolve', 'status'):
            with self.subTest(boundary=boundary):
                case = self.case()
                setattr(case.docker, boundary + '_error', RuntimeError('original observation failed'))
                case.docker.confirm_outcomes = [DockerTimeout('confirm timeout') for _ in range(5)]
                with self.assertRaises(DockerTimeout):
                    case.manager._inventory(case.job)
                self.assert_same_reads(case.docker.events[-4:], 'inspect', 4)
                self.assertEqual(len(case.docker.inspect_outcomes), 1)

    def test_existing_prepare_intent_is_not_replayed_when_inventory_retries(self):
        for boundary in ('list', 'inspect'):
            for exhausted in (False, True):
                with self.subTest(boundary=boundary, exhausted=exhausted):
                    case = self.case()
                    cid = case.runtime.create(case.job, 'prepare')
                    helper = {'id': cid, 'intent_at': int(time.time() * 1000)}
                    identity = base.measured_source()
                    sources = {base.digest(identity): {'identity': identity,
                               'evidence': proof(identity, case.job['profile'])}}
                    job = case.manager._update(base.KEY, status='running', stage='preparing',
                                               helpers={'prepare': helper}, sources=sources)
                    case.runtime.start(job, 'prepare')
                    self.faults(case, boundary).extend(DockerTimeout('read timeout')
                                                       for _ in range(5 if exhausted else 1))
                    case.manager._install(job)
                    saved = case.manager._get(base.KEY)
                    self.assertEqual((saved['status'], saved['stage']),
                                     ('recovery_required', 'installation_outcome_unknown') if exhausted else
                                     ('running', 'prepared'))
                    self.assertEqual(saved['helpers'], {'prepare': helper})
                    self.assertEqual(saved['sources'], sources)
                    self.assertEqual(case.runtime.starts, 1)
                    self.assertEqual(case.runtime.helper_events,
                                     [('create', 'prepare'), ('start', 'prepare')] +
                                     ([] if exhausted else [('poll', 'prepare')]))
                    self.assertEqual(case.docker.restarts, [])


if __name__ == '__main__':
    unittest.main()

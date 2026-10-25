"""Real helper parser and durable scheduler; Docker HTTP/process boundaries are fake."""
import copy
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from gate import engine as transport
from gate.runtime_catalog import RuntimeCatalog
from gate.runtime_engine import RuntimeEngine
from gate.service import Gate
from test_runtime_catalog import release
from test_runtime_inspect_transport import inspect_response
from test_runtime_source_validation import HelperDocker, proof
import test_runtime_updates as base


def timeout():
    # The fallback lets the behavior regressions run against the pre-fix client.
    return getattr(transport, 'DockerTimeout', transport.DockerError)('Docker operation timed out')


class PollDocker(HelperDocker):
    def __init__(self):
        super().__init__()
        self.errors = {}
        self.on_started = lambda job, phase, cid: None

    def fault(self, boundary, cid):
        errors = self.errors.get((boundary, cid), [])
        if errors:
            raise errors.pop(0)

    def inspect(self, key, timeout=None):
        self.fault('inspect', key)
        return super().inspect(key, timeout=timeout)

    def call(self, method, path, value=None, **kwargs):
        cid = path.split('/')[2]
        if '/logs?' in path:
            self.fault('logs', cid)
        elif method == 'POST' and path.endswith('/start'):
            self.fault('start', cid)
        elif method == 'POST' and '/stop?' in path:
            self.fault('stop', cid)
            self.calls.append((method, path))
            self.items[cid]['State'].update(Status='exited', Running=False)
            return None
        return super().call(method, path, value, **kwargs)


class CompletingRuntime(RuntimeEngine):
    def profile(self, job):
        return base.InstallBoundary.profile(self, job)

    def consumers(self, *, timeout=3):
        return []

    def start(self, job, phase):
        cid = super().start(job, phase)
        value = {'ok': True, 'version': job['version'], 'changed': phase == 'activate'}
        if phase.startswith('source-'):
            value = proof(job['sources'][phase[7:]]['identity'], job['profile'])
        elif phase == 'prepare':
            value['candidate'] = base.InstallBoundary.candidate(job)
        elif phase == 'validate':
            value['evidence'] = base.InstallBoundary.evidence(job)
        self.engine.logs[cid] = value
        self.engine.items[cid]['State'].update(Status='exited', Running=False, ExitCode=0)
        self.engine.on_started(job, phase, cid)
        return cid


class TimeoutClassificationTests(unittest.TestCase):
    def test_transport_timeout_has_distinct_type_and_preserves_docker_base(self):
        with inspect_response(200, b'{}') as engine, patch('gate.engine.UnixConnection') as connection:
            connection.return_value.sock = None
            connection.return_value.getresponse.side_effect = TimeoutError('socket timed out')
            with self.assertRaises(transport.DockerError) as caught:
                engine.inspect('1' * 64, timeout=1)
        self.assertEqual(type(caught.exception).__name__, 'DockerTimeout')

    def test_expired_transport_deadline_has_typed_timeout(self):
        with inspect_response(200, b'{}') as engine:
            with self.assertRaises(transport.DockerError) as caught:
                engine.inspect('1' * 64, timeout=0)
        self.assertEqual(type(caught.exception).__name__, 'DockerTimeout')


class PollReconciliationTests(unittest.TestCase):
    def case(self, phase):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        gate = Gate(Path(temporary.name))
        self.addCleanup(gate.close)
        docker = PollDocker()
        runtime = CompletingRuntime(docker)
        manager = gate.runtime_updates
        manager.runtime_engine = runtime
        manager.catalog = RuntimeCatalog(fetch=lambda url: release(url.rsplit('/', 1)[-1]))
        manager.set_policy({'mode': 'auto', 'images': [base.IMAGE]})
        manager.submit({'version': '1.4.0', 'idempotency_key': base.KEY})
        job = manager._get(base.KEY)
        job['candidate'] = base.InstallBoundary.candidate(job)
        identity = base.measured_source()
        sources = {base.digest(identity): {'identity': identity}} if phase == 'source' else {}
        phase = 'source-' + base.digest(identity) if phase == 'source' else phase
        stage = ('preparing' if phase.startswith('source-') or phase == 'prepare' else
                 'validating' if phase == 'validate' else 'activating')
        manager._update(base.KEY, status='running', stage=stage, helpers={}, sources=sources,
                        candidate=job['candidate'], evidence=base.InstallBoundary.evidence(job))
        return SimpleNamespace(manager=manager, docker=docker, runtime=runtime, phase=phase,
                               root=Path(temporary.name), gate=gate, stage=stage)

    def recreate(self, case):
        case.gate.close()
        case.gate = Gate(case.root)
        self.addCleanup(case.gate.close)
        case.manager = case.gate.runtime_updates
        case.manager.runtime_engine = case.runtime
        return case.manager

    def seed_started(self, case):
        job = case.manager._get(base.KEY)
        cid = case.runtime.create(job, case.phase)
        job = case.manager._update(base.KEY, helpers={case.phase: {
            'id': cid, 'intent_at': int(time.time() * 1000)}})
        case.runtime.start(job, case.phase)
        return cid

    def starts(self, case):
        return [path for method, path in case.docker.calls if method == 'POST' and path.endswith('/start')]

    def test_one_observation_timeout_then_actual_receipt_recovers_all_phases(self):
        for phase in ('source', 'prepare', 'validate', 'activate'):
            for boundary in ('inspect', 'logs'):
                with self.subTest(phase=phase, boundary=boundary):
                    case = self.case(phase)
                    case.docker.on_started = lambda job, phase, cid: case.docker.errors.update({
                        (boundary, cid): [timeout()]})
                    case.manager._install(case.manager._get(base.KEY))
                    saved = case.manager._get(base.KEY)
                    self.assertEqual(saved['status'], 'running')
                    self.assertEqual(saved['stage'], case.stage)
                    helper = saved['helpers'][case.phase]
                    self.assertEqual(helper.get('poll_timeouts'), 1)
                    self.assertEqual(len(self.starts(case)), 1)
                    self.assertNotIn('evidence', saved.get('sources', {}).get(case.phase[7:], {}))
                    case.docker.on_started = lambda *args: None
                    manager = self.recreate(case)
                    manager._install(manager._get(base.KEY))
                    saved = manager._get(base.KEY)
                    self.assertEqual(saved['status'], 'running')
                    self.assertEqual(saved['stage'], 'prepared' if phase in ('source', 'prepare') else
                                     'validated' if phase == 'validate' else 'refreshing')
                    self.assertEqual(saved['helpers'][case.phase]['id'], helper['id'])
                    self.assertEqual(saved['helpers'][case.phase]['intent_at'], helper['intent_at'])
                    self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)
                    self.assertEqual(self.starts(case).count('/containers/' + helper['id'] + '/start'), 1)
                    if phase == 'source':
                        self.assertIn('evidence', saved['sources'][case.phase[7:]])

    def test_three_retries_are_durable_and_fourth_timeout_requires_recovery(self):
        case = self.case('prepare')
        cid = self.seed_started(case)
        case.docker.errors['inspect', cid] = [timeout() for _ in range(4)]
        for count in (1, 2, 3):
            manager = self.recreate(case)
            manager._install(manager._get(base.KEY))
            saved = manager._get(base.KEY)
            self.assertEqual((saved['status'], saved['stage']), ('running', 'preparing'))
            self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts'), count)
        manager = self.recreate(case)
        manager._install(manager._get(base.KEY))
        saved = manager._get(base.KEY)
        self.assertEqual((saved['status'], saved['stage']),
                         ('recovery_required', 'installation_outcome_unknown'))
        self.assertEqual(len(self.starts(case)), 1)

    def test_good_running_observation_resets_consecutive_timeout_budget(self):
        case = self.case('prepare')
        cid = self.seed_started(case)
        case.docker.items[cid]['State'].update(Status='running', Running=True)
        for _ in range(2):
            case.docker.errors['inspect', cid] = [timeout()]
            case.manager._install(case.manager._get(base.KEY))
        case.manager._install(case.manager._get(base.KEY))
        saved = case.manager._get(base.KEY)
        self.assertEqual(saved['status'], 'running')
        self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)
        case.docker.errors['inspect', cid] = [timeout()]
        case.manager._install(case.manager._get(base.KEY))
        saved = case.manager._get(base.KEY)
        self.assertEqual(saved['status'], 'running')
        self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts'), 1)

    def test_observation_timeout_after_intent_deadline_never_retries_or_stops(self):
        for boundary in ('inspect', 'logs'):
            with self.subTest(boundary=boundary):
                case = self.case('prepare')
                cid = self.seed_started(case)
                job = case.manager._get(base.KEY)
                helpers = copy.deepcopy(job['helpers'])
                helpers[case.phase]['intent_at'] = int((time.time() - 901) * 1000)
                case.manager._update(base.KEY, helpers=helpers)
                case.docker.errors[boundary, cid] = [timeout()]
                case.manager._install(case.manager._get(base.KEY))
                saved = case.manager._get(base.KEY)
                self.assertEqual(saved['status'], 'recovery_required')
                self.assertFalse(any('/stop?' in path for _, path in case.docker.calls))
                self.assertEqual(len(self.starts(case)), 1)

    def test_identity_and_http_errors_are_not_retryable(self):
        for failure in ('identity', 'http', 'same-text', 'malformed', 'missing'):
            with self.subTest(failure=failure):
                case = self.case('prepare')
                cid = self.seed_started(case)
                if failure == 'identity':
                    case.docker.items[cid]['Config']['User'] = '0:0'
                elif failure in ('http', 'same-text'):
                    case.docker.errors['inspect', cid] = [transport.DockerError(
                        'Docker operation failed (HTTP 500)' if failure == 'http' else 'Docker operation timed out')]
                elif failure == 'malformed':
                    case.docker.logs[cid] = {'ok': True, 'version': '1.4.0', 'changed': True}
                else:
                    case.docker.items.pop(cid)
                case.manager._install(case.manager._get(base.KEY))
                saved = case.manager._get(base.KEY)
                self.assertEqual(saved['status'], 'recovery_required')
                self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)
                self.assertEqual(len(self.starts(case)), 1)

    def stalled_observation(self, case, cid, boundary, engine):
        original_inspect, original_call = case.docker.inspect, case.docker.call

        def inspect(key, timeout=None):
            if boundary == 'inspect' and key == cid:
                return engine.inspect(key, timeout=timeout)
            return original_inspect(key, timeout=timeout)

        def call(method, path, value=None, **kwargs):
            if boundary == 'logs' and method == 'GET' and path.startswith('/containers/' + cid + '/logs?'):
                return engine.call(method, path, value, **kwargs)
            return original_call(method, path, value, **kwargs)

        with patch.object(case.docker, 'inspect', side_effect=inspect), \
                patch.object(case.docker, 'call', side_effect=call):
            case.manager._install(case.manager._get(base.KEY))

    def test_known_http_status_with_stalled_body_never_consumes_poll_budget(self):
        for boundary in ('inspect', 'logs'):
            for status in (404, 500):
                with self.subTest(boundary=boundary, status=status):
                    case = self.case('prepare')
                    cid = self.seed_started(case)
                    read = Mock(side_effect=TimeoutError('private daemon body'))
                    with inspect_response(status, read=read) as engine:
                        self.stalled_observation(case, cid, boundary, engine)
                    saved = case.manager._get(base.KEY)
                    self.assertEqual((saved['status'], saved['stage']),
                                     ('recovery_required', 'installation_outcome_unknown'))
                    self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)
                    self.assertEqual(saved['helpers'][case.phase]['id'], cid)
                    self.assertEqual(len(self.starts(case)), 1)
                    read.assert_not_called()

    def test_successful_stalled_body_consumes_only_readonly_poll_budget(self):
        for boundary in ('inspect', 'logs'):
            with self.subTest(boundary=boundary):
                case = self.case('prepare')
                cid = self.seed_started(case)
                before = case.manager._get(base.KEY)['helpers'][case.phase]
                read = Mock(side_effect=TimeoutError('private daemon body'))
                with inspect_response(200, read=read) as engine:
                    self.stalled_observation(case, cid, boundary, engine)
                saved = case.manager._get(base.KEY)
                self.assertEqual((saved['status'], saved['stage']), ('running', 'preparing'))
                helper = saved['helpers'][case.phase]
                self.assertEqual(helper.get('poll_timeouts'), 1)
                self.assertEqual((helper['id'], helper['intent_at']), (cid, before['intent_at']))
                self.assertEqual(len(self.starts(case)), 1)

    def test_start_timeout_stays_recovery_and_is_never_replayed(self):
        case = self.case('prepare')
        original = case.runtime.start
        attempts = []
        def start(job, phase):
            attempts.append(phase)
            cid = job['helpers'][phase]['id']
            case.docker.errors['start', cid] = [timeout()]
            return original(job, phase)
        case.runtime.start = start
        case.manager._install(case.manager._get(base.KEY))
        saved = case.manager._get(base.KEY)
        self.assertEqual(saved['status'], 'recovery_required')
        self.assertGreater(saved['helpers'][case.phase]['intent_at'], 0)
        manager = self.recreate(case)
        self.assertTrue(manager.tick())
        self.assertEqual(attempts, ['prepare'])
        self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)

    def test_stop_timeout_stays_recovery_without_observation_retry(self):
        case = self.case('prepare')
        cid = self.seed_started(case)
        case.docker.items[cid]['State'].update(Status='running', Running=True)
        helpers = case.manager._get(base.KEY)['helpers']
        helpers[case.phase]['intent_at'] = int((time.time() - 901) * 1000)
        case.manager._update(base.KEY, helpers=helpers)
        case.docker.errors['stop', cid] = [timeout()]
        case.manager._install(case.manager._get(base.KEY))
        saved = case.manager._get(base.KEY)
        self.assertEqual(saved['status'], 'recovery_required')
        self.assertEqual(saved['helpers'][case.phase].get('poll_timeouts', 0), 0)
        self.assertEqual(case.docker.errors['stop', cid], [])
        self.assertEqual(len(self.starts(case)), 1)
        manager = self.recreate(case)
        self.assertTrue(manager.tick())

    def test_failed_and_unknown_receipts_keep_existing_contracts(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                case = self.case('prepare')
                cid = self.seed_started(case)
                case.docker.logs[cid] = ({'ok': False, 'stage': 'install_failed'} if failed else {})
                case.docker.items[cid]['State']['ExitCode'] = 1 if failed else 0
                case.manager._install(case.manager._get(base.KEY))
                saved = case.manager._get(base.KEY)
                self.assertEqual((saved['status'], saved['stage']),
                                 ('failed', 'install_failed') if failed else
                                 ('recovery_required', 'installation_outcome_unknown'))


if __name__ == '__main__':
    unittest.main()

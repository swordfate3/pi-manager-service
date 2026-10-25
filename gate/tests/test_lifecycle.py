"""Lifecycle contract tests: real ledger/HTTP, fake Docker boundary only."""
import copy
import concurrent.futures
import contextlib
import http.client
import http.server
import json
import io
import os
from pathlib import Path
import runpy
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from gate.engine import Engine, DockerError
from gate.service import Gate as ServiceGate, start_servers

RUN = 'a' * 32
KEY = 'b' * 32
CID = 'c' * 64
IMAGE = 'sha256:' + 'd' * 64
BODY = dict(run_id=RUN, runtime_id='runtime-old', session_id='session', leaf_id=None,
            idempotency_key=KEY)


class Gate(ServiceGate):
    """Legacy policy/transport fixture with explicit synthetic Gate evidence.

    Source lookup and final Gate fences remain real. Only offline restoration
    is doubled; this fixture is not Pi or source-compatibility acceptance.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        from gate.runtime_catalog import RuntimeCatalog
        from gate.runtime_engine import RuntimeEngine
        from gate.runtime_install import digest
        from gate.registry import fingerprint
        from gate.store import _json
        from test_runtime_catalog import release
        from test_runtime_source_validation import proof
        from test_runtime_updates import InstallBoundary, measured_source
        key = '9' * 32
        policy = {'mode': 'auto', 'images': [IMAGE]}
        artifact = RuntimeCatalog(fetch=lambda _: release('2.0.0')).resolve('2.0.0')
        identity = measured_source('1.0.0')
        record = {'id': key, 'version': '2.0.0', 'installed_version': '2.0.0',
                  'status': 'succeeded', 'stage': 'complete', 'targets': [], 'policy': policy,
                  'profile': RuntimeEngine.profile({'policy': policy}),
                  'release': artifact, 'release_hash': fingerprint(artifact)}
        record['candidate'] = InstallBoundary.candidate(record)
        record['evidence'] = InstallBoundary.evidence(record)
        record['sources'] = {digest(identity): {'identity': identity, 'evidence': proof(identity, record['profile'])}}
        with self.store.lock, self.store._write_transaction():
            self.store.db.execute('INSERT OR IGNORE INTO runtime_jobs (id,data) VALUES (?,?)', (key, _json(record)))
        def offline_restore(life, job, item, state, outer):
            return life._update(job['id'], restore_proof={'synthetic_lifecycle_fixture': True})
        self._restore_boundary = mock.patch('gate.runtime_restore.prepare_refresh', side_effect=offline_restore)
        self._restore_boundary.start()

    def close(self):
        super().close()
        if hasattr(self, '_restore_boundary'):
            self._restore_boundary.stop()


class FakeEngine:
    def __init__(self):
        self.item = {'Id': CID, 'Image': IMAGE, 'State': {'Running': True, 'StartedAt': '2026-10-17T00:00:00Z'},
                     'Config': {'User': '1000:1000', 'Entrypoint': ['/usr/local/bin/pi-entrypoint'],
                                'Labels': {'cn.swordfate.pi.run-id': RUN, 'cn.swordfate.pi.lifecycle': '1'}},
                     'HostConfig': {'Privileged': False, 'CapAdd': [], 'CapDrop': ['ALL'],
                                    'SecurityOpt': ['no-new-privileges:true']}, 'Mounts': []}
        self.snapshot = dict(managed=True, run_id=RUN, runtime_id='runtime-old', session_id='session',
                             leaf_id=None, version='1.0.0', idle=True, pending=False, busy=False)
        self.operation = None
        self.calls = []
        self.ids = [CID]
        self.before_restart = lambda: None
        self.on_status = lambda: None
        self.final_changes = {}
        self.ack_changes = {}
        self.fail_restart = False
        self.volume_options = {}

    def list_lifecycle(self, run_id, timeout=None):
        assert run_id == RUN
        return [{'Id': identifier} for identifier in self.ids]

    def inspect(self, identifier, timeout=None):
        assert identifier == CID
        return copy.deepcopy(self.item)

    def lifecycle_volume(self, name, timeout=None):
        return {'Name': name, 'Driver': 'local', 'Scope': 'local', 'Options': self.volume_options,
                'Mountpoint': '/var/lib/docker/volumes/' + name + '/_data'}

    def lifecycle_control(self, identifier, request, timeout=None):
        assert identifier == CID
        self.calls.append(copy.deepcopy(request))
        if request == {'action': 'status'}:
            self.on_status()
            from test_runtime_updates import measured_source
            return {'ok': True, 'result': {**self.snapshot,
                    'source_identity': measured_source(self.snapshot['version']),
                    **({'operation': self.operation} if self.operation else {})}}
        request = copy.deepcopy(request)
        assert request.pop('restore_proof', {'synthetic_lifecycle_fixture': True}) == {'synthetic_lifecycle_fixture': True}
        assert request == {k: v for k, v in {**BODY, 'action': 'restart', 'operation_id': KEY}.items()
                           if k != 'idempotency_key'}
        self.before_restart()
        if self.fail_restart:
            raise DockerError('sensitive transport detail')
        self.operation = dict(operation_id=KEY, status='succeeded', stage='complete',
                              old_runtime_id='runtime-old', new_runtime_id='runtime-new',
                              session_id='session', leaf_id=None, old_version='1.0.0',
                              expected_version='2.0.0', new_version='2.0.0', **{})
        self.operation.update(self.final_changes)
        self.snapshot.update(runtime_id='runtime-new', version='2.0.0')
        return {'ok': True, 'result': dict(operation_id=KEY, status='running', stage='checking',
                                          **{}) | self.ack_changes}


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.gate.close())

    def lifecycle(self, mode='auto'):
        # Missing API is an explicit assertion failure, not an import/setup error.
        self.assertTrue(hasattr(self.gate, 'lifecycle'), 'Gate lacks lifecycle API')
        life = self.gate.lifecycle
        life.engine = self.engine
        if mode is not None:
            life.set_policy({'mode': mode, 'images': [IMAGE]})
        return life

    def finish(self):
        self.gate.tick()
        if self.gate.worker:
            self.gate.worker.join(3)
            self.assertFalse(self.gate.worker.is_alive())

    def test_default_disabled_is_independent_and_token_private(self):
        life = self.lifecycle(None)
        self.assertEqual(life.policy()['mode'], 'disabled')
        with self.assertRaises(RuntimeError):
            life.submit(BODY)
        token = self.gate.lifecycle_token
        self.assertRegex(token, r'^[a-f0-9]{64}$')
        self.assertNotEqual(token, self.gate.token)
        self.assertEqual((Path(self.tmp.name) / 'lifecycle.token').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.engine.calls, [])

    def test_auto_persists_intent_before_fixed_restart_and_verifies_success(self):
        life = self.lifecycle()
        def durable_intent():
            import sqlite3
            with sqlite3.connect(Path(self.tmp.name) / 'jobs.sqlite3') as db:
                row = json.loads(db.execute('SELECT data FROM lifecycle_jobs WHERE id=?', (KEY,)).fetchone()[0])
            self.assertEqual(row['id'], KEY)
            self.assertEqual(row['status'], 'running')
            self.assertTrue(row['intent_at'])
            self.assertIs(type(row['started_at']), int)
            self.assertGreater(row['started_at'], 0)
            self.assertLessEqual(row['started_at'], 2 ** 53 - 1)
        self.engine.before_restart = durable_intent
        job = life.submit(BODY)
        self.assertEqual((job['id'], job['status']), (KEY, 'queued'))
        self.finish()
        result = life.get(KEY)
        self.assertEqual((result['status'], result['new_version']), ('succeeded', '2.0.0'))
        self.assertEqual(result['new_runtime_id'], 'runtime-new')
        self.assertNotIn(CID, json.dumps(result))
        self.assertNotIn('intent_at', result)
        self.assertIs(type(result['started_at']), int)

    def test_manual_wait_does_not_consume_started_budget(self):
        life = self.lifecycle('manual')
        with mock.patch('time.time', return_value=time.time() - 600):
            job = life.submit(BODY)
        self.assertNotIn('started_at', job)
        life.approve(KEY)
        before = int(time.time() * 1000)
        self.finish()
        result = life.get(KEY)
        self.assertEqual(result['status'], 'succeeded')
        self.assertGreaterEqual(result['started_at'], before)
        with self.assertRaises((ValueError, RuntimeError)):
            life._update(KEY, started_at=result['started_at'] + 1)

    def test_async_checking_without_expected_version_can_fail_safely(self):
        life = self.lifecycle()
        self.engine.final_changes = {'status': 'failed', 'stage': 'checking_rejected'}
        def checking_rejected():
            if self.engine.operation:
                for key in ('old_version', 'expected_version', 'new_version', 'new_runtime_id'):
                    self.engine.operation.pop(key, None)
        self.engine.on_status = checking_rejected
        life.submit(BODY)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'failed')
        deploy = self.gate.store.request('1' * 40)
        with self.assertRaises(RuntimeError):
            self.gate.approve(deploy['id'], commit='1' * 40)

    def test_manual_approve_reject_and_policy_fence(self):
        life = self.lifecycle('manual')
        self.assertEqual(life.submit(BODY)['status'], 'pending')
        self.finish()
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))
        life.approve(KEY)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'succeeded')

    def test_reject_never_executes_and_cannot_approve(self):
        life = self.lifecycle('manual')
        life.submit(BODY)
        self.assertEqual(life.reject(KEY)['status'], 'rejected')
        with self.assertRaises(RuntimeError):
            life.approve(KEY)
        self.finish()
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_policy_change_does_not_authorize_old_pending_or_queued(self):
        life = self.lifecycle('manual')
        life.submit(BODY)
        life.set_policy({'mode': 'auto', 'images': [IMAGE]})
        with self.assertRaises(RuntimeError):
            life.approve(KEY)
        self.finish()
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_policy_change_after_status_fences_restart(self):
        life = self.lifecycle()
        life.submit(BODY)
        self.engine.on_status = lambda: life.set_policy({'mode': 'disabled', 'images': [IMAGE]})
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'stale')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_target_and_runtime_configuration_rejections(self):
        life = self.lifecycle()
        original = copy.deepcopy(self.engine.item)
        mutations = [lambda x: x.update(Image='sha256:' + 'e' * 64),
                     lambda x: x['Config']['Labels'].update({'cn.swordfate.pi.lifecycle': '0'}),
                     lambda x: x['Config']['Labels'].update({'cn.swordfate.pi.run-id': 'e' * 32}),
                     lambda x: x['Config'].update(User='0:0'),
                     lambda x: x['Config'].update(Entrypoint=['sh']),
                     lambda x: x['HostConfig'].update(Privileged=True),
                     lambda x: x['HostConfig'].update(CapAdd=['SYS_ADMIN']),
                     lambda x: x['HostConfig'].update(CapDrop=[]),
                     lambda x: x['HostConfig'].update(SecurityOpt=[]),
                     lambda x: x['HostConfig'].update(PidMode='host'),
                     lambda x: x.update(Mounts=[{'Type': 'bind', 'Source': '/var/run/docker.sock', 'Destination': '/hidden', 'RW': False}]),
                     lambda x: x.update(Mounts=[{'Type': 'volume', 'Name': 'gate-state', 'Source': '/var/lib/docker/volumes/gate-state/_data', 'Destination': '/state'}]),
                     lambda x: x.update(Mounts=[{'Type': 'bind', 'Source': '/tmp/control', 'Destination': '/usr/local/bin', 'RW': False}]),
                     lambda x: x['State'].update(Running=False)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.engine.item = copy.deepcopy(original)
                mutate(self.engine.item)
                self.assertEqual(life.target(RUN), {'managed': False})
                with self.assertRaises(RuntimeError):
                    life.submit(BODY)
        self.engine.item = original
        self.engine.ids = [CID, 'f' * 64]
        self.assertEqual(life.target(RUN), {'managed': False})
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_staged_launcher_data_mounts_are_supported_without_authority_mounts(self):
        life = self.lifecycle()
        self.engine.item['Mounts'] = [
            {'Type': 'volume', 'Name': name, 'Source': '/var/lib/docker/volumes/' + name + '/_data',
             'Destination': dest, 'RW': rw, 'Driver': 'local'}
            for name, dest, rw in [('pi-user-home', '/home/node', True), ('pi-runtime', '/home/node/.local', True),
                                  ('pi-home', '/home/node/.pi', True), ('pi-credentials', '/home/node/.credentials', True),
                                  ('pi-huggingface-cache', '/home/node/.cache/huggingface', True),
                                  ('pi-web-hub-runtime', '/run/pi-web-hub', False)]]
        self.engine.item['Mounts'] += [
            {'Type': 'bind', 'Source': '/home/fate/project', 'Destination': '/workspace', 'RW': True},
            {'Type': 'bind', 'Source': '/home/fate/.cc-switch/pi', 'Destination': '/run/cc-switch-pi-models', 'RW': True},
            {'Type': 'bind', 'Source': '/home/fate/.vscode-server/extensions/example/bridge',
             'Destination': '/home/fate/.vscode-server/extensions/example/bridge', 'RW': False}]
        self.assertEqual(life.target(RUN)['managed'], True)
        self.engine.item['Mounts'][5]['RW'] = True
        self.assertEqual(life.target(RUN), {'managed': False})

    def test_allowed_volume_name_cannot_hide_host_authority_bind(self):
        life = self.lifecycle()
        self.engine.item['Mounts'] = [{'Type': 'volume', 'Name': 'pi-home', 'Driver': 'local', 'RW': True,
                                      'Source': '/var/lib/docker/volumes/pi-home/_data', 'Destination': '/home/node/.pi'}]
        self.engine.volume_options = {'type': 'none', 'o': 'bind', 'device': '/var/run'}
        self.assertEqual(life.target(RUN), {'managed': False})

    def test_tmpfs_over_control_code_and_extra_group_are_rejected(self):
        life = self.lifecycle()
        self.engine.item['HostConfig']['Tmpfs'] = {'/usr/local/bin': 'rw'}
        self.assertEqual(life.target(RUN), {'managed': False})
        self.engine.item['HostConfig'].pop('Tmpfs')
        self.engine.item['HostConfig']['GroupAdd'] = ['0']
        self.assertEqual(life.target(RUN), {'managed': False})

    def test_control_runtime_directory_override_is_rejected(self):
        life = self.lifecycle()
        self.engine.item['Config']['Env'] = ['PI_RUNTIME_DIR=/workspace/forged']
        self.assertEqual(life.target(RUN), {'managed': False})

    def test_concurrent_same_key_creates_one_durable_job(self):
        life = self.lifecycle()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            jobs = list(pool.map(lambda _: life.submit(BODY), range(4)))
        self.assertEqual([j['id'] for j in jobs], [KEY] * 4)
        self.assertEqual(len(life.jobs()), 1)

    def test_explicit_inspection_retains_unknown_outcome_and_unblocks(self):
        life = self.lifecycle()
        self.engine.fail_restart = True
        life.submit(BODY)
        self.finish()
        with self.assertRaises(ValueError):
            life.resolve(KEY, 'runtime-old', 'yes')
        with self.assertRaises(RuntimeError):
            life.resolve(KEY, 'wrong', 'inspected_no_retry')
        receipt = life.resolve(KEY, 'runtime-old', 'inspected_no_retry')
        self.assertTrue(receipt['resolved'])
        self.assertEqual(receipt['status'], 'recovery_required')
        self.assertEqual(life.active(), [])
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        self.assertEqual(self.gate.store.events()[0]['action'], 'lifecycle_resolved')
        self.assertEqual(len([c for c in self.engine.calls if c['action'] == 'restart']), 1)

    def test_terminal_success_rejects_each_changed_identity_or_version(self):
        changes = ({'old_runtime_id': 'different'}, {'new_runtime_id': 'runtime-old'},
                   {'session_id': 'different'}, {'leaf_id': 'different'}, {'old_version': 'wrong'},
                   {'expected_version': 'wrong'}, {'new_version': 'wrong'}, {'operation_id': 'f' * 32},
                   {'stage': 'not-safe-stage'}, {'new_runtime_id': ''})
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                gate = Gate(Path(directory))
                try:
                    engine = FakeEngine()
                    engine.final_changes = change
                    gate.lifecycle.engine = engine
                    gate.lifecycle.set_policy({'mode': 'auto', 'images': [IMAGE]})
                    gate.lifecycle.submit(BODY)
                    gate.tick()
                    gate.worker.join(3)
                    self.assertEqual(gate.lifecycle.get(KEY)['status'], 'recovery_required')
                finally:
                    gate.close()

    def test_restart_same_container_id_but_new_generation_is_rejected(self):
        life = self.lifecycle()
        self.engine.item['State']['StartedAt'] = '2026-10-17T01:00:00Z'
        life.submit(BODY)
        self.engine.item['State']['StartedAt'] = '2026-10-17T02:00:00Z'
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'stale')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_expected_version_cannot_change_after_checking(self):
        life = self.lifecycle()
        life.submit(BODY)
        count = 0
        def status():
            nonlocal count
            if self.engine.operation:
                count += 1
                self.engine.operation.update(status='running' if count == 1 else 'succeeded',
                                             expected_version='other' if count == 1 else '2.0.0')
        self.engine.on_status = status
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')

    def test_queued_policy_change_stales_without_start_timestamp(self):
        life = self.lifecycle()
        life.submit(BODY)
        life.set_policy({'mode': 'disabled', 'images': [IMAGE]})
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'stale')
        self.assertNotIn('started_at', life.get(KEY))

    def test_persisted_token_and_policy_remain_independent_of_hub_auto(self):
        from test_multiservice import POLICY
        life = self.lifecycle('manual')
        token, generation = self.gate.lifecycle_token, life.policy()['generation']
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name), policy=POLICY)
        self.assertEqual(self.gate.store.service('pi-web-hub')['mode'], 'auto')
        self.assertEqual(self.gate.lifecycle.policy()['mode'], 'manual')
        self.assertEqual(self.gate.lifecycle.policy()['generation'], generation)
        self.assertEqual(self.gate.lifecycle_token, token)

    def test_auto_image_deploy_tick_stays_blocked_by_lifecycle(self):
        from test_registry import image_service
        life = self.lifecycle()
        service = self.gate.store.register_service(image_service(mode='auto'))
        reference = service['source']['repository'] + '@sha256:' + 'e' * 64
        deploy = self.gate.store.request_version(service['id'], {'image': reference}, automatic=True)
        life.submit(BODY)
        self.engine.fail_restart = True
        self.finish()
        self.finish()
        self.assertEqual(self.gate.store.get(deploy['id'])['status'], 'queued')

    def test_failed_result_remains_in_active_inspection_set(self):
        life = self.lifecycle()
        life.submit(BODY)
        self.engine.final_changes = {'status': 'failed', 'stage': 'checking_rejected'}
        self.finish()
        self.assertEqual(life.active()[0]['status'], 'failed')

    def test_no_new_privileges_cannot_be_negated_by_conflicting_option(self):
        life = self.lifecycle()
        self.engine.item['HostConfig']['SecurityOpt'].append('no-new-privileges:false')
        self.assertEqual(life.target(RUN), {'managed': False})

    def test_rechecks_immutable_container_immediately_before_exec(self):
        life = self.lifecycle()
        life.submit(BODY)
        self.engine.on_status = lambda: self.engine.item['HostConfig'].update(Privileged=True)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'stale')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_stale_identity_or_busy_rejected(self):
        life = self.lifecycle()
        for changes in ({'runtime_id': 'other'}, {'session_id': 'other'}, {'leaf_id': 'other'},
                        {'idle': False}, {'busy': True}, {'pending': True}):
            with self.subTest(changes=changes):
                original = dict(self.engine.snapshot)
                self.engine.snapshot.update(changes)
                with self.assertRaises(RuntimeError):
                    life.submit(BODY)
                self.engine.snapshot = original

    def test_idempotency_conflicts_and_same_run_admission(self):
        life = self.lifecycle()
        first = life.submit(BODY)
        self.assertEqual(life.submit(BODY), first)
        for changes in ({'session_id': 'other'}, {'idempotency_key': 'f' * 32}):
            with self.assertRaises(RuntimeError):
                life.submit(BODY | changes)
        self.finish()
        self.assertEqual(life.submit(BODY)['status'], 'succeeded')
        self.assertEqual(len([c for c in self.engine.calls if c['action'] == 'restart']), 1)

    def test_input_validation_is_exact_and_bounded(self):
        life = self.lifecycle()
        for changes in ({'run_id': RUN.upper()}, {'idempotency_key': 'x'}, {'runtime_id': ''},
                        {'session_id': 'x' * 257}, {'leaf_id': '\x85'}, {'leaf_id': 3},
                        {'command': 'sh'}, {'runtime_id': 'x\n'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                life.submit(BODY | changes)
        for value in (None, [], {k: v for k, v in BODY.items() if k != 'leaf_id'}):
            with self.assertRaises(ValueError):
                life.submit(value)

    def test_deployment_approval_rollback_and_upgrade_blocked_by_lifecycle(self):
        life = self.lifecycle()
        life.submit(BODY)
        deploy = self.gate.store.request('1' * 40)
        with self.assertRaises(RuntimeError):
            self.gate.approve(deploy['id'], commit='1' * 40)
        self.gate.store.update(deploy['id'], status='deployed', old_id='old', new_id='new')
        with self.assertRaises(RuntimeError):
            self.gate.rollback(deploy['id'], commit='1' * 40)
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        check = namespace['check_upgrade_ready']
        check.__globals__['docker'] = lambda *a, **k: b'id' if a[0] == 'ps' else b'[{"State":{"Running":true}}]'
        check.__globals__['admin'] = lambda *a: {'requests': [], 'active': [], 'lifecycle_active': [life.get(KEY)]}
        with self.assertRaises(RuntimeError):
            check()

    def test_deployment_active_blocks_lifecycle(self):
        life = self.lifecycle()
        deploy = self.gate.store.request('1' * 40)
        self.gate.store.update(deploy['id'], status='deploying')
        with self.assertRaises(RuntimeError):
            life.submit(BODY)

    def test_final_identity_version_or_operation_mismatch_is_not_success(self):
        life = self.lifecycle()
        self.engine.final_changes = {'session_id': 'wrong'}
        life.submit(BODY)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        with self.assertRaises(RuntimeError):
            life.submit(BODY | {'idempotency_key': 'e' * 32})

    def test_ack_operation_mismatch_is_unknown_and_never_retried(self):
        life = self.lifecycle()
        self.engine.ack_changes = {'operation_id': 'e' * 32}
        life.submit(BODY)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        self.finish()
        self.assertEqual(len([c for c in self.engine.calls if c['action'] == 'restart']), 1)

    def test_restart_transport_failure_blocks_until_explicit_inspection(self):
        life = self.lifecycle()
        self.engine.fail_restart = True
        life.submit(BODY)
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        self.assertNotIn('sensitive', json.dumps(life.get(KEY)))
        with self.assertRaises(RuntimeError):
            life.reject(KEY)

    def test_crash_recovery_only_polls_and_keeps_same_operation_id(self):
        life = self.lifecycle()
        life.submit(BODY)
        started = int(time.time() * 1000)
        life._update(KEY, status='running', stage='restart_intent', intent_at=started, started_at=started)
        self.engine.operation = {'operation_id': KEY, 'status': 'succeeded', 'stage': 'complete',
                                 'old_runtime_id': 'runtime-old', 'new_runtime_id': 'runtime-new',
                                 'session_id': 'session', 'leaf_id': None, 'old_version': '1.0.0',
                                 'expected_version': '2.0.0', 'new_version': '2.0.0'}
        self.engine.snapshot.update(runtime_id='runtime-new', version='2.0.0')
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        self.gate.lifecycle.engine = self.engine
        self.gate.lifecycle.recover()
        self.finish()
        self.assertEqual(self.gate.lifecycle.get(KEY)['status'], 'succeeded')
        self.assertEqual(self.gate.lifecycle.get(KEY)['started_at'], started)
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_missing_operation_during_recovery_is_unknown(self):
        life = self.lifecycle()
        life.submit(BODY)
        started = int(time.time() * 1000)
        life._update(KEY, status='running', stage='restart_intent', intent_at=started, started_at=started)
        life.recover()
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_recovery_expired_budget_cannot_restart(self):
        life = self.lifecycle()
        life.submit(BODY)
        started = int(time.time() * 1000) - 211000
        life._update(KEY, status='running', stage='checking', intent_at=started, started_at=started)
        life.recover()
        self.finish()
        self.assertEqual(life.get(KEY)['status'], 'recovery_required')
        self.assertEqual(life.get(KEY)['started_at'], started)
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))


class LifecycleHTTPTest(LifecycleTest):
    # Only HTTP-specific tests; inherited contract tests remain on LifecycleTest.
    def request(self, method, path, value=None, token=None, admin=False):
        conn = http.client.HTTPConnection('127.0.0.1', self.http.server_address[1], timeout=3)
        if admin:
            conn.sock = socket.socket(socket.AF_UNIX)
            conn.sock.connect(str(Path(self.tmp.name) / 'admin.sock'))
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        conn.request(method, path, json.dumps(value) if value is not None else None, headers)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_http_separates_tokens_sanitizes_and_admin_is_private(self):
        life = self.lifecycle()
        self.http, admin = start_servers(self.gate, port=0)
        for server in (self.http, admin):
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        token = self.gate.lifecycle_token
        path = '/v1/pi-lifecycle/restarts'
        self.assertEqual(self.request('POST', path, BODY, self.gate.token)[0], 401)
        for route in ('/v1/requests', '/v1/services', '/admin/requests', '/admin/lifecycle'):
            self.assertIn(self.request('GET', route, token=token)[0], (401, 404))
        self.assertEqual(self.request('GET', '/v1/pi-lifecycle/runs/' + RUN, token=token)[1]['mode'], 'auto')
        code, job = self.request('POST', path, BODY, token)
        self.assertEqual(code, 202)
        self.assertEqual(job['id'], KEY)
        self.assertEqual(self.request('GET', path + '/' + KEY, token=token)[1], job)
        self.assertEqual(self.request('POST', path, BODY | {'junk': 'x' * 5000}, token)[0], 400)
        status = self.request('GET', '/admin/requests', admin=True)[1]
        self.assertEqual(status['lifecycle_active'][0]['id'], KEY)
        self.assertNotIn(token, json.dumps(status))
        self.assertNotIn(CID, json.dumps(job))

    def test_admin_cli_policy_query_approval_export_uses_private_socket(self):
        self.lifecycle(None)
        self.http, admin = start_servers(self.gate, port=0)
        for server in (self.http, admin):
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        def invoke(command, payload=None, identifier=None):
            args = ['/usr/bin/python3', '-m', 'gate.admin', '--state', self.tmp.name, command]
            if identifier:
                args.append(identifier)
            if payload is not None:
                args.append('--json-stdin')
            return subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                  capture_output=True, text=True, timeout=3)
        policy = invoke('lifecycle-policy', {'mode': 'manual', 'images': [IMAGE]})
        self.assertEqual(policy.returncode, 0, policy.stderr)
        self.assertEqual(json.loads(policy.stdout)['mode'], 'manual')
        self.gate.lifecycle.submit(BODY)
        query = invoke('lifecycle', identifier=KEY)
        self.assertEqual(query.returncode, 0, query.stderr)
        self.assertEqual(json.loads(query.stdout)['status'], 'pending')
        approve = invoke('lifecycle-approve', {'id': KEY})
        self.assertEqual(approve.returncode, 0, approve.stderr)
        self.assertEqual(json.loads(approve.stdout)['status'], 'queued')
        exported = invoke('lifecycle-export', {})
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertEqual(json.loads(exported.stdout)['token'], self.gate.lifecycle_token)
        self.assertNotIn(self.gate.lifecycle_token, query.stdout + policy.stdout + approve.stdout)

    def test_health_and_job_queries_stay_responsive_while_control_polls(self):
        life = self.lifecycle()
        self.http, admin = start_servers(self.gate, port=0)
        for server in (self.http, admin):
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        polling, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        life.submit(BODY)
        def hold_status():
            if self.engine.operation:
                polling.set()
                release.wait(2)
        self.engine.on_status = hold_status
        self.gate.tick()
        self.assertTrue(polling.wait(2))
        start = time.monotonic()
        self.assertEqual(self.request('GET', '/healthz')[0], 200)
        response = self.request('GET', '/v1/pi-lifecycle/restarts/' + KEY, token=self.gate.lifecycle_token)
        self.assertEqual(response[1]['status'], 'running')
        self.assertIs(type(response[1]['started_at']), int)
        self.assertLess(time.monotonic() - start, 1)
        release.set()
        self.finish()


# Avoid duplicating base tests in the HTTP subclass.
for _name in tuple(LifecycleTest.__dict__):
    if _name.startswith('test_'):
        setattr(LifecycleHTTPTest, _name, None)


class LifecycleEngineTest(unittest.TestCase):
    def serve(self, raw, exit_code=0):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.calls = []
        calls = self.calls
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def respond(self, raw):
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def do_POST(self):
                value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path, value))
                self.respond(raw if self.path.endswith('/start') else json.dumps({'Id': 'e' * 64}).encode())
            def do_GET(self):
                calls.append((self.path, None))
                self.respond(json.dumps({'Running': False, 'ExitCode': exit_code}).encode())
        server = socketserver.UnixStreamServer(str(Path(tmp.name) / 'fake.sock'), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return Engine(str(Path(tmp.name) / 'fake.sock'))

    @staticmethod
    def frame(raw, channel=1):
        return bytes([channel, 0, 0, 0]) + struct.pack('>I', len(raw)) + raw

    def test_fixed_exec_multiplex_stream_exit_code_and_limits(self):
        payload = b'{"ok":true,"result":{"managed":true}}'
        engine = self.serve(self.frame(payload[:9]) + self.frame(payload[9:]))
        self.assertTrue(hasattr(engine, 'lifecycle_control'), 'Engine lacks fixed lifecycle exec')
        self.assertEqual(engine.lifecycle_control(CID, {'action': 'status'})['ok'], True)
        create = self.calls[0]
        self.assertEqual(create[0], '/v1.45/containers/' + CID + '/exec')
        self.assertEqual(create[1], {'User': '1000:1000', 'Privileged': False, 'AttachStdin': False,
                                     'AttachStdout': True, 'AttachStderr': True, 'Tty': False,
                                     'Env': ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                                             'PYTHONNOUSERSITE=1', 'PYTHONSAFEPATH=1'],
                                     'Cmd': ['/usr/local/bin/pi-session-control', '--request', '{"action":"status"}']})
        self.assertEqual(self.calls[1][1], {'Detach': False, 'Tty': False})
        self.assertTrue(self.calls[2][0].endswith('/json'))

    def test_exec_rejects_bad_frame_nonzero_exit_oversize_and_arbitrary_action(self):
        self.assertTrue(hasattr(Engine, 'lifecycle_control'), 'Engine lacks fixed lifecycle exec')
        for raw, code in ((b'not a frame', 0), (self.frame(b'{}'), 1),
                          (self.frame(b'x' * 16385), 0), (self.frame(b'{}', 2), 0),
                          (self.frame(b'{"ok":true}')[:-1], 0)):
            with self.subTest(code=code, length=len(raw)):
                engine = self.serve(raw, code)
                self.assertTrue(hasattr(engine, 'lifecycle_control'), 'Engine lacks fixed lifecycle exec')
                with self.assertRaises(DockerError):
                    engine.lifecycle_control(CID, {'action': 'status'})
        with self.assertRaises(ValueError):
            engine.lifecycle_control(CID, {'action': 'exec', 'argv': ['sh']})


class LifecycleHostTest(unittest.TestCase):
    def main(self, args, callback):
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))
        main = namespace['main']
        main.__globals__['admin'] = callback
        main.__globals__['docker'] = lambda *a, **k: self.fail('help must not call Docker')
        output = io.StringIO()
        with mock.patch.object(sys, 'argv', ['gatectl', *args]), contextlib.redirect_stdout(output):
            try:
                code = main()
            except SystemExit as error:
                code = error.code
        return code, output.getvalue()

    def test_offline_help_and_exact_policy_approve_usage(self):
        for command in ('lifecycle', 'lifecycle-policy', 'lifecycle-approve', 'lifecycle-reject',
                        'lifecycle-resolve', 'lifecycle-export'):
            with self.subTest(command=command):
                code, output = self.main([command, '--help'], lambda *a, **k: self.fail('help called admin'))
                self.assertEqual(code, 0)
                self.assertIn(command, output)
        calls = []
        def admin(*args, **kwargs):
            calls.append((args, kwargs))
            return {'status': 'queued'}
        self.assertEqual(self.main(['lifecycle-policy', 'auto', '--image', IMAGE], admin)[0], 0)
        self.assertEqual(calls[-1], (('lifecycle-policy',), {'payload': {'mode': 'auto', 'images': [IMAGE]}}))
        self.assertEqual(self.main(['lifecycle-approve', KEY], admin)[0], 0)
        self.assertEqual(calls[-1], (('lifecycle-approve',), {'payload': {'id': KEY}}))

    def test_export_is_private_no_stdout_token_no_overwrite_or_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'credential.json'
            token = 'e' * 64
            callback = lambda *a, **k: {'token': token}
            code, output = self.main(['lifecycle-export', str(destination)], callback)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(destination.read_text()), {'token': token})
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(token, output)
            with self.assertRaises((OSError, ValueError)):
                self.main(['lifecycle-export', str(destination)], callback)
            linked = Path(directory) / 'linked.json'
            linked.symlink_to(destination)
            with self.assertRaises((OSError, ValueError)):
                self.main(['lifecycle-export', str(linked)], callback)


if __name__ == '__main__':
    unittest.main()

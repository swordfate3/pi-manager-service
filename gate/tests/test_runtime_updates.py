"""Exercise the real ledger/scheduler; Docker and npm are external boundaries."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gate.service import Gate
from gate.runtime_catalog import RuntimeCatalog
from test_runtime_catalog import release
from gate.runtime_install import CHECKS, digest

IMAGE = 'sha256:' + 'd' * 64
KEY = 'e' * 32


def measured_source(version='1.1.0'):
    package = '/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent'
    return {'contract':'pi-runtime-source-v1','package':package,'executable':package+'/dist/cli.js',
            'version':version,'node':'>=22.19.0','tree_sha256':'7'*64}


class DockerBoundary:
    def __init__(self):
        self.items, self.states, self.operations = {}, {}, {}
        self.installed = '1.1.0'
        self.restarts = []
        self.before_restart = lambda cid: None
        for number in (1, 2):
            run, cid = str(number) * 32, str(number) * 64
            self.items[cid] = {
                'Id': cid, 'Image': IMAGE, 'State': {'Running': True, 'StartedAt': 'start'},
                'Config': {'User': '1000:1000', 'Entrypoint': ['/usr/local/bin/pi-entrypoint'],
                           'Labels': {'cn.swordfate.pi.run-id': run, 'cn.swordfate.pi.lifecycle': '1'}},
                'HostConfig': {'Privileged': False, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true']},
                'Mounts': [{'Type': 'volume', 'Name': 'pi-runtime', 'Driver': 'local',
                            'Destination': '/home/node/.local', 'RW': True,
                            'Source': '/var/lib/docker/volumes/pi-runtime/_data'}],
            }
            self.states[cid] = dict(managed=True, run_id=run, runtime_id='old-' + run,
                                    session_id='session-' + run, leaf_id='leaf-0', version='1.1.0',
                                    idle=True, pending=False, busy=False, source_identity=measured_source())

    def list_lifecycle(self, run, timeout=None):
        return [{'Id': cid} for cid, state in self.states.items() if state['run_id'] == run]

    def inspect(self, cid, timeout=None):
        return copy.deepcopy(self.items.get(cid))

    def lifecycle_volume(self, name, timeout=None):
        return dict(Name=name, Driver='local', Scope='local', Options=None,
                    Mountpoint='/var/lib/docker/volumes/' + name + '/_data')

    def lifecycle_control(self, cid, request, timeout=None):
        state = self.states[cid]
        if request['action'] == 'restart':
            self.before_restart(cid)
            self.restarts.append(cid)
            if not state['idle'] or state['busy'] or state['pending']:
                self.operations[cid] = dict(operation_id=request['operation_id'], status='failed',
                    stage='checking_rejected', old_runtime_id=state['runtime_id'],
                    session_id=state['session_id'], leaf_id=state['leaf_id'])
            else:
                self.operations[cid] = dict(operation_id=request['operation_id'], status='succeeded',
                    stage='complete', old_runtime_id=state['runtime_id'], new_runtime_id='new-' + state['run_id'],
                    old_version=state['version'], expected_version=self.installed, new_version=self.installed,
                    session_id=state['session_id'], leaf_id=state['leaf_id'])
                state.update(runtime_id='new-' + state['run_id'], version=self.installed)
                state['source_identity'] = measured_source(self.installed)
            return {'ok': True, 'result': {'operation_id': request['operation_id'],
                                         'status': 'running', 'stage': 'checking'}}
        return {'ok': True, 'result': {**state, **({'operation': self.operations[cid]}
                                                  if cid in self.operations else {})}}


class InstallBoundary:
    def __init__(self, docker):
        self.docker, self.starts, self.failure = docker, 0, False
        self.helpers = {}
        self.on_prepare = lambda: None
        self.before_start = lambda job, phase: None

    def profile(self, job):
        return {'image': job['policy']['images'][0], 'contract': 'synthetic-unit-boundary'}

    def consumer_blocker(self, item, state):
        # Scheduler fixture only: real RuntimeEngine deliberately blocks legacy
        # sources until launch/source/restore evidence exists.
        return None

    @staticmethod
    def candidate(job):
        return {'version': job['version'], 'integrity': job['release']['integrity'],
                'tree_sha256': 'a' * 64, 'previous_target': '../old', 'previous_identity': 'b' * 64}

    @staticmethod
    def evidence(job):
        return {'candidate_hash': digest(job['candidate']), 'release_hash': digest(job['release']),
                'profile_hash': digest(job['profile']), 'node': '24.21.0',
                'checks': {key: True for key in CHECKS}}

    def consumers(self, *, timeout=3):
        return [{'Id': cid} for cid in self.docker.items]

    def create(self, job, phase):
        key = (digest({'job':job['id'],'phase':phase}) if phase.startswith('source-') else
               {'prepare': 'f', 'validate': 'b', 'activate': 'a'}[phase] * 64)
        self.helpers.setdefault(key, {'State': {'Status': 'created', 'Running': False}, 'phase': phase})
        return key

    def start(self, job, phase=None):
        if phase is None:  # Existing implementation, before the regression fixes.
            self.starts += 1
            return 'f' * 64
        self.before_start(job, phase)
        key = job['helpers'][phase]['id']
        self.helpers[key]['State'].update(Status='exited', Running=False)
        if phase == 'prepare':
            self.starts += 1
            self.on_prepare()
        elif phase == 'activate':
            self.docker.installed = job['version']
        return key

    def poll(self, job, phase=None):
        if self.failure and not (phase and phase.startswith('source-')):
            return {'state': 'failed', 'stage': 'install_failed'}
        if phase is not None and job['helpers'][phase]['id'] not in self.helpers:
            return {'state': 'unknown'}
        if phase and phase.startswith('source-'):
            return {'state':'succeeded','evidence':{'ok':True,
                'source_hash':phase[7:],'profile_hash':digest(job['profile']),'node':'24.21.0',
                'checks':{name:True for name in CHECKS}}}
        if phase == 'prepare':
            return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                    'candidate': self.candidate(job)}
        if phase == 'validate':
            return {'state': 'succeeded', 'version': job['version'], 'changed': False,
                    'evidence': self.evidence(job)}
        if phase is None:
            self.on_prepare()
            self.docker.installed = job['version']
        return {'state': 'succeeded', 'version': job['version'], 'changed': True}

    def quiescent(self, job):
        if any(item['State']['Running'] for item in self.helpers.values()):
            raise RuntimeError('live helper')


class RuntimeUpdatesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.gate.close())
        self.docker = DockerBoundary()
        self.install = InstallBoundary(self.docker)
        # This suite tests scheduling/durable authorization, not restoration.
        # Real restore behavior is independently tested against actual Pi in
        # the isolated Docker acceptance suite; this external boundary is fake.
        def restored(life, job, item, state, outer):
            return life._update(job['id'], restore_proof={'synthetic_scheduler_fixture': True})
        boundary = patch('gate.runtime_restore.prepare_refresh', side_effect=restored)
        boundary.start()
        self.addCleanup(boundary.stop)

    def manager(self, mode='auto'):
        self.assertTrue(hasattr(self.gate, 'runtime_updates'), 'global runtime update API is missing')
        manager = self.gate.runtime_updates
        manager.catalog = RuntimeCatalog(fetch=lambda url: release(url.rsplit('/', 1)[-1]))
        self.gate.lifecycle.engine = self.docker
        manager.runtime_engine = self.install
        if mode is not None:
            manager.set_policy({'mode': mode, 'images': [IMAGE]})
        return manager

    def pump(self, count=16):
        for _ in range(count):
            self.gate.tick()
            if self.gate.worker:
                self.gate.worker.join(3)
                self.assertFalse(self.gate.worker.is_alive())

    def test_global_rollout_refreshes_idle_and_waits_for_generating_session(self):
        m = self.manager()
        busy = self.docker.states['2' * 64]
        busy.update(idle=False, busy=True)
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        self.assertEqual(self.docker.states['1' * 64]['version'], '1.3.0')
        self.assertEqual(busy['version'], '1.1.0')
        self.assertEqual(self.docker.restarts, ['1' * 64])
        job = m.get(KEY)
        self.assertEqual(job['status'], 'running')
        self.assertIn('waiting_for_idle', [t['status'] for t in job['targets']])
        busy.update(idle=True, busy=False, leaf_id='leaf-after-generation')
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'succeeded')
        self.assertEqual(busy['version'], '1.3.0')
        self.assertEqual(busy['leaf_id'], 'leaf-after-generation')
        self.assertEqual(self.install.starts, 1)

    def test_default_disabled_and_exact_version_only(self):
        m = self.manager(None)
        with self.assertRaises(RuntimeError):
            m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        m = self.manager()
        for version in ('latest', '01.3.0', '1.4', '1.3.0;id', 'https://example.org/p.tgz'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                m.submit({'version': version, 'idempotency_key': KEY})
        self.assertEqual(self.install.starts, 0)

    def test_manual_approval_and_duplicate_submission(self):
        m = self.manager('manual')
        body = {'version': '1.3.0', 'idempotency_key': KEY}
        self.assertEqual(m.submit(body)['status'], 'pending')
        self.pump(2)
        self.assertEqual(self.install.starts, 0)
        self.assertEqual(m.submit(body)['id'], KEY)
        with self.assertRaises(RuntimeError):
            m.submit({'version': '1.1.0', 'idempotency_key': KEY})
        m.approve(KEY)
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'succeeded')

    def test_failed_install_does_not_restart_any_session(self):
        m = self.manager()
        self.install.failure = True
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'failed')
        self.assertEqual(self.docker.restarts, [])
        self.assertEqual(self.docker.installed, '1.1.0')

    def test_all_runtime_consumers_must_be_managed_before_install(self):
        m = self.manager()
        self.docker.items['2' * 64]['Config']['Labels'] = {}
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        self.assertEqual(self.install.starts, 0)
        self.assertNotEqual(m.get(KEY)['status'], 'succeeded')

    def test_install_is_not_repeated_while_pending_queue_drains(self):
        m = self.manager()
        busy = self.docker.states['2' * 64]
        busy.update(idle=False, pending=True)
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        # Re-create the service on the same durable SQLite ledger.
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        m = self.manager(None)
        busy.update(idle=True, pending=False)
        self.pump()
        self.assertEqual(self.install.starts, 1)
        self.assertEqual(m.get(KEY)['status'], 'succeeded')

    def test_same_version_sessions_need_no_restart(self):
        m = self.manager()
        m.submit({'version': '1.1.0', 'idempotency_key': KEY})
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'succeeded')
        self.assertEqual(self.docker.restarts, [])

    def test_outstanding_update_blocks_gate_upgrade(self):
        m = self.manager('manual')
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        with self.assertRaises(RuntimeError):
            self.gate.reserve_upgrade(IMAGE)

    def test_generation_start_race_defers_without_stopping_and_retries_when_idle(self):
        m = self.manager()
        raced = self.docker.states['1' * 64]
        def race(cid):
            if cid == '1' * 64:
                raced.update(idle=False, busy=True)
        self.docker.before_restart = race
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        self.assertEqual(raced['version'], '1.1.0')
        self.assertEqual(m.get(KEY)['status'], 'running')
        self.docker.before_restart = lambda cid: None
        raced.update(idle=True, busy=False, leaf_id='new-leaf')
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'succeeded')
        self.assertEqual(raced['leaf_id'], 'new-leaf')

    def test_exited_waiting_session_does_not_block_remaining_rollout(self):
        m = self.manager()
        self.docker.states['2' * 64].update(idle=False, busy=True)
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        self.pump()
        self.docker.items.pop('2' * 64)
        self.docker.states.pop('2' * 64)
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'succeeded')
        self.assertIn('exited', [t['status'] for t in m.get(KEY)['targets']])

    def test_changed_policy_fences_queued_installation(self):
        m = self.manager()
        m.submit({'version': '1.3.0', 'idempotency_key': KEY})
        m.set_policy({'mode': 'manual', 'images': [IMAGE]})
        self.pump()
        self.assertEqual(m.get(KEY)['status'], 'stale')
        self.assertEqual(self.install.starts, 0)


if __name__ == '__main__':
    unittest.main()

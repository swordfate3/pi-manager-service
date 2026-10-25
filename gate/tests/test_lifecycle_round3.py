"""Mount-order false drift: real lifecycle/ledger with a fake inspect boundary."""
import copy
import itertools
from pathlib import Path
import tempfile
import time
import unittest

from gate.lifecycle import Lifecycle
from test_lifecycle import Gate
from test_lifecycle import BODY, CID, IMAGE, KEY, RUN, FakeEngine
from test_lifecycle_round1 import GateContext


def inspected_engine():
    engine = FakeEngine()
    engine.item['Mounts'] = [
        {'Type': 'bind', 'Source': '/home/fate/project', 'Destination': '/workspace',
         'Mode': 'rw', 'RW': True, 'Propagation': 'rprivate'},
        {'Type': 'bind', 'Source': '/home/fate/session.json',
         'Destination': '/run/secrets/pi-web-session.json',
         'Mode': 'ro', 'RW': False, 'Propagation': 'rprivate'},
    ]
    return engine


class MountOrderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = inspected_engine()
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(lambda: self.gate.close())
        self.gate.lifecycle.engine = self.engine
        self.gate.lifecycle.set_policy({'mode': 'auto', 'images': [IMAGE]})

    def finish(self):
        self.gate.tick()
        if self.gate.worker:
            self.gate.worker.join(3)
            self.assertFalse(self.gate.worker.is_alive())

    def test_alternating_order_across_admission_preflight_and_poll_succeeds_once(self):
        original = self.engine.inspect
        inspections = []
        def inspect(identifier, timeout=None):
            value = original(identifier, timeout)
            if len(inspections) % 2:
                value['Mounts'].reverse()
            inspections.append(copy.deepcopy(value))
            return value
        self.engine.inspect = inspect
        self.gate.lifecycle.submit(BODY)
        self.finish()
        self.assertEqual(self.gate.lifecycle.get(KEY)['status'], 'succeeded')
        self.assertEqual(len(inspections), 7)  # Includes three source-evidence authorization fences.
        self.assertEqual(sum(c['action'] == 'restart' for c in self.engine.calls), 1)

    def test_mount_order_change_only_after_restart_is_not_unknown(self):
        self.gate.lifecycle.submit(BODY)
        self.engine.before_restart = lambda: self.engine.item['Mounts'].reverse()
        self.finish()
        self.assertEqual(self.gate.lifecycle.get(KEY)['status'], 'succeeded')
        self.assertEqual(sum(c['action'] == 'restart' for c in self.engine.calls), 1)

    def test_reopen_with_reordered_mounts_only_polls_same_operation(self):
        life = self.gate.lifecycle
        life.submit(BODY)
        started = int(time.time() * 1000)
        life._update(KEY, status='running', stage='restart_intent', started_at=started, intent_at=started)
        self.engine.operation = dict(operation_id=KEY, status='succeeded', stage='complete',
                                     old_runtime_id='runtime-old', new_runtime_id='runtime-new',
                                     session_id='session', leaf_id=None, old_version='1.0.0',
                                     expected_version='2.0.0', new_version='2.0.0')
        self.engine.snapshot.update(runtime_id='runtime-new', version='2.0.0')
        self.engine.item['Mounts'].reverse()
        self.gate.close()
        self.gate = Gate(Path(self.tmp.name))
        self.gate.lifecycle.engine = self.engine
        self.gate.lifecycle.recover()
        self.finish()
        self.assertEqual(self.gate.lifecycle.get(KEY)['status'], 'succeeded')
        self.assertEqual(self.gate.lifecycle.get(KEY)['started_at'], started)
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

    def test_multiset_permutations_preserve_duplicates_and_do_not_mutate_input(self):
        item = self.engine.item
        item['Mounts'].append(copy.deepcopy(item['Mounts'][0]))
        # Sorting only by destination would leave same-destination entries unstable.
        item['Mounts'].append({**item['Mounts'][0], 'Source': '/home/fate/other-project'})
        baseline = copy.deepcopy(item)
        digest = Lifecycle._target_hash(item)
        self.assertEqual(item, baseline)
        for mounts in itertools.permutations(baseline['Mounts']):
            with self.subTest(order=[m['Destination'] for m in mounts]):
                candidate = {**baseline, 'Mounts': list(copy.deepcopy(mounts))}
                before = copy.deepcopy(candidate)
                self.assertEqual(Lifecycle._target_hash(candidate), digest)
                self.assertEqual(candidate, before)
        self.assertNotEqual(Lifecycle._target_hash({**baseline, 'Mounts': baseline['Mounts'][:2]}), digest)
        self.assertNotEqual(Lifecycle._target_hash({**baseline, 'Mounts': baseline['Mounts'] + [baseline['Mounts'][0]]}), digest)

    def test_every_mount_field_and_entry_remains_in_fingerprint(self):
        item = copy.deepcopy(self.engine.item)
        item['Mounts'][0].update(Name='provenance', Driver='local',
                                  Options={'custom': ['first', 'second']}, FutureField={'x': 1})
        digest = Lifecycle._target_hash(item)
        for field in item['Mounts'][0]:
            with self.subTest(field=field):
                changed = copy.deepcopy(item)
                changed['Mounts'][0].pop(field)
                self.assertNotEqual(Lifecycle._target_hash(changed), digest)
        changed = copy.deepcopy(item)
        changed['Mounts'][0]['Options']['custom'].reverse()
        self.assertNotEqual(Lifecycle._target_hash(changed), digest)  # no recursive array sorting
        changed = copy.deepcopy(item)
        changed['Mounts'][0]['FutureField']['x'] = 2
        self.assertNotEqual(Lifecycle._target_hash(changed), digest)

    def test_real_mount_changes_before_and_after_restart_still_fail_closed(self):
        changes = ({'RW': False}, {'Source': '/home/fate/another-project'},
                   {'Destination': '/workspace/.pi-attachments'}, {'Options': {'custom': 'changed'}})
        for phase, change in itertools.product(('preflight', 'poll'), changes):
            with self.subTest(phase=phase, change=change), tempfile.TemporaryDirectory() as directory:
                engine = inspected_engine()
                with GateContext(Path(directory), engine) as gate:
                    gate.lifecycle.submit(BODY)
                    def drift():
                        engine.item['Mounts'][0].update(change)
                        engine.item['Mounts'].reverse()
                    if phase == 'preflight':
                        drift()
                    else:
                        engine.before_restart = drift
                    gate.tick()
                    if gate.worker:
                        gate.worker.join(3)
                        self.assertFalse(gate.worker.is_alive())
                    self.assertEqual(gate.lifecycle.get(KEY)['status'],
                                     'stale' if phase == 'preflight' else 'recovery_required')
                    self.assertEqual(sum(c['action'] == 'restart' for c in engine.calls),
                                     0 if phase == 'preflight' else 1)

    def test_env_and_argv_order_still_fence_execution(self):
        life = self.gate.lifecycle
        self.engine.item['Config'].update(Env=['EXAMPLE=one', 'EXAMPLE=two'], Cmd=['first', 'second'])
        original = copy.deepcopy(self.engine.item)
        digest = life._target_hash(original)
        for field in ('Env', 'Cmd'):
            with self.subTest(field=field):
                self.engine.item = copy.deepcopy(original)
                self.engine.item['Config'][field].reverse()
                with self.assertRaisesRegex(RuntimeError, 'target changed'):
                    life._resolve(RUN, life.policy(), CID, expected_hash=digest)

    def test_order_cannot_hide_untrusted_mount(self):
        self.gate.lifecycle.submit(BODY)
        self.engine.item['Mounts'][1]['Destination'] = '/usr/local/bin'
        self.engine.item['Mounts'].reverse()
        self.finish()
        self.assertEqual(self.gate.lifecycle.get(KEY)['status'], 'stale')
        self.assertFalse(any(c['action'] == 'restart' for c in self.engine.calls))

"""Private restore handshake never signals the original on missing/stale proof."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


class RestoreControl(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).parents[2] / 'runtime/pi_supervisor.py'
        spec = importlib.util.spec_from_file_location('restore_supervisor', source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'private').mkdir(mode=0o700)
        self.session = self.root / 'saved.jsonl'
        self.session.write_text(json.dumps({'type':'session','version':3,'id':'session', 'cwd':str(self.root)})+'\n')
        with patch.dict(os.environ, {'PI_RUNTIME_RUN_ID':'a'*32, 'PI_RUNTIME_DIR':str(self.root/'private')}):
            self.supervisor = self.module.PiSupervisor(['/usr/local/bin/pi'], 1, 1)
        self.snapshot = {'run_id':'a'*32,'runtime_id':'runtime','session_id':'session','leaf_id':None,
            'session_file':str(self.session),'cwd':str(self.root),'version':'1.3.0',
            'idle':True,'pending':False,'busy':False,'provider':'faux','model':'faux-1','thinking':'medium'}
        self.supervisor.snapshot = lambda: copy.deepcopy(self.snapshot)
        self.supervisor.extension_request = lambda request: copy.deepcopy(self.snapshot)
        self.supervisor.child = Mock()
        self.supervisor.child.poll.return_value = None
        self.request = {**{key:self.snapshot[key] for key in ('run_id','runtime_id','session_id','leaf_id')},
                        'action':'prepare_restore','operation_id':'b'*32}
        self.addCleanup(lambda: self.supervisor.cancel_restore('b'*32)
                        if hasattr(self.supervisor, 'cancel_restore') else None)

    def test_prepare_is_idempotent_and_only_exports_descriptor_not_history(self):
        self.assertTrue(callable(getattr(self.supervisor, 'prepare_restore', None)))
        first = self.supervisor.prepare_restore(self.request)
        second = self.supervisor.prepare_restore(self.request)
        self.assertEqual(first, second)
        self.assertEqual(first['contract'], 'pi-runtime-restore-v1')
        self.assertEqual(first['operation_id'], 'b'*32)
        self.assertEqual(len(list((self.root/'private').iterdir())), 1)
        self.supervisor.child.send_signal.assert_not_called()

    def test_changed_or_busy_snapshot_refuses_capture_without_stopping(self):
        self.assertTrue(callable(getattr(self.supervisor, 'prepare_restore', None)))
        for changes in ({'leaf_id':'other'}, {'pending':True}, {'idle':False}):
            original = copy.deepcopy(self.snapshot)
            self.snapshot.update(changes)
            with self.assertRaises(self.module.ProtocolError):
                self.supervisor.prepare_restore(self.request)
            self.snapshot = original
        self.supervisor.child.send_signal.assert_not_called()
        self.assertEqual(list((self.root/'private').iterdir()), [])

    def test_different_operation_cannot_steal_or_cancel_the_frozen_capture(self):
        self.assertTrue(callable(getattr(self.supervisor, 'prepare_restore', None)))
        self.supervisor.prepare_restore(self.request)
        with self.assertRaises(self.module.ProtocolError):
            self.supervisor.prepare_restore({**self.request,'operation_id':'c'*32})
        with self.assertRaises(self.module.ProtocolError):
            self.supervisor.cancel_restore('c'*32)
        self.assertEqual(len(list((self.root/'private').iterdir())), 1)

    def test_version_change_without_restore_proof_is_rejected_before_any_signal(self):
        self.supervisor.installed_version = lambda:'1.4.0'
        request = {**self.request,'action':'restart'}
        with self.assertRaises(self.module.ProtocolError):
            self.supervisor.check_restart(request)
        self.supervisor.child.send_signal.assert_not_called()

    def test_finished_or_rejected_restart_releases_the_private_capture(self):
        self.supervisor.prepare_restore(self.request)
        self.supervisor.operation = {'operation_id':'b'*32,'status':'running','stage':'checking'}
        self.supervisor.finish_operation('failed', 'checking_rejected')
        self.assertIsNone(self.supervisor.restore_capture)
        self.assertEqual(list((self.root/'private').iterdir()), [])

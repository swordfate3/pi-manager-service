"""Pre-stop captures preserve exact bytes and refuse any stale source session."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


class SessionCaptureTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).parents[2] / 'runtime/runtime_session.py'
        self.assertTrue(source.is_file(), 'image-owned pre-stop session capture is missing')
        spec = importlib.util.spec_from_file_location('runtime_session_capture', source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.file = self.root / 'original.jsonl'
        self.bytes = (json.dumps({'type': 'session', 'version': 3, 'id': 'saved-session',
                                 'cwd': str(self.root)}) + '\n' +
                      json.dumps({'type': 'message', 'id': 'leaf-a', 'parentId': None,
                                  'message': {'role': 'user', 'content': 'PRIVATE SAVED PROMPT'}}) + '\n').encode()
        self.file.write_bytes(self.bytes)
        self.snapshot = {'run_id': 'a' * 32, 'runtime_id': 'runtime-a', 'session_id': 'saved-session',
            'leaf_id': 'leaf-a', 'session_file': str(self.file), 'cwd': str(self.root),
            'version': '1.3.0', 'idle': True, 'pending': False, 'busy': False,
            'provider': 'faux', 'model': 'faux-1', 'thinking': 'medium'}
        self.runtime = self.root / 'private-runtime'
        self.runtime.mkdir(mode=0o700)

    def test_capture_produces_only_a_private_exact_copy_and_bounded_descriptor(self):
        capture = self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32)
        descriptor = capture.descriptor()
        self.assertEqual(self.file.read_bytes(), self.bytes)
        self.assertEqual(capture.path.read_bytes(), self.bytes)
        self.assertEqual(capture.path.stat().st_mode & 0o077, 0)
        self.assertEqual(descriptor['bytes'], len(self.bytes))
        self.assertEqual(descriptor['session_format'], 3)
        self.assertEqual(descriptor['operation_id'], 'b' * 32)
        self.assertNotIn('PRIVATE SAVED PROMPT', json.dumps(descriptor))
        capture.verify(self.snapshot)
        capture.close()
        self.assertFalse(capture.path.exists())
        self.assertEqual(self.file.read_bytes(), self.bytes)

    def test_changed_leaf_model_or_source_bytes_block_before_stop(self):
        capture = self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32)
        for field, changed in (('leaf_id', 'leaf-b'), ('runtime_id', 'new-child'),
                               ('model', 'other-model'), ('thinking', 'high'), ('idle', False)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                capture.verify({**self.snapshot, field: changed})
        self.file.write_bytes(self.bytes + b'{}\n')
        with self.assertRaises(ValueError):
            capture.verify(self.snapshot)
        capture.close()

    def test_expired_capture_cannot_authorize_a_delayed_stop(self):
        now = [100.0]
        capture = self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32,
                                             clock=lambda: now[0])
        now[0] += 151
        with self.assertRaises(ValueError):
            capture.verify(self.snapshot)
        capture.close()

    def test_unknown_mismatching_and_oversized_sources_have_no_usable_capture(self):
        for data in (b'not json\n', b'[]\n',
                     json.dumps({'type':'session','version':3,'id':'other','cwd':str(self.root)}).encode()):
            with self.subTest(data=data):
                self.file.write_bytes(data)
                with self.assertRaises(ValueError):
                    self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32)
                self.assertEqual(list(self.runtime.iterdir()), [])
        self.file.write_bytes(self.bytes)
        with self.assertRaises(ValueError):
            self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32, limit=10)
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_symlinked_or_replaced_original_is_not_accepted(self):
        real = self.root / 'real.jsonl'
        self.file.rename(real)
        self.file.symlink_to(real)
        with self.assertRaises(ValueError):
            self.module.SessionCapture(self.runtime, self.snapshot, 'b' * 32)
        self.assertEqual(list(self.runtime.iterdir()), [])

"""Repeat-up regression: real Gate ledger/finish, fake external operations only."""
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_lifecycle import Gate
from test_lifecycle import BODY, IMAGE, FakeEngine


class RepeatUpgradeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gate = Gate(Path(self.tmp.name))
        self.addCleanup(lambda: self.gate.close())
        self.gate.lifecycle.set_policy({'mode': 'auto', 'images': [IMAGE]})
        self.gate.lifecycle.engine = FakeEngine()
        self.image = IMAGE
        self.composing = False
        self.commands = []
        self.main = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'gatectl'))['main']
        self.main.__globals__.update(docker=self.docker, admin=self.admin,
                                    verified_image=lambda *args: IMAGE)

    def docker(self, *args, **kwargs):
        if args[0] == 'ps':
            return b'existing-gate'
        self.assertEqual(args[0], 'inspect')
        return json.dumps([{'State': {'Running': True}, 'Image': self.image}]).encode()

    def admin(self, command, *args, **kwargs):
        self.commands.append(command)
        if command == 'status':
            return {'requests': [], 'active': [], 'lifecycle_active': self.gate.lifecycle.active()}
        if command == 'upgrade-reserve':
            return self.gate.reserve_upgrade(kwargs['payload']['image'])
        if command == 'upgrade-status':
            return self.gate.upgrade_status()
        if command == 'upgrade-finish':
            self.assertFalse(self.composing, 'admission must remain closed until Compose returns')
            return self.gate.release_upgrade(kwargs['payload']['id'], 'finish')
        self.fail('unexpected command (no automatic abort/fallback allowed): ' + command)

    def assert_fenced(self):
        self.assertIsNotNone(self.gate.store.upgrade_reservation())
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': '1' * 40})
        with self.assertRaises(RuntimeError):
            self.gate.lifecycle.submit(BODY)
        self.gate.tick()
        self.assertIsNone(self.gate.worker)

    def compose(self, argv, check, *, ignore_recreate=False, lose_reply=False):
        self.assertTrue(check)
        self.assertEqual(argv[:2], ['docker', 'compose'])
        self.assertEqual(argv[-1], 'gate')
        self.assertIn('--no-build', argv)
        self.assertEqual(argv[argv.index('--pull') + 1], 'never')
        override = argv[argv.index('up') - 1]
        self.assertEqual(json.loads(Path(override).read_text()), {'services': {'gate': {'image': IMAGE}}})
        self.composing = True
        self.assert_fenced()
        # A converged same-image/config service remains the SAME process unless
        # recreation is requested. This reproduces the previous CLI behavior.
        if '--force-recreate' in argv and not ignore_recreate:
            self.gate.close()
            self.gate = Gate(Path(self.tmp.name))
            self.gate.lifecycle.engine = FakeEngine()
            self.assert_fenced()
        self.composing = False
        if lose_reply:
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)

    def invoke(self, compose=None):
        with mock.patch.object(sys, 'argv', ['gatectl', 'up']), mock.patch(
                'subprocess.run', side_effect=compose or self.compose):
            self.main()

    def test_repeat_same_image_up_recreates_and_releases_only_after_settlement(self):
        for _ in range(2):
            previous_instance = self.gate.instance_id
            try:
                self.invoke()
            except RuntimeError as error:
                self.fail('repeat up must replace rather than leave a no-op reservation: ' + str(error))
            self.assertNotEqual(self.gate.instance_id, previous_instance)
            self.assertIsNone(self.gate.store.upgrade_reservation())
            self.assertEqual(self.gate.store.events()[0]['action'], 'upgrade_finished')
        # Both admissions become usable after verified completion, not earlier.
        self.assertEqual(self.gate.submit({'commit': '1' * 40})['status'], 'pending')
        self.assertEqual(self.gate.lifecycle.submit(BODY)['status'], 'queued')

    def test_successful_compose_retaining_same_instance_does_not_release(self):
        instance = self.gate.instance_id
        with self.assertRaisesRegex(RuntimeError, 'replacement instance'):
            self.invoke(lambda *a, **k: self.compose(*a, **k, ignore_recreate=True))
        self.assertEqual(self.gate.instance_id, instance)
        self.assert_fenced()

    def test_wrong_running_image_cannot_release_even_after_recreation(self):
        def wrong_image(*args, **kwargs):
            result = self.compose(*args, **kwargs)
            self.image = 'sha256:' + 'e' * 64
            return result
        with self.assertRaisesRegex(RuntimeError, 'replacement image'):
            self.invoke(wrong_image)
        self.assertNotIn('upgrade-finish', self.commands)
        self.assert_fenced()

    def test_lost_compose_reply_retains_reservation_even_if_gate_changed(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(lambda *a, **k: self.compose(*a, **k, lose_reply=True))
        self.assertNotIn('upgrade-finish', self.commands)
        self.assert_fenced()

    def test_unavailable_new_admin_keeps_reservation_after_compose_success(self):
        def admin(command, *args, **kwargs):
            if command == 'upgrade-status':
                raise RuntimeError('new private endpoint not ready')
            return self.admin(command, *args, **kwargs)
        self.main.__globals__['admin'] = admin
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            self.invoke()
        self.assertNotIn('upgrade-finish', self.commands)
        self.assert_fenced()

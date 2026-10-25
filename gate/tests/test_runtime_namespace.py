"""Trusted bootstrap can isolate test volumes; requests cannot select authority."""
import tempfile
from pathlib import Path
import unittest

from gate.runtime_engine import RuntimeEngine
from gate.service import Gate


class NamespaceTest(unittest.TestCase):
    def test_only_explicit_test_namespace_can_override_the_production_volume(self):
        image = 'sha256:' + 'a' * 64
        task = {'id': 'b' * 32, 'version': '1.4.0', 'policy': {'images': [image]}}
        volume = 'pi-runtime-update-test-' + 'c' * 12
        engine = RuntimeEngine(object(), volume=volume)
        mounts = engine.definition(task, 'prepare')['HostConfig']['Mounts']
        self.assertEqual([m['Source'] for m in mounts], [volume])
        self.assertNotIn('pi-runtime', [m['Source'] for m in mounts])
        for invalid in ('pi-home', 'pi-runtime-evil', '/var/lib/docker', '', 'pi-runtime-update-test-'):
            with self.subTest(volume=invalid), self.assertRaises(ValueError):
                RuntimeEngine(object(), volume=invalid)

    def test_gate_volume_override_is_a_trusted_constructor_argument_only(self):
        volume = 'pi-runtime-update-test-' + 'c' * 12
        with tempfile.TemporaryDirectory() as directory:
            gate = Gate(Path(directory), runtime_volume=volume)
            try:
                self.assertEqual(gate.runtime_volume, volume)
                with self.assertRaises(ValueError):
                    gate.runtime_updates.submit({'version': '1.4.0', 'idempotency_key': 'a' * 32,
                                                  'runtime_volume': 'pi-runtime'})
            finally:
                gate.close()


if __name__ == '__main__':
    unittest.main()

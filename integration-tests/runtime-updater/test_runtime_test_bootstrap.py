"""The acceptance bootstrap must fail closed before resource-capable construction."""
from pathlib import Path
import tempfile
import unittest

from runtime_test_bootstrap import create_runtime_test_components
import runtime_test_bootstrap as bootstrap


class RecordingEngine:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            raise AssertionError('invalid bootstrap reached the resource engine')
        return record


class RuntimeTestBootstrapTest(unittest.TestCase):
    def test_test_engine_inspects_only_its_exact_isolated_volume(self):
        cls = getattr(bootstrap, 'RuntimeTestEngine', None)
        self.assertIsNotNone(cls, 'real Docker bootstrap lacks a namespace-bound volume inspector')
        volume = 'pi-runtime-update-test-' + 'd' * 12
        engine = cls(runtime_volume=volume)
        calls = []
        def call(method, path, **kwargs):
            calls.append((method, path, kwargs))
            return {'Name': volume, 'Driver': 'local'}
        engine.call = call
        self.assertEqual(engine.lifecycle_volume(volume)['Name'], volume)
        self.assertEqual(calls[0][:2], ('GET', '/volumes/' + volume))
        for refused in ('pi-runtime', 'pi-home', 'pi-runtime-update-test-' + 'e' * 12):
            with self.assertRaises(ValueError):
                engine.lifecycle_volume(refused)
        self.assertEqual(len(calls), 1, 'other volumes must not reach Docker')

    def test_omitted_default_and_malformed_volumes_make_zero_resource_calls(self):
        invalid = (None, 'pi-runtime', 'pi-home', 'pi-runtime-update-test-',
                   'pi-runtime-update-test-' + 'a' * 11,
                   'pi-runtime-update-test-' + 'a' * 33,
                   'pi-runtime-update-test-' + 'A' * 12,
                   '/var/lib/docker/volumes/pi-runtime/_data')
        for volume in invalid:
            with self.subTest(volume=volume):
                constructors = []
                engine = RecordingEngine()

                def gate_factory(*args, **kwargs):
                    constructors.append(('gate', args, kwargs))
                    raise AssertionError('invalid bootstrap constructed Gate')

                def runtime_engine_factory(*args, **kwargs):
                    constructors.append(('runtime_engine', args, kwargs))
                    raise AssertionError('invalid bootstrap constructed RuntimeEngine')

                with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                    arguments = dict(directory=Path(directory), engine=engine,
                                     gate_factory=gate_factory,
                                     runtime_engine_factory=runtime_engine_factory)
                    if volume is None:
                        create_runtime_test_components(**arguments)
                    else:
                        create_runtime_test_components(runtime_volume=volume, **arguments)
                self.assertEqual(constructors, [])
                self.assertEqual(engine.calls, [])

    def test_explicit_test_volume_is_validated_before_both_factories(self):
        volume = 'pi-runtime-update-test-' + 'c' * 12
        calls = []
        gate_result, runtime_engine_result = object(), object()

        def gate_factory(directory, *, runtime_volume):
            calls.append(('gate', directory, runtime_volume))
            return gate_result

        def runtime_engine_factory(engine, *, volume):
            calls.append(('runtime_engine', engine, volume))
            return runtime_engine_result

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            engine = RecordingEngine()
            result = create_runtime_test_components(
                path, engine, runtime_volume=volume,
                gate_factory=gate_factory, runtime_engine_factory=runtime_engine_factory)
        self.assertEqual(result.gate, gate_result)
        self.assertEqual(result.runtime_engine, runtime_engine_result)
        self.assertEqual(calls, [('gate', path, volume), ('runtime_engine', engine, volume)])
        self.assertEqual(engine.calls, [])


if __name__ == '__main__':
    unittest.main()

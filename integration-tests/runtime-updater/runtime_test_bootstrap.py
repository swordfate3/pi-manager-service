"""Fail-closed bootstrap for future isolated runtime acceptance tests only."""
import re
from typing import NamedTuple

from gate.engine import Engine
from gate.runtime_engine import RuntimeEngine, runtime_volume as validate_runtime_volume
from gate.service import Gate


TEST_RUNTIME_VOLUME = re.compile(r'pi-runtime-update-test-[0-9a-f]{12,32}\Z')


class RuntimeTestComponents(NamedTuple):
    gate: object
    runtime_engine: object


def _test_runtime_volume(value):
    if not isinstance(value, str) or TEST_RUNTIME_VOLUME.fullmatch(value) is None:
        raise ValueError('an explicit isolated test runtime volume is required')
    return validate_runtime_volume(value)


class RuntimeTestEngine(Engine):
    """Test-only daemon adapter: production volume lookups are never allowed."""
    def __init__(self, *, runtime_volume, path='/var/run/docker.sock'):
        self.test_volume = _test_runtime_volume(runtime_volume)
        super().__init__(path=path)

    def lifecycle_volume(self, name, timeout=3):
        if name != self.test_volume:
            raise ValueError('volume is outside this isolated test namespace')
        return self.call('GET', '/volumes/' + name, missing=True, timeout=timeout, limit=16384)


def create_runtime_test_components(directory, engine, *, runtime_volume=None,
                                   gate_factory=Gate, runtime_engine_factory=RuntimeEngine):
    """Validate isolation before constructing Gate/RuntimeEngine or touching the engine."""
    volume = _test_runtime_volume(runtime_volume)
    gate = gate_factory(directory, runtime_volume=volume)
    try:
        runtime_engine = runtime_engine_factory(engine, volume=volume)
    except Exception:
        close = getattr(gate, 'close', None)
        if callable(close):
            close()
        raise
    return RuntimeTestComponents(gate=gate, runtime_engine=runtime_engine)

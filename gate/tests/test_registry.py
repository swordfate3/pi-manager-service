import copy
import concurrent.futures
import json
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path

from gate.registry import fingerprint, service_public, validate_service
from gate.store import Store, public


SHA = '1' * 40
DIGEST = 'a' * 64


class CoordinatedCursor:
    """Test-only cursor that aligns two connections after a real SQLite read."""
    def __init__(self, cursor, owner):
        self.cursor = cursor
        self.owner = owner

    def _wait_if_unreserved(self):
        self.owner.wait_if_unreserved()

    def fetchone(self):
        value = self.cursor.fetchone()
        self._wait_if_unreserved()
        return value

    def fetchall(self):
        value = self.cursor.fetchall()
        self._wait_if_unreserved()
        return value

    def __iter__(self):
        value = list(self.cursor)
        self._wait_if_unreserved()
        return iter(value)

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class CoordinatedConnection:
    """Delegates to SQLite while coordinating one selected read statement."""
    def __init__(self, connection, statement_prefix, barrier):
        self.connection = connection
        self.statement_prefix = statement_prefix
        self.barrier = barrier
        self.waited = False

    def wait_if_unreserved(self):
        if self.waited:
            return
        self.waited = True
        if not self.connection.in_transaction:
            self.barrier.wait(timeout=5)

    def execute(self, statement, parameters=()):
        cursor = self.connection.execute(statement, parameters)
        if statement.startswith(self.statement_prefix):
            return CoordinatedCursor(cursor, self)
        return cursor

    def __getattr__(self, name):
        return getattr(self.connection, name)


def coordinate_read(store, statement_prefix, barrier):
    store.db = CoordinatedConnection(store.db, statement_prefix, barrier)


def concurrent_outcomes(*calls):
    def invoke(call):
        try:
            return 'ok', call()
        except Exception as error:
            return 'error', error

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return [future.result() for future in [pool.submit(invoke, call) for call in calls]]


def image_service(identifier='widget', target='widget', repository='ghcr.io/acme/widget', mode=None):
    value = {
        'id': identifier,
        'target': target,
        'kind': 'image',
        'source': {'repository': repository},
        'policy': {
            'target': target,
            'template': {
                'User': '1000:1000',
                'Entrypoint': ['/app/bin/widget'],
                'Cmd': ['serve'],
                'Env': ['MODE=production'],
                'WorkingDir': '/app',
                'Healthcheck': {
                    'Test': ['CMD', '/app/bin/widget', 'health'],
                    'Interval': 1_000_000_000,
                    'Timeout': 1_000_000_000,
                    'Retries': 3,
                },
                'HostConfig': {
                    'NetworkMode': 'none',
                    'ReadonlyRootfs': True,
                    'CapDrop': ['ALL'],
                    'SecurityOpt': ['no-new-privileges:true'],
                    'Memory': 64 * 1024 * 1024,
                    'NanoCpus': 500_000_000,
                    'PidsLimit': 64,
                    'RestartPolicy': {'Name': 'unless-stopped'},
                    'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777'},
                    'Binds': [
                        'widget-data:/var/lib/widget:rw',
                        'widget-config:/app/config:ro',
                    ],
                    'LogConfig': {
                        'Type': 'json-file',
                        'Config': {'max-size': '10m', 'max-file': '3'},
                    },
                },
            },
            'probe': {'entrypoint': ['/app/bin/widget'], 'cmd': ['health']},
            'health_timeout': 30,
        },
    }
    if mode is not None:
        value['mode'] = mode
    return value


def hub_policy(target='pi-web-hub'):
    return {
        'target': target,
        'base_image': 'sha256:' + DIGEST,
        'private_volume': target + '-private',
        'runtime_volume': target + '-runtime',
        'health_port': 16181,
        'health_timeout': 40,
    }


def hub_service(mode='auto'):
    return {
        'id': 'pi-web-hub',
        'target': 'pi-web-hub',
        'kind': 'hub',
        'source': {'repository': 'swordfate3/pi-web-ui', 'auto_branch': 'main'},
        'mode': mode,
        'policy': hub_policy(),
    }


class RegistryValidationTest(unittest.TestCase):
    def test_image_registration_rejects_all_absolute_host_binds(self):
        for source in ('/srv/widget/config', '/etc/ssl/certs', '/tmp/alias',
                       '/workspace/config', '/tmp/alias/../config'):
            with self.subTest(source=source):
                value = image_service()
                value['policy']['template']['HostConfig']['Binds'][1] = source + ':/app/config:ro'
                with self.assertRaises(ValueError):
                    validate_service(value)

    def test_image_service_defaults_to_manual_without_mutating_input(self):
        original = image_service()
        supplied = copy.deepcopy(original)

        normalized = validate_service(supplied)

        self.assertEqual(normalized['mode'], 'manual')
        self.assertEqual(normalized['source'], {'repository': 'ghcr.io/acme/widget'})
        self.assertEqual(supplied, original)

    def test_fingerprint_is_canonical_sha256(self):
        first = fingerprint({'z': [3, 2, 1], 'a': {'b': True}})
        second = fingerprint({'a': {'b': True}, 'z': [3, 2, 1]})

        self.assertEqual(first, second)
        self.assertRegex(first, re.compile(r'[0-9a-f]{64}\Z'))

    def test_public_service_redacts_policy_template_and_environment(self):
        private = validate_service(image_service())
        private.update(revision=4, policy_hash='b' * 64, paused=True, failures=3)

        value = service_public(private)

        self.assertEqual(set(value), {
            'id', 'target', 'kind', 'source', 'mode', 'revision',
            'policy_hash', 'paused', 'failures',
        })
        self.assertNotIn('MODE=production', repr(value))
        self.assertNotIn('template', repr(value))

    def test_hub_source_and_policy_target_are_fixed(self):
        self.assertEqual(validate_service(hub_service())['kind'], 'hub')
        for mutate in (
            lambda value: value['source'].__setitem__('repository', 'other/repo'),
            lambda value: value['source'].__setitem__('auto_branch', 'release'),
            lambda value: value['policy'].__setitem__('target', 'other-target'),
        ):
            with self.subTest(mutate=mutate):
                value = hub_service()
                mutate(value)
                with self.assertRaises(ValueError):
                    validate_service(value)

    def test_invalid_modes_targets_and_image_repositories_are_rejected(self):
        cases = []
        for mode in ('AUTO', '', True, 'automatic'):
            cases.append(('mode=' + repr(mode), lambda value, mode=mode: value.__setitem__('mode', mode)))
        for target in ('../widget', '/widget', 'widget/name', 'pi-deploy-gate', 'pi-deploy-gate-state'):
            cases.append(('target=' + target, lambda value, target=target: (
                value.__setitem__('target', target), value['policy'].__setitem__('target', target))))
        for repository in (
            'https://ghcr.io/acme/widget', 'ghcr.io/acme/widget:latest',
            'ghcr.io/acme/widget@sha256:' + DIGEST, 'ghcr.io/acme/../widget',
            'GHCR.IO/acme/widget', 'ghcr.io/acme/widget/',
        ):
            cases.append(('repository=' + repository,
                          lambda value, repository=repository: value['source'].__setitem__('repository', repository)))

        for label, mutate in cases:
            with self.subTest(case=label):
                value = image_service()
                mutate(value)
                with self.assertRaises((TypeError, ValueError)):
                    validate_service(value)

    def test_port_binding_host_ip_accepts_only_empty_or_textual_ip_addresses(self):
        for host_ip in ('', '127.0.0.1', '::1', '2001:db8::1'):
            with self.subTest(host_ip=host_ip):
                value = image_service()
                template = value['policy']['template']
                template['ExposedPorts'] = {'8080/tcp': {}}
                template['HostConfig']['PortBindings'] = {
                    '8080/tcp': [{'HostIp': host_ip, 'HostPort': '18080'}],
                }

                normalized = validate_service(value)

                binding = normalized['policy']['template']['HostConfig']['PortBindings']['8080/tcp'][0]
                self.assertEqual(binding['HostIp'], host_ip)

    def test_port_binding_host_ip_rejects_every_non_string_value(self):
        for host_ip in (0, 1, False, True, None, [], {}):
            with self.subTest(host_ip=host_ip):
                value = image_service()
                template = value['policy']['template']
                template['ExposedPorts'] = {'8080/tcp': {}}
                template['HostConfig']['PortBindings'] = {
                    '8080/tcp': [{'HostIp': host_ip, 'HostPort': '18080'}],
                }

                with self.assertRaises(ValueError):
                    validate_service(value)

    def test_log_rotation_size_is_capped_at_256_mib(self):
        allowed = image_service()
        allowed['policy']['template']['HostConfig']['LogConfig']['Config']['max-size'] = '256m'
        self.assertEqual(
            validate_service(allowed)['policy']['template']['HostConfig']['LogConfig']['Config']['max-size'],
            '256m',
        )

        for size in ('257m', '1g', '9999G'):
            with self.subTest(size=size):
                value = image_service()
                value['policy']['template']['HostConfig']['LogConfig']['Config']['max-size'] = size
                with self.assertRaises(ValueError):
                    validate_service(value)


class StoreRegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name))
        self.addCleanup(self.store.close)

    def register_image(self, identifier='widget', target='widget', repository='ghcr.io/acme/widget', mode=None):
        return self.store.register_service(image_service(identifier, target, repository, mode))

    def test_bootstrap_is_idempotent_preserves_admin_mode_and_does_not_enable_legacy_pending(self):
        legacy = self.store.request(SHA)

        created = self.store.bootstrap(hub_policy())
        migrated = self.store.get(legacy['id'])

        self.assertEqual(created['mode'], 'auto')
        self.assertEqual(created['revision'], 1)
        self.assertEqual(migrated['id'], legacy['id'])
        self.assertEqual(migrated['commit'], SHA)
        self.assertEqual(migrated['status'], 'pending')
        self.assertEqual(migrated['service'], 'pi-web-hub')
        self.assertEqual(migrated['approval_mode'], 'manual')
        self.assertFalse(migrated['automatic'])
        self.assertNotIn('snapshot', migrated)

        changed = self.store.set_mode('pi-web-hub', 'manual')
        persisted_policy = copy.deepcopy(changed['policy'])
        repeated = self.store.bootstrap({'target': '../ignored-after-first-bootstrap'})

        self.assertEqual(repeated['mode'], 'manual')
        self.assertEqual(repeated['revision'], changed['revision'])
        self.assertEqual(repeated['policy'], persisted_policy)
        self.assertEqual(self.store.get(legacy['id']), migrated)

    def test_service_settings_and_counters_persist_across_reopen(self):
        directory = Path(self.tmp.name) / 'persistent'
        first = Store(directory)
        try:
            registered = first.register_service(image_service())
            first.set_mode('widget', 'auto')
            first.record_result('widget', False)
            first.record_result('widget', False)
        finally:
            first.close()

        second = Store(directory)
        try:
            restored = second.service('widget')
            self.assertEqual(restored['revision'], registered['revision'] + 1)
            self.assertEqual(restored['mode'], 'auto')
            self.assertEqual(restored['failures'], 2)
            self.assertFalse(restored['paused'])
        finally:
            second.close()

    def test_register_upserts_revision_preserves_failure_state_and_enforces_unique_target(self):
        first = self.register_image()
        for _ in range(3):
            self.store.record_result('widget', False)
        revised = image_service()
        revised['policy']['template']['Env'] = ['MODE=maintenance']

        second = self.store.register_service(revised)

        self.assertEqual(second['revision'], first['revision'] + 1)
        self.assertNotEqual(second['policy_hash'], first['policy_hash'])
        self.assertEqual(second['failures'], 3)
        self.assertTrue(second['paused'])
        with self.assertRaises(ValueError):
            self.store.register_service(image_service('other', 'widget', 'ghcr.io/acme/other'))
        self.assertFalse(self.store.db.in_transaction)
        self.assertEqual([service['id'] for service in self.store.services()], ['widget'])

    def test_two_connections_serialize_service_revisions(self):
        first = self.register_image()
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM services WHERE id=', barrier)
        coordinate_read(other, 'SELECT data FROM services WHERE id=', barrier)
        left = image_service()
        left['policy']['health_timeout'] = 31
        right = image_service()
        right['policy']['health_timeout'] = 32

        outcomes = concurrent_outcomes(
            lambda: self.store.register_service(left),
            lambda: other.register_service(right),
        )

        self.assertEqual([status for status, _ in outcomes], ['ok', 'ok'])
        self.assertEqual(sorted(value['revision'] for _, value in outcomes), [first['revision'] + 1, first['revision'] + 2])
        self.assertEqual(self.store.service('widget')['revision'], first['revision'] + 2)

    def test_two_connections_serialize_failure_counters(self):
        self.register_image()
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM services WHERE id=', barrier)
        coordinate_read(other, 'SELECT data FROM services WHERE id=', barrier)

        outcomes = concurrent_outcomes(
            lambda: self.store.record_result('widget', False),
            lambda: other.record_result('widget', False),
        )

        self.assertEqual([status for status, _ in outcomes], ['ok', 'ok'])
        self.assertEqual(self.store.service('widget')['failures'], 2)

    def test_mode_result_pause_success_and_resume_have_stable_policy_semantics(self):
        original = self.register_image()
        unchanged = self.store.set_mode('widget', 'manual')
        self.assertEqual(unchanged['revision'], original['revision'])
        self.assertEqual(unchanged['policy_hash'], original['policy_hash'])
        self.assertFalse(self.store.db.in_transaction)

        automatic = self.store.set_mode('widget', 'auto')
        self.assertEqual(automatic['revision'], original['revision'] + 1)
        self.assertNotEqual(automatic['policy_hash'], original['policy_hash'])
        stable_hash = automatic['policy_hash']

        self.store.record_result('widget', False)
        self.store.record_result('widget', False)
        reset = self.store.record_result('widget', True)
        self.assertEqual(reset['failures'], 0)
        self.assertFalse(reset['paused'])
        for _ in range(3):
            paused = self.store.record_result('widget', False)
        self.assertEqual(paused['failures'], 3)
        self.assertTrue(paused['paused'])
        self.assertEqual(paused['policy_hash'], stable_hash)

        success_while_paused = self.store.record_result('widget', True)
        self.assertEqual(success_while_paused['failures'], 0)
        self.assertTrue(success_while_paused['paused'])
        resumed = self.store.resume_service('widget')
        self.assertEqual(resumed['failures'], 0)
        self.assertFalse(resumed['paused'])
        self.assertEqual(resumed['policy_hash'], stable_hash)

    def test_management_generation_is_durable_without_changing_execution_policy(self):
        service = self.register_image()
        policy_hash = service['policy_hash']
        last_generation = service.get('management_generation', 0)
        operations = (
            lambda: self.store.record_result('widget', False),
            lambda: self.store.record_result('widget', True),
            lambda: self.store.resume_service('widget'),
        )
        for operation in operations:
            service = operation()
            self.assertGreater(service.get('management_generation', 0), last_generation)
            last_generation = service['management_generation']
            self.assertEqual(service['policy_hash'], policy_hash)
        # Re-registering a trusted definition must not reset its private generation.
        service = self.register_image()
        self.assertGreaterEqual(service['management_generation'], last_generation)
        self.store.close()
        self.store = Store(Path(self.tmp.name))
        self.addCleanup(self.store.close)
        self.assertEqual(self.store.service('widget')['management_generation'], service['management_generation'])

    def test_service_id_is_validated_before_registry_sql(self):
        self.register_image()
        operations = (
            lambda: self.store.service(None),
            lambda: self.store.set_mode([], 'auto'),
            lambda: self.store.resume_service(1),
            lambda: self.store.record_result({'id': 'widget'}, True),
            lambda: self.store.request_version(True, {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}),
            lambda: self.store.audit('resolve', None, request='1' * 32),
        )
        for operation in operations:
            with self.subTest(operation=operation):
                with self.assertRaises((TypeError, ValueError)):
                    operation()

    def test_audit_is_bounded_and_rejects_secret_or_structured_metadata(self):
        self.register_image()
        for number in range(105):
            self.store.audit('inspection', 'widget', sequence=number, request='%032x' % number)

        events = self.store.events()

        self.assertEqual(len(events), 100)
        self.assertEqual(events[0]['metadata']['sequence'], 104)
        self.assertEqual(events[-1]['metadata']['sequence'], 5)
        for metadata in ({'token': 'token=abc'}, {'nested': {'secret': 'value'}}):
            with self.subTest(metadata=metadata):
                with self.assertRaises(ValueError):
                    self.store.audit('unsafe', 'widget', **metadata)


class StoreRequestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name))
        self.addCleanup(self.store.close)
        self.store.register_service(image_service())

    def test_request_snapshot_is_immutable_and_public_view_is_redacted(self):
        version = {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}
        job = self.store.request_version('widget', version)
        version['image'] = 'changed'
        revised = image_service()
        revised['policy']['template']['Env'] = ['PASSWORD=private-but-admin-owned']
        current = self.store.register_service(revised)
        stored = self.store.get(job['id'])

        self.assertEqual(stored['image'], 'ghcr.io/acme/widget@sha256:' + DIGEST)
        self.assertEqual(stored['version'], {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST})
        self.assertEqual(stored['snapshot']['policy']['template']['Env'], ['MODE=production'])
        self.assertNotEqual(stored['policy_hash'], current['policy_hash'])
        self.assertRegex(stored['plan_hash'], re.compile(r'[0-9a-f]{64}\Z'))
        exposed = public(stored)
        self.assertEqual(exposed['service'], 'widget')
        self.assertEqual(exposed['image'], stored['image'])
        self.assertEqual(exposed['plan_hash'], stored['plan_hash'])
        self.assertEqual(exposed['approval_mode'], 'manual')
        self.assertNotIn('snapshot', exposed)
        self.assertNotIn('policy', repr(exposed))
        self.assertNotIn('MODE=production', repr(exposed))

    def test_request_enforces_exact_source_mode_pause_and_version_shape(self):
        invalid = (
            {'image': 'ghcr.io/other/widget@sha256:' + DIGEST},
            {'image': 'ghcr.io/acme/widget:latest'},
            {'image': 'ghcr.io/acme/widget@sha256:' + 'A' * 64},
            {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST, 'snapshot': {}},
        )
        for version in invalid:
            with self.subTest(version=version):
                with self.assertRaises(ValueError):
                    self.store.request_version('widget', version)

        with self.assertRaises(RuntimeError):
            self.store.request_version('widget', {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}, automatic=True)
        self.store.set_mode('widget', 'disabled')
        with self.assertRaises(RuntimeError):
            self.store.request_version('widget', {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST})

        self.store.set_mode('widget', 'auto')
        for _ in range(3):
            self.store.record_result('widget', False)
        with self.assertRaises(RuntimeError):
            self.store.request_version('widget', {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}, automatic=True)
        manual = self.store.request_version('widget', {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST})
        self.assertEqual(manual['status'], 'pending')

    def test_dedup_is_scoped_to_service_version_and_policy_hash(self):
        self.store.register_service(image_service('other', 'other', 'ghcr.io/acme/other'))
        widget_version = {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}
        other_version = {'image': 'ghcr.io/acme/other@sha256:' + DIGEST}

        first = self.store.request_version('widget', widget_version)
        duplicate = self.store.request_version('widget', widget_version)
        other = self.store.request_version('other', other_version)

        self.assertEqual(duplicate['id'], first['id'])
        self.assertFalse(self.store.db.in_transaction)
        self.assertNotEqual(other['id'], first['id'])
        self.store.update(first['id'], status='rejected')
        replacement = self.store.request_version('widget', widget_version)
        self.assertNotEqual(replacement['id'], first['id'])
        self.store.update(replacement['id'], status='rejected')
        revised = image_service()
        revised['policy']['health_timeout'] = 31
        self.store.register_service(revised)
        policy_replacement = self.store.request_version('widget', widget_version)
        self.assertNotEqual(policy_replacement['policy_hash'], first['policy_hash'])

    def test_two_connections_deduplicate_identical_request_atomically(self):
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM jobs ORDER BY rowid DESC', barrier)
        coordinate_read(other, 'SELECT data FROM jobs ORDER BY rowid DESC', barrier)
        version = {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST}

        outcomes = concurrent_outcomes(
            lambda: self.store.request_version('widget', version),
            lambda: other.request_version('widget', version),
        )

        self.assertEqual([status for status, _ in outcomes], ['ok', 'ok'])
        self.assertEqual(len({value['id'] for _, value in outcomes}), 1)
        self.assertEqual(len(self.store.list()), 1)
        self.assertFalse(self.store.db.in_transaction)
        self.assertFalse(other.db.in_transaction)

    def test_two_connections_cannot_exceed_request_quota(self):
        for number in range(7):
            reference = 'ghcr.io/acme/widget@sha256:' + ('%064x' % (number + 1))
            self.store.request_version('widget', {'image': reference})
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM jobs ORDER BY rowid DESC', barrier)
        coordinate_read(other, 'SELECT data FROM jobs ORDER BY rowid DESC', barrier)

        outcomes = concurrent_outcomes(
            lambda: self.store.request_version(
                'widget', {'image': 'ghcr.io/acme/widget@sha256:' + 'e' * 64}),
            lambda: other.request_version(
                'widget', {'image': 'ghcr.io/acme/widget@sha256:' + 'f' * 64}),
        )

        self.assertEqual(sorted(status for status, _ in outcomes), ['error', 'ok'])
        error = next(value for status, value in outcomes if status == 'error')
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(len(self.store.list()), 8)
        self.assertFalse(self.store.db.in_transaction)
        self.assertFalse(other.db.in_transaction)

    def test_pending_and_queued_share_global_quota(self):
        self.store.set_mode('widget', 'auto')
        for number in range(8):
            reference = 'ghcr.io/acme/widget@sha256:' + ('%064x' % (number + 1))
            job = self.store.request_version('widget', {'image': reference}, automatic=number % 2 == 0)
            self.assertEqual(job['status'], 'queued' if number % 2 == 0 else 'pending')
        with self.assertRaises(RuntimeError):
            self.store.request_version('widget', {'image': 'ghcr.io/acme/widget@sha256:' + 'f' * 64})

    def test_total_job_quota_and_legacy_duplicate_scan_tolerate_image_jobs(self):
        image_job = self.store.request_version(
            'widget', {'image': 'ghcr.io/acme/widget@sha256:' + DIGEST})
        legacy = self.store.request(SHA)
        self.assertEqual(legacy['commit'], SHA)
        self.assertNotEqual(legacy['id'], image_job['id'])

        self.store.update(image_job['id'], status='rejected')
        self.store.update(legacy['id'], status='rejected')
        rows = []
        now = int(time.time())
        for number in range(998):
            identifier = '%032x' % (number + 100)
            job = {'id': identifier, 'commit': '%040x' % (number + 100), 'status': 'rejected',
                   'stage': 'test_seed', 'created': now, 'updated': now}
            rows.append((identifier, json.dumps(job)))
        with self.store.lock:
            self.store.db.executemany('INSERT INTO jobs VALUES (?,?)', rows)
            self.store.db.commit()
        with self.assertRaises(RuntimeError):
            self.store.request_version(
                'widget', {'image': 'ghcr.io/acme/widget@sha256:' + 'e' * 64})

    def test_hub_request_requires_exact_commit(self):
        self.store.bootstrap(hub_policy())
        with self.assertRaises(ValueError):
            self.store.request_version('pi-web-hub', {'commit': 'main'})
        job = self.store.request_version('pi-web-hub', {'commit': SHA})
        self.assertEqual(job['commit'], SHA)
        self.assertEqual(job['snapshot']['kind'], 'hub')


class StoreIntentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name))
        self.addCleanup(self.store.close)

    def proposal(self, number=0):
        suffix = '' if number == 0 else '-%d' % number
        return {
            'service': 'proposed' + suffix,
            'target': 'proposed' + suffix,
            'repository': 'ghcr.io/acme/proposed' + suffix,
            'description': 'Deploy the proposed service' + suffix,
        }

    def test_intent_is_exact_deduplicated_persistent_and_rejectable(self):
        value = self.proposal()
        first = self.store.intent(value)
        duplicate = self.store.intent(copy.deepcopy(value))

        self.assertEqual(first['id'], duplicate['id'])
        self.assertFalse(self.store.db.in_transaction)
        self.assertEqual(first['status'], 'pending')
        self.assertEqual({key: first[key] for key in value}, value)
        rejected = self.store.reject_intent(first['id'])
        self.assertEqual(rejected['status'], 'rejected')
        replacement = self.store.intent(value)
        self.assertNotEqual(replacement['id'], first['id'])
        self.assertEqual(self.store.intents()[0]['id'], replacement['id'])

    def test_two_connections_deduplicate_identical_intent_atomically(self):
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM intents ORDER BY rowid DESC', barrier)
        coordinate_read(other, 'SELECT data FROM intents ORDER BY rowid DESC', barrier)
        proposal = self.proposal()

        outcomes = concurrent_outcomes(
            lambda: self.store.intent(proposal),
            lambda: other.intent(proposal),
        )

        self.assertEqual([status for status, _ in outcomes], ['ok', 'ok'])
        self.assertEqual(len({value['id'] for _, value in outcomes}), 1)
        self.assertEqual(len(self.store.intents()), 1)
        self.assertFalse(self.store.db.in_transaction)
        self.assertFalse(other.db.in_transaction)

    def test_two_connections_cannot_exceed_intent_quota(self):
        for number in range(7):
            self.store.intent(self.proposal(number))
        other = Store(Path(self.tmp.name))
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        coordinate_read(self.store, 'SELECT data FROM intents ORDER BY rowid DESC', barrier)
        coordinate_read(other, 'SELECT data FROM intents ORDER BY rowid DESC', barrier)

        outcomes = concurrent_outcomes(
            lambda: self.store.intent(self.proposal(8)),
            lambda: other.intent(self.proposal(9)),
        )

        self.assertEqual(sorted(status for status, _ in outcomes), ['error', 'ok'])
        error = next(value for status, value in outcomes if status == 'error')
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(len(self.store.intents()), 8)
        self.assertFalse(self.store.db.in_transaction)
        self.assertFalse(other.db.in_transaction)

    def test_intent_rejects_runtime_fields_reserved_targets_and_secret_values(self):
        invalid = []
        with_mode = self.proposal()
        with_mode['mode'] = 'auto'
        invalid.append(with_mode)
        with_template = self.proposal()
        with_template['template'] = {'Image': 'evil'}
        invalid.append(with_template)
        reserved = self.proposal()
        reserved['target'] = 'pi-deploy-gate'
        invalid.append(reserved)
        secret = self.proposal()
        secret['description'] = 'token=do-not-store-this'
        invalid.append(secret)
        path = self.proposal()
        path['target'] = '../host'
        invalid.append(path)

        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises((TypeError, ValueError)):
                    self.store.intent(value)

    def test_pending_intent_quota_is_eight_and_rejection_releases_a_slot(self):
        created = [self.store.intent(self.proposal(number)) for number in range(8)]
        with self.assertRaises(RuntimeError):
            self.store.intent(self.proposal(9))
        self.store.reject_intent(created[0]['id'])
        ninth = self.store.intent(self.proposal(9))
        self.assertEqual(ninth['status'], 'pending')

    def test_total_intent_quota_is_one_thousand(self):
        rows = []
        now = int(time.time())
        for number in range(1000):
            identifier = '%032x' % (number + 1)
            proposal = self.proposal(number + 1)
            proposal.update(id=identifier, status='rejected', created=now, updated=now)
            rows.append((identifier, json.dumps(proposal)))
        with self.store.lock:
            self.store.db.executemany('INSERT INTO intents VALUES (?,?)', rows)
            self.store.db.commit()
        with self.assertRaises(RuntimeError):
            self.store.intent(self.proposal())

    def test_runtime_template_rejects_privilege_and_unapproved_schema(self):
        mutations = {
            'root user': lambda value: value['policy']['template'].__setitem__('User', '0:0'),
            'image override': lambda value: value['policy']['template'].__setitem__('Image', 'evil:latest'),
            'labels override': lambda value: value['policy']['template'].__setitem__('Labels', {'admin': 'true'}),
            'privileged': lambda value: value['policy']['template']['HostConfig'].__setitem__('Privileged', True),
            'devices': lambda value: value['policy']['template']['HostConfig'].__setitem__('Devices', ['/dev/kvm']),
            'host pid': lambda value: value['policy']['template']['HostConfig'].__setitem__('PidMode', 'host'),
            'host ipc': lambda value: value['policy']['template']['HostConfig'].__setitem__('IpcMode', 'host'),
            'container network': lambda value: value['policy']['template']['HostConfig'].__setitem__('NetworkMode', 'container:other'),
            'writable root': lambda value: value['policy']['template']['HostConfig'].__setitem__('ReadonlyRootfs', False),
            'extra capabilities': lambda value: value['policy']['template']['HostConfig'].__setitem__('CapAdd', ['SYS_ADMIN']),
            'unsafe security option': lambda value: value['policy']['template']['HostConfig'].__setitem__('SecurityOpt', ['seccomp=unconfined']),
            'unbounded memory': lambda value: value['policy']['template']['HostConfig'].__setitem__('Memory', 0),
            'unbounded cpu': lambda value: value['policy']['template']['HostConfig'].__setitem__('NanoCpus', 8_000_000_001),
            'unbounded pids': lambda value: value['policy']['template']['HostConfig'].__setitem__('PidsLimit', 1025),
            'unsafe restart': lambda value: value['policy']['template']['HostConfig'].__setitem__('RestartPolicy', {'Name': 'always'}),
            'docker socket': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/var/run/docker.sock:/run/docker.sock:ro']),
            'docker socket var ancestor': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/var:/host-var:ro']),
            'docker socket var-run ancestor': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/var/run:/host-var-run:ro']),
            'docker socket run ancestor': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/run:/host-run:ro']),
            'gate tree ancestor': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/home/fate/docker_files:/host-config:ro']),
            'gate tree descendant': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/home/fate/docker_files/pi-deploy-gate/private:/host-private:ro']),
            'writable bind': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/srv/widget:/srv/widget:rw']),
            'host root': lambda value: value['policy']['template']['HostConfig'].__setitem__('Binds', ['/:/host:ro']),
            'unsafe health': lambda value: value['policy']['template'].__setitem__('Healthcheck', {'Test': ['NONE']}),
            'path traversal': lambda value: value['policy']['template'].__setitem__('WorkingDir', '/app/../root'),
        }
        for label, mutate in mutations.items():
            with self.subTest(case=label):
                value = image_service()
                mutate(value)
                with self.assertRaises((TypeError, ValueError)):
                    validate_service(value)


if __name__ == '__main__':
    unittest.main()

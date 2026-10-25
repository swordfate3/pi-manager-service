import copy
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager

from .registry import (
    HUB_BRANCH,
    HUB_REPOSITORY,
    MODES,
    contains_secret,
    fingerprint,
    validate_identifier,
    validate_image_reference,
    validate_repository,
    validate_service,
    validate_target,
)


SHA = re.compile(r'[0-9a-f]{40}\Z')
IDENTIFIER = re.compile(r'[0-9a-f]{32}\Z')
EVENT_NAME = re.compile(r'[a-z][a-z0-9_.-]{0,63}\Z')
METADATA_KEY = re.compile(r'[a-z][a-z0-9_]{0,63}\Z')
ACTIVE = ('deploying', 'recovering', 'recovery_required')
REQUEST_OPEN = ('pending', 'queued')
REQUEST_DEDUP = ('pending', 'queued', 'deploying')
RESULT_STATES = ('deployed', 'failed', 'rolled_back', 'recovery_required', 'stale')


def check_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('commit must be a full lowercase 40-character Git SHA')
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def _copy(value):
    return copy.deepcopy(value)


def _service_definition(service):
    return {key: _copy(service[key]) for key in ('id', 'target', 'kind', 'source', 'mode', 'policy')}


def _service_hash(service, revision):
    return fingerprint({'definition': _service_definition(service), 'revision': revision})


def _service_snapshot(service):
    keys = ('id', 'target', 'kind', 'source', 'mode', 'policy', 'revision', 'policy_hash')
    return {key: _copy(service[key]) for key in keys}


class Store:
    def __init__(self, directory):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(directory / 'jobs.sqlite3', check_same_thread=False)
        os.chmod(directory / 'jobs.sqlite3', 0o600)
        with self.lock:
            try:
                self.db.execute('PRAGMA journal_mode=WAL')
                self.db.execute('PRAGMA synchronous=FULL')
                self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
                self.db.execute(
                    'CREATE TABLE IF NOT EXISTS services '
                    '(id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, data TEXT NOT NULL)')
                self.db.execute(
                    'CREATE TABLE IF NOT EXISTS events '
                    '(sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)')
                self.db.execute('CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
                self.db.execute('CREATE TABLE IF NOT EXISTS lifecycle_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
                self.db.execute('CREATE TABLE IF NOT EXISTS lifecycle_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
                lifecycle_policy = {'mode': 'disabled', 'images': [], 'generation': 1}
                lifecycle_policy['policy_hash'] = fingerprint(lifecycle_policy)
                self.db.execute('INSERT OR IGNORE INTO lifecycle_policy (id,data) VALUES (1,?)', (_json(lifecycle_policy),))
                self.db.execute('CREATE TABLE IF NOT EXISTS runtime_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
                self.db.execute('CREATE TABLE IF NOT EXISTS runtime_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
                self.db.execute('INSERT OR IGNORE INTO runtime_policy (id,data) VALUES (1,?)', (_json(lifecycle_policy),))
                self.db.execute('CREATE TABLE IF NOT EXISTS upgrade_reservation '
                                '(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
                self.db.commit()
            except Exception:
                self.db.rollback()
                self.db.close()
                raise

    def close(self):
        with self.lock:
            self.db.close()

    def upgrade_reservation(self):
        with self.lock:
            row = self.db.execute('SELECT data FROM upgrade_reservation WHERE id=1').fetchone()
            return json.loads(row[0]) if row else None

    def require_admission(self):
        if self.upgrade_reservation() is not None:
            raise RuntimeError('host upgrade reservation active')

    @contextmanager
    def _write_transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def _jobs(self):
        return [json.loads(row[0]) for row in self.db.execute('SELECT data FROM jobs ORDER BY rowid DESC')]

    def list(self):
        with self.lock:
            return self._jobs()

    def get(self, identifier):
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ValueError('invalid request ID')
        with self.lock:
            row = self.db.execute('SELECT data FROM jobs WHERE id=?', (identifier,)).fetchone()
            if not row:
                raise KeyError('request not found')
            return json.loads(row[0])

    def _service(self, identifier):
        row = self.db.execute('SELECT data FROM services WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('service not found')
        return json.loads(row[0])

    def services(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(
                'SELECT data FROM services ORDER BY id')]

    def service(self, identifier):
        with self.lock:
            validate_identifier(identifier)
            return self._service(identifier)

    def _save_service(self, service):
        self.db.execute(
            'INSERT INTO services (id,target,data) VALUES (?,?,?) '
            'ON CONFLICT(id) DO UPDATE SET target=excluded.target,data=excluded.data',
            (service['id'], service['target'], _json(service)),
        )

    def _event_value(self, action, service, metadata):
        if not isinstance(action, str) or not EVENT_NAME.fullmatch(action):
            raise ValueError('invalid audit action')
        validate_identifier(service)
        sanitized = {}
        for key, value in metadata.items():
            if (not isinstance(key, str) or not METADATA_KEY.fullmatch(key) or
                    contains_secret(key + '=value')):
                raise ValueError('invalid audit metadata key')
            if value is None or isinstance(value, bool):
                sanitized[key] = value
            elif isinstance(value, int) and not isinstance(value, bool):
                if abs(value) > 2 ** 63 - 1:
                    raise ValueError('audit metadata integer is too large')
                sanitized[key] = value
            elif isinstance(value, str):
                if not value or len(value) > 512 or any(char in value for char in ('\x00', '\r', '\n')):
                    raise ValueError('audit metadata text is invalid')
                if contains_secret(value):
                    raise ValueError('secret-like audit metadata is forbidden')
                sanitized[key] = value
            else:
                raise ValueError('audit metadata must be a scalar')
        return {
            'id': secrets.token_hex(16),
            'action': action,
            'service': service,
            'metadata': sanitized,
            'created': int(time.time()),
        }

    def _append_event(self, action, service, **metadata):
        event = self._event_value(action, service, metadata)
        self.db.execute('INSERT INTO events (data) VALUES (?)', (_json(event),))
        return event

    def audit(self, action, service, **safe_metadata):
        event = self._event_value(action, service, safe_metadata)
        with self.lock:
            with self._write_transaction():
                self.db.execute('INSERT INTO events (data) VALUES (?)', (_json(event),))
            return event

    def events(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(
                'SELECT data FROM events ORDER BY sequence DESC LIMIT 100')]

    def register_service(self, definition):
        normalized = validate_service(definition)
        with self.lock:
            try:
                with self._write_transaction():
                    existing_row = self.db.execute(
                        'SELECT data FROM services WHERE id=?', (normalized['id'],)).fetchone()
                    existing = json.loads(existing_row[0]) if existing_row else None
                    duplicate = self.db.execute(
                        'SELECT id FROM services WHERE target=? AND id<>?',
                        (normalized['target'], normalized['id']),
                    ).fetchone()
                    if duplicate:
                        raise ValueError('target is already registered')
                    revision = (existing['revision'] if existing else 0) + 1
                    service = _copy(normalized)
                    service.update(
                        revision=revision,
                        management_generation=(existing.get('management_generation', 0) if existing else 0) + 1,
                        policy_hash=_service_hash(normalized, revision),
                        paused=bool(existing.get('paused', False)) if existing else False,
                        failures=int(existing.get('failures', 0)) if existing else 0,
                    )
                    self._save_service(service)
                    self._append_event(
                        'service_registered', service['id'], target=service['target'],
                        kind=service['kind'], mode=service['mode'], revision=revision,
                    )
            except sqlite3.IntegrityError as error:
                raise ValueError('target is already registered') from error
            return _copy(service)

    def bootstrap(self, legacy_policy):
        with self.lock:
            with self._write_transaction():
                row = self.db.execute(
                    'SELECT data FROM services WHERE id=?', ('pi-web-hub',)).fetchone()
                existing = json.loads(row[0]) if row else None
                if existing is None:
                    definition = validate_service({
                        'id': 'pi-web-hub',
                        'target': legacy_policy.get('target') if isinstance(legacy_policy, dict) else None,
                        'kind': 'hub',
                        'source': {'repository': HUB_REPOSITORY, 'auto_branch': HUB_BRANCH},
                        'mode': 'auto',
                        'policy': legacy_policy,
                    })
                    service = _copy(definition)
                    service.update(
                        revision=1,
                        management_generation=1,
                        policy_hash=_service_hash(definition, 1),
                        paused=False,
                        failures=0,
                    )
                    duplicate = self.db.execute(
                        'SELECT id FROM services WHERE target=?', (service['target'],)).fetchone()
                    if duplicate:
                        raise ValueError('target is already registered')
                    self._save_service(service)
                    self._append_event(
                        'service_registered', service['id'], target=service['target'],
                        kind='hub', mode='auto', revision=1,
                    )
                else:
                    service = existing

                for rowid, raw in self.db.execute('SELECT rowid,data FROM jobs').fetchall():
                    job = json.loads(raw)
                    if 'service' in job or 'commit' not in job:
                        continue
                    job['service'] = 'pi-web-hub'
                    job['approval_mode'] = 'manual'
                    job['automatic'] = False
                    self.db.execute('UPDATE jobs SET data=? WHERE rowid=?', (_json(job), rowid))
            return _copy(service)

    def set_mode(self, identifier, mode):
        validate_identifier(identifier)
        if mode not in MODES:
            raise ValueError('invalid approval mode')
        with self.lock:
            with self._write_transaction():
                service = self._service(identifier)
                if service['mode'] == mode:
                    return service
                previous = service['mode']
                service['mode'] = mode
                service['revision'] += 1
                service['management_generation'] = service.get('management_generation', 0) + 1
                service['policy_hash'] = _service_hash(service, service['revision'])
                self._save_service(service)
                self._append_event(
                    'mode_changed', identifier, previous=previous, mode=mode,
                    revision=service['revision'],
                )
            return _copy(service)

    def resume_service(self, identifier):
        validate_identifier(identifier)
        with self.lock:
            with self._write_transaction():
                service = self._service(identifier)
                previous_failures = service.get('failures', 0)
                was_paused = bool(service.get('paused', False))
                service['failures'] = 0
                service['paused'] = False
                service['management_generation'] = service.get('management_generation', 0) + 1
                self._save_service(service)
                self._append_event(
                    'service_resumed', identifier, previous_failures=previous_failures,
                    was_paused=was_paused,
                )
            return _copy(service)

    def record_result(self, identifier, success):
        validate_identifier(identifier)
        if not isinstance(success, bool):
            raise ValueError('deployment result must be boolean')
        with self.lock:
            with self._write_transaction():
                service = self._record_result(identifier, success)
            return _copy(service)

    def _record_result(self, identifier, success, **metadata):
        # Caller owns the write transaction, including any per-job marker.
        service = self._service(identifier)
        # Management revisions must distinguish repeated pause/resume incidents.
        # Keep this out of _service_hash/_service_snapshot so result accounting
        # does not revoke an otherwise unchanged executor policy or pinned plan.
        service['management_generation'] = service.get('management_generation', 0) + 1
        if success:
            service['failures'] = 0
        else:
            service['failures'] = int(service.get('failures', 0)) + 1
            if service['failures'] >= 3:
                service['paused'] = True
        self._save_service(service)
        self._append_event(
            'deployment_result', identifier, success=success,
            failures=service['failures'], paused=bool(service.get('paused', False)), **metadata,
        )
        return service

    def account_job_result(self, identifier):
        """Commit the original deployment result and its receipt exactly once."""
        with self.lock:
            with self._write_transaction():
                job = self.get(identifier)
                if 'snapshot' not in job or job.get('result_accounted'):
                    return job
                outcome = job['status']
                if outcome not in RESULT_STATES:
                    return job
                if outcome == 'deployed' or (job.get('automatic') and outcome in
                        ('failed', 'rolled_back', 'recovery_required')):
                    self._record_result(job['service'], outcome == 'deployed', request=identifier)
                job.update(deployment_outcome=outcome, result_accounted=True,
                           result_accounted_at=int(time.time()))
                self.db.execute('UPDATE jobs SET data=? WHERE id=?', (_json(job), identifier))
            return _copy(job)

    def reconcile_results(self):
        for job in reversed(self.list()):
            self.account_job_result(job['id'])

    def _validate_version(self, service, version):
        if not isinstance(version, dict):
            raise ValueError('version must be an object')
        if service['kind'] == 'hub':
            if set(version) != {'commit'}:
                raise ValueError('Hub version must contain only commit')
            return 'commit', check_sha(version['commit'])
        if set(version) != {'image'}:
            raise ValueError('image version must contain only image')
        return 'image', validate_image_reference(service['source']['repository'], version['image'])

    def request_version(self, service_id, version, automatic=False):
        validate_identifier(service_id)
        if not isinstance(automatic, bool):
            raise ValueError('automatic must be a trusted boolean')
        with self.lock:
            with self._write_transaction():
                self.require_admission()
                service = self._service(service_id)
                field, value = self._validate_version(service, version)
                if service['mode'] == 'disabled':
                    raise RuntimeError('service is disabled')
                if automatic and (service['mode'] != 'auto' or service.get('paused')):
                    raise RuntimeError('service is not eligible for automatic deployment')
                jobs = self._jobs()
                for job in jobs:
                    if (job.get('status') in REQUEST_DEDUP and job.get('service') == service_id and
                            job.get(field) == value and job.get('policy_hash') == service['policy_hash']):
                        return job
                if sum(job.get('status') in REQUEST_OPEN for job in jobs) >= 8 or len(jobs) >= 1000:
                    raise RuntimeError('request quota reached; administrator review required')
                snapshot = _service_snapshot(service)
                normalized_version = {field: value}
                policy_hash = service['policy_hash']
                plan_hash = fingerprint({
                    'service': service_id,
                    'version': normalized_version,
                    'snapshot': snapshot,
                    'policy_hash': policy_hash,
                })
                now = int(time.time())
                job = {
                    'id': secrets.token_hex(16),
                    'service': service_id,
                    'version': normalized_version,
                    field: value,
                    'snapshot': snapshot,
                    'policy_hash': policy_hash,
                    'plan_hash': plan_hash,
                    'approval_mode': 'auto' if automatic else 'manual',
                    'automatic': automatic,
                    'status': 'queued' if automatic else 'pending',
                    'stage': 'queued_by_policy' if automatic else 'awaiting_approval',
                    'created': now,
                    'updated': now,
                }
                self.db.execute('INSERT INTO jobs (id,data) VALUES (?,?)', (job['id'], _json(job)))
            return _copy(job)

    def request(self, commit):
        check_sha(commit)
        with self.lock:
            with self._write_transaction():
                self.require_admission()
                jobs = self._jobs()
                for job in jobs:
                    if job.get('commit') == commit and job.get('status') in ('pending', 'deploying'):
                        return job
                if sum(job.get('status') in REQUEST_OPEN for job in jobs) >= 8 or len(jobs) >= 1000:
                    raise RuntimeError('request quota reached; administrator review required')
                now = int(time.time())
                job = {
                    'id': secrets.token_hex(16), 'commit': commit, 'status': 'pending',
                    'stage': 'awaiting_approval', 'created': now, 'updated': now,
                }
                self.db.execute('INSERT INTO jobs (id,data) VALUES (?,?)', (job['id'], _json(job)))
            return _copy(job)

    def update(self, identifier, **fields):
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ValueError('invalid request ID')
        with self.lock:
            with self._write_transaction():
                row = self.db.execute('SELECT data FROM jobs WHERE id=?', (identifier,)).fetchone()
                if not row:
                    raise KeyError('request not found')
                job = json.loads(row[0])
                job.update(fields, updated=int(time.time()))
                self.db.execute('UPDATE jobs SET data=? WHERE id=?', (_json(job), identifier))
            return _copy(job)

    def _validate_intent(self, value):
        if not isinstance(value, dict) or set(value) != {'service', 'target', 'repository', 'description'}:
            raise ValueError('intent must contain only service, target, repository and description')
        service = validate_identifier(value['service'])
        target = validate_target(value['target'])
        repository = validate_repository(value['repository'])
        description = value['description']
        if (not isinstance(description, str) or not 1 <= len(description) <= 1000 or
                description != description.strip() or any(char in description for char in ('\x00', '\r'))):
            raise ValueError('intent description must be bounded plain text')
        for item in (service, target, repository, description):
            if contains_secret(item):
                raise ValueError('intent must not contain secrets')
        return {
            'service': service,
            'target': target,
            'repository': repository,
            'description': description,
        }

    def intent(self, value):
        proposal = self._validate_intent(value)
        with self.lock:
            with self._write_transaction():
                existing = [json.loads(row[0]) for row in self.db.execute(
                    'SELECT data FROM intents ORDER BY rowid DESC')]
                for item in existing:
                    if item.get('status') == 'pending' and all(
                            item.get(key) == proposal[key] for key in proposal):
                        return item
                if sum(item.get('status') == 'pending' for item in existing) >= 8 or len(existing) >= 1000:
                    raise RuntimeError('intent quota reached; administrator review required')
                now = int(time.time())
                item = {
                    'id': secrets.token_hex(16), **proposal, 'status': 'pending',
                    'created': now, 'updated': now,
                }
                self.db.execute('INSERT INTO intents (id,data) VALUES (?,?)', (item['id'], _json(item)))
            return _copy(item)

    def intents(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(
                'SELECT data FROM intents ORDER BY rowid DESC')]

    def reject_intent(self, identifier):
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ValueError('invalid intent ID')
        with self.lock:
            with self._write_transaction():
                row = self.db.execute('SELECT data FROM intents WHERE id=?', (identifier,)).fetchone()
                if not row:
                    raise KeyError('intent not found')
                item = json.loads(row[0])
                if item.get('status') != 'pending':
                    raise RuntimeError('intent is not pending')
                item['status'] = 'rejected'
                item['updated'] = int(time.time())
                self.db.execute('UPDATE intents SET data=? WHERE id=?', (_json(item), identifier))
                self._append_event(
                    'intent_rejected', item['service'], intent=identifier, target=item['target'])
            return _copy(item)


def public(job):
    keys = (
        'id', 'commit', 'image', 'service', 'status', 'stage', 'created', 'updated',
        'bundle_sha256', 'error', 'plan_hash', 'approval_mode', 'automatic',
    )
    return {key: _copy(job[key]) for key in keys if key in job}

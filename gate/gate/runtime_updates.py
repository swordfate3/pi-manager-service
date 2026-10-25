"""Global shared-runtime upgrades with durable, idle-only session refresh."""
import json
import re
import secrets
import threading
import time

from .engine import DockerTimeout
from .lifecycle import Deadline
from .lifecycle_contract import CONTAINER, IMAGE, identifier, snapshot, terminal_profile
from .registry import fingerprint
from .runtime_catalog import RegistryUnavailable, RuntimeCatalog, stable_version
from .runtime_install import checked_candidate, checked_evidence, digest, pinned_release
from .runtime_engine import MAX_SOURCES, checked_source, checked_source_evidence, checked_source_image
from .store import ACTIVE, REQUEST_OPEN, _json

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
OPEN = ('pending', 'queued', 'running', 'recovery_required')
SUBMIT_SINGLE_FLIGHT_WAIT = 10
MAX_SUBMIT_FLIGHTS = 128
MAX_POLL_TIMEOUT_RETRIES = 3


class RuntimeUpdates:
    def __init__(self, gate):
        self.gate, self.store = gate, gate.store
        self.runtime_engine = None
        self.catalog = RuntimeCatalog()
        self._submit_flights_lock = threading.Lock()
        self._submit_flights = {}

    def _engine(self):
        if self.runtime_engine is not None:
            return self.runtime_engine
        from .runtime_engine import RuntimeEngine
        return RuntimeEngine(self.gate.lifecycle._engine(), volume=self.gate.runtime_volume)

    def _profile(self, job):
        # Admission binds local source and policy image identities; it neither
        # contacts Docker nor executes a candidate before manual approval.
        if self.runtime_engine is not None:
            return self.runtime_engine.profile(job)
        from .runtime_engine import RuntimeEngine
        return RuntimeEngine.profile(job)

    def policy(self):
        with self.store.lock:
            return json.loads(self.store.db.execute('SELECT data FROM runtime_policy WHERE id=1').fetchone()[0])

    def set_policy(self, value):
        if (not isinstance(value, dict) or set(value) != {'mode', 'images'} or
                value['mode'] not in ('disabled', 'manual', 'auto') or
                not isinstance(value['images'], list) or len(value['images']) > 64 or
                any(not isinstance(i, str) or not IMAGE.fullmatch(i) for i in value['images']) or
                (value['mode'] != 'disabled' and not value['images'])):
            raise ValueError('invalid runtime update policy')
        with self.store.lock, self.store._write_transaction():
            self.store.require_admission()
            if any(j['status'] == 'running' for j in self._jobs()):
                raise RuntimeError('runtime rollout in progress')
            old = self.policy()
            definition = {'mode': value['mode'], 'images': sorted(set(value['images']))}
            if all(old[k] == v for k, v in definition.items()):
                return old
            policy = {**definition, 'generation': old['generation'] + 1}
            policy['policy_hash'] = fingerprint(policy)
            self.store.db.execute('UPDATE runtime_policy SET data=? WHERE id=1', (_json(policy),))
            self.store._append_event('runtime_policy', 'pi-runtime', mode=policy['mode'])
            return policy

    def _get(self, key):
        identifier(key)
        with self.store.lock:
            row = self.store.db.execute('SELECT data FROM runtime_jobs WHERE id=?', (key,)).fetchone()
            if not row:
                raise KeyError('runtime update not found')
            return json.loads(row[0])

    @staticmethod
    def public(job):
        keys = ('id', 'version', 'status', 'stage', 'created_at', 'install_started_at',
                'resolved_at', 'resolution')
        result = {k: job[k] for k in keys if k in job}
        result['targets'] = [
            {k: t[k] for k in ('run_id', 'status', 'old_version', 'version', 'restart_id', 'wait_reason', 'profile') if k in t}
            for t in job.get('targets', [])]
        if job.get('resolved_at'):
            result['resolved'] = True
        return result

    def get(self, key):
        return self.public(self._get(key))

    def _jobs(self):
        with self.store.lock:
            return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM runtime_jobs ORDER BY rowid DESC')]

    def jobs(self):
        return [self.public(j) for j in self._jobs()[:100]]

    def active(self):
        return [self.public(j) for j in self._jobs() if j['status'] in OPEN and not j.get('resolved_at')]

    def _update(self, key, **fields):
        with self.store.lock, self.store._write_transaction():
            job = self._get(key)
            job.update(fields)
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(job), key))
            return job

    def _other_work(self):
        return (self.gate.closing or self.gate.lifecycle.active() or
                (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list()))

    def _join_submit_flight(self, key, version):
        with self._submit_flights_lock:
            flight = self._submit_flights.get(key)
            if flight is not None:
                if flight['version'] != version:
                    raise RuntimeError('idempotency conflict')
                return flight, False
            if len(self._submit_flights) >= MAX_SUBMIT_FLIGHTS:
                raise RuntimeError('too many runtime submissions')
            flight = {'version': version, 'event': threading.Event()}
            self._submit_flights[key] = flight
            return flight, True

    def _finish_submit_flight(self, key, flight):
        with self._submit_flights_lock:
            flight['event'].set()
            if self._submit_flights.get(key) is flight:
                del self._submit_flights[key]

    @staticmethod
    def _raise_submit_failure():
        raise RegistryUnavailable() from None

    def _wait_for_submit_flight(self, key, version, flight):
        flight['event'].wait(SUBMIT_SINGLE_FLIGHT_WAIT)
        try:
            previous = self._get(key)
        except KeyError:
            previous = None
        if previous is not None:
            if previous['version'] != version:
                raise RuntimeError('idempotency conflict')
            return self.public(previous)
        self._raise_submit_failure()

    def submit(self, value):
        if (not isinstance(value, dict) or set(value) != {'version', 'idempotency_key'} or
                not isinstance(value['version'], str) or len(value['version']) > 64 or
                not VERSION.fullmatch(value['version'])):
            raise ValueError('an exact stable Pi version is required')
        key = identifier(value['idempotency_key'])
        # Join under the ledger lock, then resolve outside it without replaying a key.
        with self.store.lock:
            try:
                previous = self._get(key)
            except KeyError:
                previous = None
            if previous:
                if previous['version'] != value['version']:
                    raise RuntimeError('idempotency conflict')
                return self.public(previous)
            self.store.require_admission()
            initial_policy = self.policy()
            if initial_policy['mode'] == 'disabled' or self.active() or self._other_work():
                raise RuntimeError('runtime update disabled or busy')
            # Fixed lock order: store -> flight. Waiting and resolution happen
            # only after both locks are released.
            flight, leader = self._join_submit_flight(key, value['version'])
        if not leader:
            return self._wait_for_submit_flight(key, value['version'], flight)
        try:
            try:
                release = self.catalog.resolve(value['version'])
            except Exception:
                self._raise_submit_failure()
            with self.store.lock, self.store._write_transaction():
                self.store.require_admission()
                try:
                    previous = self._get(key)
                except KeyError:
                    previous = None
                if previous:
                    if previous['version'] != value['version']:
                        raise RuntimeError('idempotency conflict')
                    result = self.public(previous)
                else:
                    policy = self.policy()
                    if policy != initial_policy:
                        raise RuntimeError('runtime policy changed during resolution')
                    if policy['mode'] == 'disabled' or self.active() or self._other_work():
                        raise RuntimeError('runtime update disabled or busy')
                    if len(self._jobs()) >= 1000:
                        raise RuntimeError('runtime update quota')
                    job = dict(id=key, version=value['version'], policy=policy,
                               release=release, release_hash=fingerprint(release),
                               status='queued' if policy['mode'] == 'auto' else 'pending',
                               stage='queued_by_policy' if policy['mode'] == 'auto' else 'awaiting_approval',
                               targets=[], created_at=int(time.time() * 1000))
                    job['profile'] = self._profile(job)
                    self.store.db.execute('INSERT INTO runtime_jobs (id,data) VALUES (?,?)', (key, _json(job)))
                    self.store._append_event('runtime_requested', 'pi-runtime', request=key,
                                             version=value['version'])
                    result = self.public(job)
            return result
        finally:
            self._finish_submit_flight(key, flight)

    def _fence(self, job):
        self.store.require_admission()
        release = job.get('release')
        if (not isinstance(release, dict) or set(release) != {'version', 'integrity', 'tarball', 'node'} or
                not stable_version(job['version']) or release['version'] != job['version'] or
                fingerprint(release) != job.get('release_hash')):
            raise RuntimeError('pinned runtime release changed or missing')
        pinned_release(release, job['version'])
        if job.get('profile') != self._profile(job):
            raise RuntimeError('runtime execution profile changed')
        if self.policy()['policy_hash'] != job['policy']['policy_hash'] or self.policy()['mode'] == 'disabled':
            raise RuntimeError('runtime policy changed')

    def approve(self, key):
        with self.store.lock:
            job = self._get(key)
            self._fence(job)
            if job['status'] != 'pending' or self._other_work():
                raise RuntimeError('runtime task not eligible')
            return self.public(self._update(key, status='queued', stage='approved_by_host'))

    def readiness(self):
        """Read-only trust/readiness projection. Busy generation can wait after submit."""
        consumers = []
        installed_versions = set()
        life = self.gate.lifecycle
        deadline = Deadline(time, 4)
        try:
            policy = self.policy()
            jobs, current_profile = self._jobs(), None
            candidates = life._transport(deadline, self._engine().consumers)
            if not isinstance(candidates, list) or len(candidates) > 128:
                raise RuntimeError('runtime inventory unavailable')
            for candidate in candidates:
                deadline.remaining()
                cid = candidate.get('Id')
                row = {'run_id': fingerprint({'consumer': cid})[:32], 'ready': False,
                       'reason': 'unmanaged_consumer'}
                try:
                    item = life._transport(deadline, life._engine().inspect, cid)
                    if self._terminal_exit(item, cid):
                        continue
                    if not self._running_consumer(item):
                        raise RuntimeError('consumer_not_ready')
                    run = identifier(item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.run-id'))
                    row['run_id'] = run
                    checked = life._resolve(run, policy, expected=cid, role='inventory', deadline=deadline)
                    if not any(m.get('Name') == self.gate.runtime_volume and m.get('Destination') == '/home/node/.local'
                               for m in checked.get('Mounts') or []):
                        raise RuntimeError('runtime mount mismatch')
                    row['reason'] = 'consumer_not_ready'
                    observation = life._status(checked, deadline)
                    state = snapshot(observation, run)
                    installed = observation.get('installed_version')
                    if installed is not None:
                        if not stable_version(installed):
                            raise RuntimeError('invalid installed version')
                        installed_versions.add(installed)
                    if not stable_version(state['version']):
                        raise RuntimeError('invalid runtime version')
                    row.update(version=state['version'])
                    blocker = self._engine().consumer_blocker(checked, state)
                    if blocker:
                        row.update(ready=False, reason=blocker)
                    else:
                        checked_source(state.get('source_identity'), state['version'])
                        if current_profile is None:
                            current_profile = self._profile({'policy': policy})
                        row['reason'] = 'image_profile_mismatch'
                        checked_source_image({'policy': policy, 'profile': current_profile}, checked)
                        row.update(ready=True, source_status='evaluable')
                        # Pure ledger lookup only: HTTP readiness never creates,
                        # starts, polls or synchronously waits for a probe.
                        for job in jobs:
                            try:
                                if job['policy'] != policy:
                                    continue
                                if job['profile'] != current_profile:
                                    continue
                                self.source_proof(job, checked, state)
                                row['source_status'] = 'verified'
                                break
                            except (ValueError, KeyError, TypeError, RuntimeError):
                                continue
                        if state['busy'] or state['pending'] or not state['idle']:
                            row['reason'] = 'busy_waits_for_idle'
                        else:
                            row.pop('reason', None)
                except Exception:
                    pass
                deadline.remaining()
                consumers.append(row)
            if self.policy() != policy or len(installed_versions) > 1:
                raise RuntimeError('runtime policy changed during readiness')
            return {'status': 'ready' if all(row['ready'] for row in consumers) else 'blocked',
                    'consumers': consumers,
                    **({'installed_version': next(iter(installed_versions))} if installed_versions else {})}
        except Exception:
            return {'status': 'unavailable', 'consumers': []}

    def reject(self, key):
        with self.store.lock:
            job = self._get(key)
            if job['status'] not in ('pending', 'queued'):
                raise RuntimeError('cannot reject an activated runtime update')
            return self.public(self._update(key, status='rejected', stage='host_rejected'))

    def authorize_child(self, child):
        parent = self._get(child['runtime_update_id'])
        self._fence(parent)
        checked_evidence(parent.get('evidence'), parent.get('candidate'), parent['release'], parent['profile'])
        if (parent['status'] != 'running' or parent['stage'] not in ('refreshing', 'waiting_for_idle') or
                parent['policy'] != child['policy'] or child.get('requested_version') != parent['version'] or
                not any(t.get('restart_id') == child['id'] and t['container_id'] == child['container_id']
                        for t in parent['targets'])):
            raise RuntimeError('runtime refresh authorization changed')
        # Re-resolve the actual immutable container and measured launch at the
        # last Gate authorization boundary, not the enqueue-time version label.
        life = self.gate.lifecycle
        item = life._resolve(child['run_id'], parent['policy'], expected=child['container_id'],
                             expected_hash=child['target_hash'])
        state = snapshot(life._status(item), child['run_id'])
        self.source_proof(parent, item, state)
        if child.get('source_hash') != digest(state['source_identity']):
            raise RuntimeError('runtime refresh source changed')

    def tick(self):
        active = [j for j in self._jobs() if j['status'] in OPEN and not j.get('resolved_at')]
        if not active:
            return False
        job = active[-1]
        if job['status'] in ('pending', 'recovery_required'):
            return True
        if job['status'] == 'queued':
            try:
                self._fence(job)
            except RuntimeError:
                self._update(job['id'], status='stale', stage='policy_changed')
                return True
        # Let the existing lifecycle dispatcher execute an authorized child.
        if any(j.get('runtime_update_id') == job['id'] and j['status'] in ('queued', 'running')
               for j in self.gate.lifecycle._jobs()):
            return False
        target = self._install if job['stage'] not in ('refreshing', 'waiting_for_idle') else self._refresh
        self.gate.worker = threading.Thread(target=target, args=(job,), daemon=False)
        self.gate.worker.start()
        return True

    @staticmethod
    def _inventory_read(read, *args, **kwargs):
        # Only direct inventory GETs: never resolution, status, or mutations.
        for attempt in range(4):
            try:
                return read(*args, **kwargs)
            except DockerTimeout:
                if attempt == 3:
                    raise

    @staticmethod
    def _terminal_exit(item, cid):
        if not isinstance(cid, str) or not CONTAINER.fullmatch(cid):
            raise RuntimeError('invalid consumer identity')
        if item is None:  # Engine.inspect returns None only for exact-ID 404.
            return True
        if not isinstance(item, dict) or item.get('Id') != cid:
            raise RuntimeError('consumer identity changed')
        state = item.get('State')
        if not isinstance(state, dict) or type(state.get('Running')) is not bool:
            raise RuntimeError('consumer state unavailable')
        return state['Running'] is False and state.get('Status') in ('exited', 'dead')

    @staticmethod
    def _running_consumer(item):
        state = item.get('State', {})
        return (state.get('Running') is True and not state.get('Paused') and
                not state.get('Restarting') and state.get('Status', 'running') == 'running')

    def _remember_consumers(self, job, inventory):
        targets = [dict(target) for target in job.get('targets', [])]
        known = {target['container_id'] for target in targets}
        for item, _ in inventory:
            if item['Id'] not in known:
                targets.append({'container_id': item['Id'],
                                'run_id': item['Config']['Labels']['cn.swordfate.pi.run-id'],
                                'status': 'waiting_for_idle'})
                known.add(item['Id'])
        if targets != job.get('targets', []):
            with self.store.lock:
                if self._get(job['id']) != job or job['status'] not in ('queued', 'running'):
                    raise RuntimeError('consumer inventory authorization changed')
                job = self._update(job['id'], targets=targets)
        return job

    def _inventory(self, job):
        engine, life, inventory = self._engine(), self.gate.lifecycle, []
        candidates = self._inventory_read(engine.consumers)
        if not isinstance(candidates, list) or len(candidates) > 128:
            raise RuntimeError('too many runtime consumers')
        candidates = {candidate['Id']: candidate for candidate in candidates}
        # Keep the early inventory's identities through activation, crash
        # recovery and the first refresh. List omission is never an exit grant.
        for target in job.get('targets', []):
            if target['status'] != 'exited':
                candidates.setdefault(target['container_id'], {'Id': target['container_id']})
        if len(candidates) > 128:
            raise RuntimeError('too many runtime consumers')
        for cid in candidates:
            if not isinstance(cid, str) or not CONTAINER.fullmatch(cid):
                raise RuntimeError('invalid consumer identity')
        for candidate in candidates.values():
            if candidate.get('Id') == job.get('helper_id'):
                continue
            item = self._inventory_read(life._engine().inspect, candidate['Id'], timeout=3)
            if self._terminal_exit(item, candidate['Id']):
                continue  # Listed while running, now confirmed exited by immutable ID.
            # A helper retained across Gate restart is reconciled separately.
            if item and item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-update') == job['id']:
                continue
            run = identifier((item or {}).get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.run-id'))
            deadline = Deadline(time, 4)
            try:
                item = life._resolve(run, job['policy'], expected=candidate['Id'], deadline=deadline,
                                     role='terminal' if terminal_profile(item) else 'inventory')
            except Exception:
                latest = self._inventory_read(life._engine().inspect, candidate['Id'], timeout=3)
                if self._terminal_exit(latest, candidate['Id']):
                    continue
                raise
            if not any(m.get('Name') == self.gate.runtime_volume and m.get('Destination') == '/home/node/.local'
                       for m in item.get('Mounts') or []):
                raise RuntimeError('runtime consumer mount mismatch')
            if terminal_profile(item):
                # Explicit inventory-only marker: never a lifecycle snapshot/version.
                inventory.append((item, {'profile': 'web-terminal-v1'}))
                continue
            if not self._running_consumer(item):
                inventory.append((item, None))
                continue
            try:
                state = snapshot(life._status(item, deadline), run)
            except Exception:
                latest = self._inventory_read(life._engine().inspect, candidate['Id'], timeout=3)
                if self._terminal_exit(latest, candidate['Id']):
                    continue
                # Trust was established before status. A fresh identity check
                # distinguishes startup/transport gaps from a changed container.
                life._resolve(run, job['policy'], expected=item['Id'], expected_hash=life._target_hash(item))
                state = None
            inventory.append((item, state))
        return inventory

    def source_proof(self, job, item, state):
        """Pure lookup of exact, durable Gate-owned source/profile evidence.

        Callers independently resolve trusted container/status and retain their
        final barrier/restoration checks. No version or package receipt grants
        compatibility, and this does not grant source origin/integrity.
        """
        checked_source_image(job, item)
        if terminal_profile(item) or not isinstance(state, dict):
            raise RuntimeError('source evidence unavailable')
        identity = checked_source(state.get('source_identity'), state.get('version'))
        record = job.get('sources', {}).get(digest(identity), {})
        if record.get('identity') != identity:
            raise RuntimeError('source evidence unavailable')
        return checked_source_evidence(record.get('evidence'), identity, job['profile'])

    def restart_evidence(self, policy, item, state, record_id=None):
        """Reuse completed Gate evidence, never evaluate on the lifecycle HTTP path.

        Lifecycle policy grants permission; the runtime ledger only supplies
        measured compatibility and a prepared target for the shared restore path.
        Runtime policy changes cannot grant or silently bypass this requirement.
        """
        profile = self._profile({'policy': policy})
        records = [self._get(record_id)] if record_id is not None else self._jobs()
        for record in records:
            try:
                if (record['status'] != 'succeeded' or record['profile'] != profile or
                        record.get('installed_version') != record['version']):
                    continue
                pinned_release(record['release'], record['version'])
                if fingerprint(record['release']) != record.get('release_hash'):
                    continue
                checked_candidate(record.get('candidate'), record['release'])
                checked_evidence(record.get('evidence'), record['candidate'], record['release'], profile)
                self.source_proof(record, item, state)
                return record
            except (KeyError, TypeError, ValueError, RuntimeError):
                continue
        raise RuntimeError('source_evidence_unavailable')

    def authorize_restart(self, child):
        record_id = child.get('runtime_evidence_id')
        if record_id is None:
            raise RuntimeError('source_evidence_unavailable')
        life = self.gate.lifecycle
        item = life._resolve(child['run_id'], child['policy'], expected=child['container_id'],
                             expected_hash=child['target_hash'])
        state = snapshot(life._status(item), child['run_id'])
        record = self.restart_evidence(child['policy'], item, state, record_id)
        if (child.get('source_hash') != digest(state['source_identity']) or
                child.get('requested_version') != record['version'] or
                child.get('evidence_profile_hash') != digest(record['profile'])):
            raise RuntimeError('runtime restart source changed')
        return record

    def _ensure_sources(self, job, inventory):
        """Drive one bounded offline source job; resume from durable helper intent."""
        job = self._remember_consumers(job, inventory)
        identities = {}
        for item, state in inventory:
            if state is None:
                return job, False
            checked_source_image(job, item)
            identity = checked_source(state.get('source_identity'), state.get('version'))
            if terminal_profile(item):
                raise RuntimeError('source consumer not evaluable')
            identities[digest(identity)] = identity
        # An exited consumer does not revoke an already durable helper intent.
        # Reconcile retained source jobs as well, so no source helper is left
        # running concurrently with a later writable installation phase.
        records = job.get('sources', {})
        if len(records) > MAX_SOURCES:
            raise RuntimeError('source validation quota')
        for key, record in records.items():
            identity = record.get('identity')
            checked_source(identity, identity.get('version') if isinstance(identity, dict) else None)
            if digest(identity) != key:
                raise RuntimeError('source record identity changed')
            identities.setdefault(key, identity)
        for key, identity in identities.items():
            record = job.get('sources', {}).get(key)
            if record is not None and record.get('identity') != identity:
                raise RuntimeError('source record identity changed')
            if record and 'evidence' in record:
                checked_source_evidence(record['evidence'], identity, job['profile'])
        for key, identity in identities.items():
            record = job.get('sources', {}).get(key)
            if record and 'evidence' in record:
                continue
            if record is None:
                with self.store.lock:
                    latest = self._get(job['id'])
                    if latest != job or latest['status'] != 'running':
                        raise RuntimeError('source authorization changed')
                    self._fence(latest)
                    sources = latest.get('sources', {})
                    if len(sources) >= MAX_SOURCES:
                        raise RuntimeError('source validation quota')
                    job = self._update(job['id'], sources={**sources, key: {'identity': identity}})
            result = self._drive_helper(job, 'source-' + key)
            job = self._get(job['id'])
            if result.get('state') == 'running':
                return job, False
            if result.get('state') != 'succeeded':
                raise RuntimeError('source helper outcome unverified')
            evidence = checked_source_evidence(result.get('evidence'), identity, job['profile'])
            with self.store.lock:
                latest = self._get(job['id'])
                if latest != job or latest['status'] != 'running':
                    raise RuntimeError('source validation authorization changed')
                self._fence(latest)
                sources = latest['sources']
                job = self._update(job['id'], sources={**sources, key: {
                    'identity': identity, 'evidence': evidence}})
            # Bound each worker pass to one source probe. All current identities
            # must be verified before returning eligibility, even on recovery.
            return job, all('evidence' in job.get('sources', {}).get(k, {}) for k in identities)
        return job, True

    def _drive_helper(self, job, phase):
        self._fence(job)
        engine, key = self._engine(), job['id']
        helper = job.get('helpers', {}).get(phase)
        if phase == 'activate':
            checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
            # Once start intent is durable, reconcile the helper outcome. New
            # consumer blockers cannot relabel a possible activation as a clean
            # pre-activation failure or strand it in a readiness wait.
            if not helper or not helper.get('intent_at'):
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return {'state': 'waiting'}
        if helper is None:
            identity = engine.create(job, phase)
            job = self._update(key, helpers={**job.get('helpers', {}), phase: {'id': identity}})
            helper = job['helpers'][phase]
        if not helper.get('intent_at'):
            # Only this invocation may send start after committing the intent.
            # A recovered intent always goes straight to polling, even if the
            # helper still says created: the previous start result is unknown.
            if phase == 'activate':
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return {'state': 'waiting'}
                helper = job['helpers'][phase]
            with self.store.lock:
                latest = self._get(key)
                if latest != job or latest['status'] != 'running':
                    raise RuntimeError('helper authorization changed')
                self._fence(latest)
                helper = {**helper, 'intent_at': int(time.time() * 1000)}
                job = self._update(key, helpers={**job.get('helpers', {}), phase: helper})
            engine.start(job, phase)
        helper = job['helpers'][phase]
        failures = helper.get('poll_timeouts', 0)
        if type(failures) is not int or not 0 <= failures <= MAX_POLL_TIMEOUT_RETRIES + 1:
            raise RuntimeError('invalid helper observation counter')
        if failures > MAX_POLL_TIMEOUT_RETRIES:
            return {'state': 'unknown'}
        result = engine.poll(job, phase)
        timed_out = result == {'state': 'observation_timeout'}
        if timed_out or failures:
            # This marker comes only from poll's read-only inspect/logs boundaries.
            # Never retry create/start/stop or turn an unknown receipt into evidence.
            failures = failures + 1 if timed_out else 0
            with self.store.lock:
                latest = self._get(key)
                if latest != job or latest['status'] != 'running':
                    raise RuntimeError('helper observation authorization changed')
                self._fence(latest)
                self._update(key, helpers={**job['helpers'], phase: {**helper, 'poll_timeouts': failures}})
        if timed_out:
            expired = time.time() - helper['intent_at'] / 1000 > 900
            return {'state': 'unknown' if expired or failures > MAX_POLL_TIMEOUT_RETRIES else 'running'}
        return result

    def _install(self, job):
        key = job['id']
        try:
            if job['status'] == 'queued':
                inventory = self._inventory(job)
                job = self._remember_consumers(job, inventory)
                with self.store.lock:
                    latest = self._get(key)
                    if latest != job or latest['status'] != 'queued':
                        return  # A host rejection won the race; never resurrect it.
                    self._fence(job)
                    if any(state is None for _, state in inventory):
                        self._update(key, stage='waiting_for_consumer_readiness')
                        return
                    for item, state in inventory:
                        checked_source_image(job, item)
                        checked_source(state.get('source_identity'), state.get('version'))
                        blocker = self._engine().consumer_blocker(item, state)
                        if blocker:
                            raise RuntimeError(blocker)
                    job = self._update(key, status='running', stage='preparing', helpers={},
                                       install_started_at=int(time.time() * 1000))
            if job['stage'] not in ('preparing', 'prepared', 'validating', 'validated', 'activating'):
                # Never replay a legacy installing job using the new protocol.
                self._update(key, status='recovery_required', stage='installation_outcome_unknown')
                return
            if job['stage'] == 'preparing':
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return
            if job['stage'] == 'prepared':
                checked_candidate(job.get('candidate'), job['release'])
                job = self._update(key, stage='validating')
            if job['stage'] == 'validated':
                checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
                job = self._update(key, stage='activating')
            phase = {'preparing': 'prepare', 'validating': 'validate', 'activating': 'activate'}[job['stage']]
            result = self._drive_helper(job, phase)
            if result.get('state') in ('running', 'waiting'):
                return
            if result.get('state') == 'failed':
                self._update(key, status='failed', stage=result.get('stage', 'install_failed'))
            elif result.get('state') == 'succeeded' and result.get('version') == job['version']:
                # The result is observed after a side effect; recheck the
                # policy/profile before accepting it as durable authority.
                self._fence(self._get(key))
                if phase == 'prepare':
                    checked_candidate(result.get('candidate'), job['release'])
                    self._update(key, stage='prepared', candidate=result['candidate'])
                elif phase == 'validate':
                    checked_evidence(result.get('evidence'), job['candidate'], job['release'], job['profile'])
                    self._update(key, stage='validated', evidence=result['evidence'])
                else:
                    self._update(key, stage='refreshing', installed_version=job['version'])
            else:
                self._update(key, status='recovery_required', stage='installation_outcome_unknown')
        except Exception:
            with self.store.lock:
                latest = self._get(key)
                if latest['status'] not in ('queued', 'running'):
                    return
                self._update(key, status='failed' if latest['status'] == 'queued' else 'recovery_required',
                             stage='unmanaged_or_unavailable_consumer' if latest['status'] == 'queued'
                             else 'installation_outcome_unknown')

    def _state_key(self, item, state):
        return fingerprint({'state': state, 'target': self.gate.lifecycle._target_hash(item)})

    def _enqueue(self, parent, item, state, targets, target):
        if terminal_profile(item):
            raise RuntimeError('terminal_profile_unaudited')
        life, key = self.gate.lifecycle, secrets.token_hex(16)
        child = {**{k: state[k] for k in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                 'id': key, 'status': 'queued', 'stage': 'runtime_update_refresh',
                 'policy': parent['policy'], 'container_id': item['Id'], 'old_version': state['version'],
                 'target_hash': life._target_hash(item), 'created_at': int(time.time() * 1000),
                 'runtime_update_id': parent['id'], 'requested_version': parent['version']}
        child['source_hash'] = self.source_proof(parent, item, state)['source_hash']
        with self.store.lock, self.store._write_transaction():
            self.store.require_admission()
            if len(life._jobs()) >= 1000:
                raise RuntimeError('lifecycle quota')
            target.update(status='refreshing', restart_id=key,
                          attempt_state=self._state_key(item, state), attempts=target.get('attempts', 0) + 1)
            target.pop('wait_reason', None)
            target.pop('retry_after_state', None)
            parent = self._get(parent['id'])
            parent.update(targets=targets, stage='refreshing')
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(parent), parent['id']))
            self.store.db.execute('INSERT INTO lifecycle_jobs (id,data) VALUES (?,?)', (key, _json(child)))

    def _target_adoption(self, job, target, item, state, child):
        """A verified child may nominate bytes for probing, never grant a proof."""
        checked_source_image(job, item)
        identity = checked_source(state.get('source_identity'), state.get('version'))
        if (child.get('status') != 'succeeded' or child.get('runtime_update_id') != job['id'] or
                child.get('policy') != job['policy'] or target.get('restart_id') != child['id'] or
                child.get('container_id') != item['Id'] or target['container_id'] != item['Id'] or
                child.get('target_hash') != self.gate.lifecycle._target_hash(item) or
                child.get('run_id') != state.get('run_id') or target['run_id'] != state.get('run_id') or
                child.get('requested_version') != job['version'] or
                child.get('expected_version') != job['version'] or child.get('new_version') != job['version'] or
                state['version'] != job['version'] or not child.get('new_runtime_id') or
                child['new_runtime_id'] == child.get('runtime_id') or
                child.get('old_runtime_id') != child.get('runtime_id') or
                child['new_runtime_id'] != state.get('runtime_id') or
                child.get('session_id') != state.get('session_id') or child.get('leaf_id') != state.get('leaf_id')):
            raise RuntimeError('target source adoption identity changed')
        old = job.get('sources', {}).get(child.get('source_hash'), {})
        if (not isinstance(old.get('identity'), dict) or
                digest(old['identity']) != child.get('source_hash') or
                old['identity']['version'] != child.get('old_version')):
            raise RuntimeError('target source adoption lacks original source proof')
        checked_source_evidence(old.get('evidence'), old['identity'], job['profile'])
        adoption = {'restart_id': child['id'], 'container_id': item['Id'],
                    'target_hash': child['target_hash'], 'runtime_id': state['runtime_id'],
                    'session_id': state['session_id'], 'leaf_id': state['leaf_id'],
                    'source_hash': digest(identity), 'profile_hash': digest(job['profile'])}
        if target.get('source_adoption', adoption) != adoption:
            raise RuntimeError('target source adoption changed')
        return adoption

    def _confirmed_target_exit(self, target):
        """Inspect the saved immutable ID; filtered inventory absence is not exit."""
        life, container_id = self.gate.lifecycle, target.get('container_id')
        item = life._transport(Deadline(time, 4), life._engine().inspect, container_id)
        if item is None:
            return True
        if not isinstance(item, dict) or item.get('Id') != container_id:
            raise RuntimeError('target exit identity changed')
        config = item.get('Config')
        labels = config.get('Labels') if isinstance(config, dict) else None
        if not isinstance(labels, dict) or labels.get('cn.swordfate.pi.run-id') != target.get('run_id'):
            raise RuntimeError('target exit identity changed')
        expected_hash = None
        adoption = target.get('source_adoption')
        if adoption is not None:
            if (not isinstance(adoption, dict) or adoption.get('container_id') != container_id or
                    adoption.get('restart_id') != target.get('restart_id')):
                raise RuntimeError('target exit identity changed')
            expected_hash = adoption.get('target_hash')
        restart = target.get('restart_id')
        if restart is not None:
            child = life._get(restart)
            if (child.get('container_id') != container_id or
                    child.get('run_id') != target.get('run_id')):
                raise RuntimeError('target exit identity changed')
            if expected_hash is not None and child.get('target_hash') != expected_hash:
                raise RuntimeError('target exit identity changed')
            expected_hash = child.get('target_hash')
        if expected_hash is not None and life._target_hash(item) != expected_hash:
            raise RuntimeError('target exit identity changed')
        state = item.get('State')
        if (not isinstance(state, dict) or not isinstance(state.get('Status'), str) or
                type(state.get('Running')) is not bool):
            raise RuntimeError('target exit state unavailable')
        return state['Running'] is False and state['Status'] in ('exited', 'dead')

    def _refresh(self, job):
        key, targets = job['id'], job['targets']
        try:
            self._fence(job)
            checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
            current = self._inventory(job)
            visible = {item['Id'] for item, _ in current}
            by_container = {item['Id']: (item, state) for item, state in current}
            exit_checked = set()
            # Reconcile lifecycle evidence before considering another restart.
            for target in targets:
                restart = target.get('restart_id')
                if restart and target['status'] in ('refreshing', 'validating_source'):
                    child = self.gate.lifecycle._get(restart)
                    if child['status'] == 'succeeded':
                        if child.get('new_version') != job['version']:
                            raise RuntimeError('runtime version proof mismatch')
                        pair = by_container.get(target['container_id'])
                        if pair is not None and pair[1] is not None:
                            adoption = self._target_adoption(job, target, *pair, child)
                            target.update(status='validating_source', source_adoption=adoption,
                                          wait_reason='target_source_validation')
                        elif pair is not None:
                            target.update(status='validating_source', wait_reason='consumer_not_ready')
                        else:
                            exit_checked.add(target['container_id'])
                            if self._confirmed_target_exit(target):
                                target.update(status='exited')
                            else:
                                target.update(status='validating_source', wait_reason='consumer_not_ready')
                    elif child['status'] == 'stale':
                        if child['stage'] == 'restore_pre_stop_failed':
                            target.update(status='blocked', wait_reason='restore_pre_stop_failed')
                            self._update(key, targets=targets, status='recovery_required',
                                         stage='restore_pre_stop_failed')
                            return
                        target.update(status='waiting_for_idle', wait_reason='awaiting_state_change',
                                      retry_after_state=target.get('attempt_state'))
                        target.pop('restart_id', None)
                    elif child['status'] in ('failed', 'recovery_required'):
                        pair = by_container.get(target['container_id'])
                        if (child['status'] == 'failed' and child['stage'] in ('checking_rejected', 'checking_timeout')
                                and pair and pair[1] is not None):
                            item, state = pair
                            observed = self.gate.lifecycle._status(item)
                            state = snapshot(observed, child['run_id'])
                            self.source_proof(job, item, state)
                            by_container[item['Id']] = (item, state)
                            operation = observed.get('operation') or {}
                            if (state['runtime_id'] == child['runtime_id'] and
                                    (not state['idle'] or state['pending'] or state['busy']) and
                                    operation.get('operation_id') == child['id'] and
                                    operation.get('status') == 'failed' and operation.get('stage') == child['stage'] and
                                    not operation.get('new_runtime_id') and not operation.get('old_version')):
                                self.gate.lifecycle._update(child['id'], resolved_at=int(time.time() * 1000),
                                                            resolution='runtime_pre_stop_retry')
                                target.update(status='waiting_for_idle', wait_reason='busy_race',
                                              retry_after_state=self._state_key(item, state))
                                target.pop('restart_id', None)
                                continue
                        # Never repeat a restart with unknown or post-stop outcome.
                        self._update(key, targets=targets, status='recovery_required', stage='refresh_requires_inspection')
                        return
                if (target['container_id'] not in visible and
                        target['status'] not in ('succeeded', 'exited') and
                        target['container_id'] not in exit_checked and
                        self._confirmed_target_exit(target)):
                    target.update(status='exited')
            current = list(by_container.values())  # Include the latest retry-proof snapshot.
            # Only a successful, identity-matched child can nominate an unknown
            # postactivation source. Persist its exact adoption before creating
            # the ordinary source helper; unknown unrelated consumers still fail.
            pending = []
            for item, state in current:
                if state is None:
                    continue
                try:
                    self.source_proof(job, item, state)
                except (ValueError, RuntimeError):
                    target = next((t for t in targets if t['container_id'] == item['Id']), None)
                    if not target or target['status'] != 'validating_source' or not target.get('source_adoption'):
                        raise
                    self._target_adoption(job, target, item, state,
                                          self.gate.lifecycle._get(target['restart_id']))
                    pending.append((item, state))
            adopting = [t for t in targets if t['status'] == 'validating_source']
            outstanding = any('evidence' not in record for record in job.get('sources', {}).values())
            if adopting or outstanding:
                job = self._update(key, targets=targets, stage='refreshing')
                if any(t['container_id'] not in by_container or
                       by_container[t['container_id']][1] is None for t in adopting):
                    if outstanding:
                        # Readiness gates adoption, not already durable offline work.
                        # Empty inventory reconciles saved sources without nominating any new one.
                        self._ensure_sources(job, [])
                    return
                if pending or outstanding:
                    self._ensure_sources(job, pending)
                    # Even immediate success gets a fresh worker-pass inventory
                    # and adoption check before another child or completion.
                    return
                for target in adopting:
                    target.update(status='succeeded', version=job['version'])
                    target.pop('wait_reason', None)
            attempts = {t['container_id']: t.get('attempts', 0) for t in targets}
            for item, state in sorted(current, key=lambda pair: attempts.get(pair[0]['Id'], 0)):
                target = next((t for t in targets if t['container_id'] == item['Id']), None)
                if target is None:
                    target = {'run_id': item['Config']['Labels']['cn.swordfate.pi.run-id'],
                              'container_id': item['Id'], 'status': 'waiting_for_idle'}
                    targets.append(target)
                if state is None:
                    target.update(status='waiting_for_idle', wait_reason='consumer_not_ready')
                    continue
                if terminal_profile(item):
                    target.update(status='manual_restart_required', profile='web-terminal-v1',
                                  wait_reason='terminal_profile_unaudited')
                    for field in ('old_version', 'version', 'restart_id'):
                        target.pop(field, None)
                    continue
                target.setdefault('old_version', state['version'])
                if (target.get('retry_after_state') is not None and
                        target['retry_after_state'] != self._state_key(item, state)):
                    target.pop('retry_after_state', None)
                if state['version'] == job['version']:
                    target.update(status='succeeded', version=job['version'])
                    continue
                if target['status'] == 'succeeded':
                    target.update(status='waiting_for_idle')
                if state['idle'] and not state['pending'] and not state['busy']:
                    if target.get('retry_after_state') == self._state_key(item, state):
                        target.update(status='waiting_for_idle', wait_reason='awaiting_state_change')
                        continue
                    self._enqueue(job, item, state, targets, target)
                    return
                target.update(status='waiting_for_idle')
            complete = all(t['status'] in ('succeeded', 'exited', 'manual_restart_required') for t in targets)
            manual = any(t['status'] == 'manual_restart_required' for t in targets)
            self._update(key, targets=targets,
                         status=('manual_restart_required' if manual else 'succeeded') if complete else 'running',
                         stage=('installed_manual_restart_required' if manual else 'complete') if complete else 'waiting_for_idle')
        except Exception:
            self._update(key, targets=targets, status='recovery_required', stage='refresh_requires_inspection')

    def _resolution_ready(self, job):
        self.store.require_admission()
        if (job['status'] != 'recovery_required' or job.get('resolved_at') or
                self.gate.closing or (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list()) or
                any(j['id'] != job['id'] for j in self.active())):
            raise RuntimeError('runtime inspection not eligible')
        if self.gate.lifecycle.active():
            # Even this parent's failed children must be individually inspected.
            raise RuntimeError('unresolved lifecycle work')

    def resolve(self, key, acknowledge):
        if acknowledge != 'inspected_no_mutation':
            raise ValueError('explicit inspection acknowledgment required')
        with self.store.lock:
            job = self._get(key)
            self._resolution_ready(job)
            children = self.gate.lifecycle._jobs()
        self._engine().quiescent(job)
        for item, state in self._inventory(job):
            if terminal_profile(item):
                continue  # No legacy operation endpoint exists for this role.
            if state is None:
                raise RuntimeError('consumer inspection unavailable')
            value = self.gate.lifecycle._status(item)
            if (value.get('operation') or {}).get('status') == 'running':
                raise RuntimeError('supervisor operation still running')
        with self.store.lock, self.store._write_transaction():
            if self._get(key) != job or self.gate.lifecycle._jobs() != children:
                raise RuntimeError('inspection state changed')
            self._resolution_ready(job)
            job.update(resolved_at=int(time.time() * 1000), resolution=acknowledge)
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(job), key))
            self.store._append_event('runtime_resolved', 'pi-runtime', request=key, outcome=job['status'])
            return self.public(job)

"""Durable, independent Pi child lifecycle authorization; never container restart."""
import json
import threading
import time

from .lifecycle_contract import (IMAGE, IDENTITIES, OPEN, OP_STATES, STAGE,
                                 identifier, public, ready, restart_request, result,
                                 snapshot, text, timestamp, trusted)
from .registry import fingerprint
from .store import ACTIVE, _json


class Deadline:
    """A fixed monotonic cap, optionally also bounded by persisted wall time."""
    def __init__(self, clock, seconds, wall_end=None, parent=None):
        self.clock, self.wall_end, self.parent = clock, wall_end, parent
        self.end = clock.monotonic() + seconds

    def remaining(self):
        remaining = self.end - self.clock.monotonic()
        if self.wall_end is not None:
            remaining = min(remaining, self.wall_end - self.clock.time())
        if self.parent is not None:
            remaining = min(remaining, self.parent.remaining())
        if remaining <= 0:
            raise RuntimeError('lifecycle deadline exceeded')
        return remaining


class Lifecycle:
    def __init__(self, gate, engine=None, clock=None):
        self.gate, self.store, self.engine = gate, gate.store, engine
        self.clock = clock or time

    def _execution_deadline(self, job):
        wall_end = timestamp(job['started_at']) / 1000 + 210
        return Deadline(self.clock, max(0, min(210, wall_end - self.clock.time())), wall_end)

    def policy(self):
        with self.store.lock:
            return json.loads(self.store.db.execute('SELECT data FROM lifecycle_policy WHERE id=1').fetchone()[0])

    def set_policy(self, value):
        if (not isinstance(value, dict) or set(value) != {'mode', 'images'} or
                value['mode'] not in ('disabled', 'manual', 'auto') or
                not isinstance(value['images'], list) or len(value['images']) > 64 or
                any(not isinstance(v, str) or not IMAGE.fullmatch(v) for v in value['images'])):
            raise ValueError('invalid lifecycle policy')
        definition = {'mode': value['mode'], 'images': sorted(set(value['images']))}
        with self.store.lock, self.store._write_transaction():
            old = self.policy()
            if all(old[k] == definition[k] for k in definition):
                return old
            policy = {**definition, 'generation': old['generation'] + 1}
            policy['policy_hash'] = fingerprint(policy)
            self.store.db.execute('UPDATE lifecycle_policy SET data=? WHERE id=1', (_json(policy),))
            self.store._append_event('lifecycle_policy', 'pi-lifecycle', mode=policy['mode'], generation=policy['generation'])
            return policy

    def _get(self, key):
        identifier(key)
        with self.store.lock:
            row = self.store.db.execute('SELECT data FROM lifecycle_jobs WHERE id=?', (key,)).fetchone()
            if not row:
                raise KeyError('lifecycle job not found')
            return json.loads(row[0])

    def get(self, key):
        return public(self._get(key))

    def _jobs(self):
        with self.store.lock:
            return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM lifecycle_jobs ORDER BY rowid DESC')]

    def jobs(self):
        return [public(j) for j in self._jobs()]

    def active(self):
        return [public(j) for j in self._jobs() if j['status'] in OPEN and not j.get('resolved_at')]

    def _update(self, key, **fields):
        with self.store.lock, self.store._write_transaction():
            job = self._get(key)
            if 'started_at' in fields:
                timestamp(fields['started_at'])
                if 'started_at' in job and fields['started_at'] != job['started_at']:
                    raise RuntimeError('immutable lifecycle timestamp')
                if 'started_at' not in job and not (job['status'] in ('pending', 'queued') and fields.get('status') == 'running'):
                    raise RuntimeError('timestamp requires running transition')
            job.update(fields)
            public(job)
            self.store.db.execute('UPDATE lifecycle_jobs SET data=? WHERE id=?', (_json(job), key))
            return job

    def _engine(self):
        engine = self.engine or getattr(self.gate.deployer, 'engine', None)
        if engine is None:
            raise RuntimeError('lifecycle unavailable')
        return engine

    @staticmethod
    def _target_hash(item):
        mounts = item.get('Mounts')
        if isinstance(mounts, list):
            # Inspect mount order is not identity. Keep every full entry (including
            # duplicates); do not mutate input or normalize any nested/other lists.
            mounts = sorted(mounts, key=_json)
        return fingerprint({**{k: item.get(k) for k in ('Id', 'Image', 'Config', 'HostConfig')},
                            'Mounts': mounts,
                            'started': item.get('State', {}).get('StartedAt')})

    def _resolve(self, run, policy, expected=None, deadline=None, expected_hash=None, role='restart'):
        engine = self._engine()
        candidates = self._transport(deadline, engine.list_terminal if role == 'terminal' else engine.list_lifecycle, run)
        if not isinstance(candidates, list) or len(candidates) != 1:
            raise RuntimeError('ambiguous or unavailable target')
        key = candidates[0].get('Id')
        from .lifecycle_contract import CONTAINER
        if not isinstance(key, str) or not CONTAINER.fullmatch(key) or (expected is not None and key != expected):
            raise RuntimeError('target changed')
        item = trusted(self._transport(deadline, engine.inspect, key), run, policy['images'], role=role,
                       runtime_volume=self.gate.runtime_volume)
        for mount in item.get('Mounts') or []:
            if mount.get('Type') == 'volume':
                volume = self._transport(deadline, engine.lifecycle_volume, mount['Name'])
                if (not volume or volume.get('Name') != mount['Name'] or volume.get('Driver') != 'local' or
                        volume.get('Scope', 'local') != 'local' or volume.get('Options') or
                        mount.get('Driver') != 'local' or mount.get('Source') != volume.get('Mountpoint')):
                    raise RuntimeError('untrusted lifecycle volume')
        if item['Id'] != key or (expected_hash is not None and self._target_hash(item) != expected_hash):
            raise RuntimeError('target changed')
        return item

    @staticmethod
    def _remaining(deadline):
        return 3.0 if deadline is None else min(3.0, deadline.remaining())

    def _transport(self, deadline, call, *args):
        step = Deadline(self.clock, 3, parent=deadline)
        value = call(*args, timeout=self._remaining(step))
        step.remaining()
        return value

    def _status(self, item, deadline=None):
        return result(self._transport(deadline, self._engine().lifecycle_control, item['Id'], {'action': 'status'}))

    def target(self, run):
        identifier(run)
        policy = self.policy()
        deadline = Deadline(self.clock, 4)
        try:
            item = self._resolve(run, policy, deadline=deadline)
            value = snapshot(self._status(item, deadline), run)
            try:
                self.gate.runtime_updates.restart_evidence(policy, item, value)
            except (KeyError, TypeError, ValueError, RuntimeError):
                return {'managed': False, 'reason': 'source_evidence_unavailable'}
            deadline.remaining()
            if self.policy()['policy_hash'] != policy['policy_hash']:
                return {'managed': False}
            return {**value, 'mode': policy['mode']}
        except Exception:
            return {'managed': False}

    def _deployment_busy(self):
        return (self.gate.closing or self.gate.runtime_updates.active() or self.store.upgrade_reservation() or (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in ACTIVE for j in self.store.list()))

    def submit(self, value):
        value = restart_request(value)
        key = value['idempotency_key']
        with self.store.lock:
            self.store.require_admission()
            try:
                previous = self._get(key)
            except KeyError:
                previous = None
            if previous:
                if any(previous[k] != value[k] for k in IDENTITIES):
                    raise RuntimeError('idempotency conflict')
                return public(previous)
            policy = self.policy()
            if policy['mode'] == 'disabled' or self._deployment_busy():
                raise RuntimeError('lifecycle disabled or busy')
            jobs = self._jobs()
            if any(j['status'] in OPEN and not j.get('resolved_at') and
                   (j['run_id'] == value['run_id'] or j['status'] in ('failed', 'recovery_required')) for j in jobs):
                raise RuntimeError('lifecycle conflict')
            if len(jobs) >= 1000 or len(self.active()) >= 8:
                raise RuntimeError('lifecycle quota')
        deadline = Deadline(self.clock, 4)
        item = self._resolve(value['run_id'], policy, deadline=deadline)
        state = snapshot(self._status(item, deadline), value['run_id'])
        ready(state, value)
        evidence = self.gate.runtime_updates.restart_evidence(policy, item, state)
        deadline.remaining()
        with self.store.lock:
            # Repeat admission after blocking inspection; concurrent submissions dedup here.
            self.store.require_admission()
            try:
                previous = self._get(key)
            except KeyError:
                previous = None
            if previous:
                if any(previous[k] != value[k] for k in IDENTITIES):
                    raise RuntimeError('idempotency conflict')
                return public(previous)
            if self._deployment_busy() or self.policy()['policy_hash'] != policy['policy_hash']:
                raise RuntimeError('authorization changed')
            if len(self._jobs()) >= 1000 or len(self.active()) >= 8 or any(
                    j['run_id'] == value['run_id'] or j['status'] in ('failed', 'recovery_required') for j in self.active()):
                raise RuntimeError('lifecycle conflict')
            job = {**{k: value[k] for k in IDENTITIES}, 'id': key,
                   'status': 'queued' if policy['mode'] == 'auto' else 'pending',
                   'stage': 'queued_by_policy' if policy['mode'] == 'auto' else 'awaiting_approval',
                   'policy': policy, 'container_id': item['Id'], 'old_version': state['version'],
                   'target_hash': self._target_hash(item),
                   'created_at': int(self.clock.time() * 1000)}
            from .runtime_install import digest
            job.update(runtime_evidence_id=evidence['id'], requested_version=evidence['version'],
                       source_hash=digest(state['source_identity']),
                       evidence_profile_hash=digest(evidence['profile']))
            with self.store._write_transaction():
                self.store.db.execute('INSERT INTO lifecycle_jobs (id,data) VALUES (?,?)', (key, _json(job)))
            return public(job)

    def approve(self, key):
        with self.store.lock:
            job = self._get(key)
            if job['status'] != 'pending' or self._deployment_busy():
                raise RuntimeError('lifecycle not eligible')
            self._policy_fence(job)
            if any(j['id'] != key and j['status'] in ('failed', 'recovery_required') for j in self.active()):
                raise RuntimeError('inspection required')
            return public(self._update(key, status='queued', stage='approved_by_host'))

    def reject(self, key):
        with self.store.lock:
            job = self._get(key)
            if job['status'] not in ('pending', 'queued'):
                raise RuntimeError('cannot reject started lifecycle')
            return public(self._update(key, status='rejected', stage='host_rejected'))

    def _policy_fence(self, job):
        self.store.require_admission()
        if job.get('runtime_update_id'):
            self.gate.runtime_updates.authorize_child(job)
            return
        current = self.policy()
        if current['mode'] == 'disabled' or current['policy_hash'] != job['policy']['policy_hash']:
            raise RuntimeError('policy changed')
        self.gate.runtime_updates.authorize_restart(job)

    def recover(self):
        # No control call here. tick dispatches status-only reconciliation off the HTTP thread.
        with self.store.lock:
            if self.store.upgrade_reservation():
                return
            for job in self._jobs():
                if job['status'] == 'queued' and not job.get('runtime_update_id'):
                    self._update(job['id'], status='stale', stage='interrupted_before_start')
                elif job['status'] == 'running' and not job.get('intent_at'):
                    if job.get('restore_intent_at'):
                        # The worker reconciles private helper/capture state.
                        # Startup holds the ledger lock: no daemon I/O here.
                        self._update(job['id'], stage='restore_recovery_pending')
                    else:
                        self._update(job['id'], status='stale', stage='interrupted_before_intent')

    def tick(self):
        # Caller holds Store RLock and has checked the one shared worker slot.
        if self.store.upgrade_reservation():
            return True
        jobs = self._jobs()
        if any(j['status'] in ('failed', 'recovery_required') and not j.get('resolved_at') for j in jobs):
            return bool(self.active())
        for job in reversed(jobs):
            if job['status'] == 'running':
                if job.get('restore_intent_at') and not job.get('intent_at'):
                    from .runtime_restore import reconcile_interrupted
                    target, args = reconcile_interrupted, (self, job)
                else:
                    target, args = self._poll, (job,)
            elif job['status'] == 'queued':
                try:
                    self._policy_fence(job)
                except RuntimeError:
                    self._update(job['id'], status='stale', stage='policy_changed_before_dispatch')
                    continue
                # Reserve the shared worker using persisted running state before dispatch.
                job = self._update(job['id'], status='running', stage='validating',
                                   started_at=int(self.clock.time() * 1000))
                target, args = self._execute, (job,)
            else:
                continue
            self.gate.worker = threading.Thread(target=target, args=args, daemon=False)
            self.gate.worker.start()
            return True
        return bool(self.active())

    def _execute(self, job):
        key, intent = job['id'], False
        try:
            outer = self._execution_deadline(job)
            deadline = Deadline(self.clock, 4, parent=outer)
            with self.store.lock:
                self._policy_fence(job)
            item = self._resolve(job['run_id'], job['policy'], job['container_id'], deadline, job['target_hash'])
            state = snapshot(self._status(item, deadline), job['run_id'])
            ready(state, job)
            if state['version'] != job['old_version']:
                raise RuntimeError('version changed')
            if job.get('runtime_update_id') or job.get('runtime_evidence_id'):
                from .runtime_restore import prepare_refresh
                job = prepare_refresh(self, job, item, state, outer)
                # Restoration has its own bounded offline window; repeat the
                # short live-identity fence immediately before restart intent.
                deadline = Deadline(self.clock, 4, parent=outer)
            # Reinspect after status, immediately before authorization/exec; immutable ID only.
            self._resolve(job['run_id'], job['policy'], job['container_id'], deadline, job['target_hash'])
            with self.store.lock:
                self._policy_fence(job)
                deadline.remaining()
                job = self._update(key, stage='restart_intent', intent_at=int(self.clock.time() * 1000))
                intent = True
            deadline.remaining()
            request = {**{k: job[k] for k in IDENTITIES}, 'action': 'restart', 'operation_id': key}
            if job.get('restore_proof') is not None:
                request['restore_proof'] = job['restore_proof']
            acknowledgment = Deadline(self.clock, 3, parent=outer)
            ack = result(self._engine().lifecycle_control(job['container_id'], request,
                                                        timeout=self._remaining(acknowledgment)))
            acknowledgment.remaining()
            self._operation_header(ack, key)
            self._update(key, stage=ack['stage'])
        except Exception:
            saved = self._get(key)
            restore_failed = not intent and bool(saved.get('restore_intent_at'))
            if restore_failed:
                try:
                    self._engine().lifecycle_control(job['container_id'], {'action':'cancel_restore',
                        'run_id':job['run_id'], 'operation_id':key}, timeout=3)
                except Exception:
                    pass
            self._update(key, status='recovery_required' if intent else 'stale',
                         stage='control_outcome_unknown' if intent else
                         ('restore_pre_stop_failed' if restore_failed else 'execution_precondition_changed'))
            return
        self._poll(job, outer)

    @staticmethod
    def _operation_header(operation, key):
        if (not isinstance(operation, dict) or operation.get('operation_id') != key or
                operation.get('status') not in OP_STATES or not isinstance(operation.get('stage'), str) or
                not STAGE.fullmatch(operation['stage'])):
            raise RuntimeError('invalid operation')

    def _consume(self, job, value):
        operation = value.get('operation')
        self._operation_header(operation, job['id'])
        # Even checking has these identities; none may silently change in later polls.
        if (operation.get('old_runtime_id') != job['runtime_id'] or
                operation.get('session_id') != job['session_id'] or
                'leaf_id' not in operation or operation['leaf_id'] != job['leaf_id']):
            raise RuntimeError('operation identity changed')
        fields = {}
        for key in ('old_runtime_id', 'new_runtime_id', 'old_version', 'expected_version', 'new_version'):
            if key in operation:
                fields[key] = text(operation[key])
        if 'old_version' in fields and fields['old_version'] != job['old_version']:
            raise RuntimeError('old version mismatch')
        saved = self._get(job['id'])
        if 'expected_version' in saved and fields.get('expected_version', saved['expected_version']) != saved['expected_version']:
            raise RuntimeError('expected version changed')
        status = operation['status']
        if ('requested_version' in job and 'expected_version' in fields and
                fields['expected_version'] != job['requested_version']):
            raise RuntimeError('runtime update target version changed')
        if status == 'succeeded':
            for name in ('old_runtime_id', 'new_runtime_id', 'old_version', 'expected_version', 'new_version'):
                text(operation.get(name))
            state = snapshot(value, job['run_id'])
            if (operation['new_runtime_id'] == job['runtime_id'] or operation['new_version'] != operation['expected_version'] or
                    state['runtime_id'] != operation['new_runtime_id'] or state['version'] != operation['new_version'] or
                    state['session_id'] != job['session_id'] or state['leaf_id'] != job['leaf_id']):
                raise RuntimeError('readiness mismatch')
        self._update(job['id'], status=status, stage=operation['stage'], **fields)
        return status != 'running'

    def _poll(self, job, deadline=None):
        # Persisted wall timestamp survives crash; monotonic cap handles clock changes during this worker.
        try:
            deadline = deadline or self._execution_deadline(job)
            while True:
                deadline.remaining()
                item = self._resolve(job['run_id'], job['policy'], job['container_id'], deadline, job['target_hash'])
                value = self._status(item, deadline)
                deadline.remaining()
                if self._consume(job, value):
                    return
                self.clock.sleep(min(0.25, deadline.remaining()))
        except Exception:
            pass
        self._update(job['id'], status='recovery_required', stage='control_outcome_unknown')

    def resolve(self, key, runtime_id, acknowledge):
        """Explicit host inspection receipt; retain failed/unknown outcome, never invent success."""
        text(runtime_id)
        if acknowledge != 'inspected_no_retry':
            raise ValueError('explicit inspection acknowledgment required')
        with self.store.lock:
            job = self._get(key)
            if job['status'] not in ('failed', 'recovery_required') or job.get('resolved_at') or self._resolution_busy(job):
                raise RuntimeError('not eligible for inspection resolution')
        deadline = Deadline(self.clock, 4)
        exited = False
        if job.get('runtime_update_id'):
            item = self._transport(deadline, self._engine().inspect, job['container_id'])
            exited = item is None or (item.get('Id') == job['container_id'] and
                                      item.get('State', {}).get('Running') is False)
        if exited:
            if runtime_id not in (job['runtime_id'], job.get('new_runtime_id')):
                raise RuntimeError('unknown inspected runtime identity')
        else:
            item = self._resolve(job['run_id'], job['policy'], job['container_id'], deadline, job['target_hash'])
            value = self._status(item, deadline)
            state = snapshot(value, job['run_id'])
            if (state['runtime_id'] != runtime_id or state['session_id'] != job['session_id'] or
                    state['leaf_id'] != job['leaf_id'] or not state['idle'] or state['pending'] or state['busy'] or
                    (value.get('operation') or {}).get('status') == 'running'):
                raise RuntimeError('inspection state mismatch')
        with self.store.lock:
            if self._get(key) != job or self._resolution_busy(job):
                raise RuntimeError('inspection state changed')
            # Receipt and release must be atomic; original status and stage are retained.
            with self.store._write_transaction():
                job.update(resolved_at=int(self.clock.time() * 1000), resolution='host_inspected_no_retry',
                           inspected_runtime_id=runtime_id)
                if exited:
                    job['inspected_target_exited'] = True
                self.store.db.execute('UPDATE lifecycle_jobs SET data=? WHERE id=?', (_json(job), key))
                self.store._append_event('lifecycle_resolved', 'pi-lifecycle', request=key,
                                         outcome=job['status'], runtime_id=runtime_id)
            return {**public(job), 'resolved': True}

    def _resolution_busy(self, job):
        parent_id = job.get('runtime_update_id')
        if not parent_id:
            return self._deployment_busy()
        parent = self.gate.runtime_updates._get(parent_id)
        return (parent['status'] != 'recovery_required' or self.gate.closing or
                self.store.upgrade_reservation() or (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in (*ACTIVE, 'pending', 'queued') for j in self.store.list()) or
                any(j['id'] != parent_id for j in self.gate.runtime_updates.active()) or
                any(j['id'] != job['id'] and (j.get('runtime_update_id') != parent_id or
                    j['status'] in ('pending', 'queued', 'running')) for j in self._jobs()
                    if j['status'] in OPEN and not j.get('resolved_at')))

import argparse
import fcntl
import hmac
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import socketserver
import stat
import threading
import time
from urllib.parse import urlsplit, parse_qs

from .errors import PreconditionChanged
from .runtime_catalog import RegistryUnavailable
from .store import ACTIVE, REQUEST_OPEN, _json, check_sha, public


class Gate:
    def __init__(self, directory, deployer=None, policy=None, head_resolver=None, *, runtime_volume='pi-runtime',
                 launch_policy=None, launch_engine=None):
        from .runtime_engine import runtime_volume as checked_volume
        self.runtime_volume = checked_volume(runtime_volume)
        os.umask(0o077)
        self.directory = directory
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink():
            raise ValueError('state directory cannot be a symlink')
        self.lease = open(directory / 'gate.lock', 'a')
        fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        from .pi_launches import LaunchStore
        self.store = LaunchStore(directory)
        tokenfile = directory / 'request.token'
        if not tokenfile.exists():
            fd = os.open(tokenfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(secrets.token_hex(32))
        if not stat.S_ISREG(tokenfile.lstat().st_mode) or tokenfile.stat().st_mode & 0o077:
            raise ValueError('unsafe request token file')
        self.token = tokenfile.read_text().strip()
        if len(self.token) != 64 or any(c not in '0123456789abcdef' for c in self.token):
            raise ValueError('invalid request token')
        lifecycle_tokenfile = directory / 'lifecycle.token'
        try:
            fd = os.open(lifecycle_tokenfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w') as stream:
                stream.write(secrets.token_hex(32))
                stream.flush()
                os.fsync(stream.fileno())
        fd = os.open(lifecycle_tokenfile, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'r') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                raise ValueError('unsafe lifecycle token file')
            self.lifecycle_token = stream.read(65)
        if (len(self.lifecycle_token) != 64 or any(c not in '0123456789abcdef' for c in self.lifecycle_token) or
                self.lifecycle_token == self.token):
            raise ValueError('invalid lifecycle token')
        from .hub_management import credential
        self.hub_management_token = credential(directory, (self.token, self.lifecycle_token))
        self.deployer = deployer
        self.worker = None
        self.policy = policy
        self.closing = False
        self.terminal_server = None
        self.instance_id = secrets.token_hex(16)
        from .lifecycle import Lifecycle
        self.lifecycle = Lifecycle(self)
        from .runtime_updates import RuntimeUpdates
        self.runtime_updates = RuntimeUpdates(self)
        from .sources import fetch_head
        self.head_resolver = head_resolver or fetch_head
        if policy is not None:
            self.store.bootstrap(policy)
        from .hub_management import HubManagement
        self.hub_management = HubManagement(self)
        from .pi_launches import PiLaunches
        self.pi_launches = PiLaunches(self, launch_policy, launch_engine)
        self.store.launch_fence = lambda: self.pi_launches.busy()

    def close(self):
        self.closing = True
        if self.terminal_server is not None:
            self.terminal_server.close()
            self.terminal_server = None
        if self.worker:
            self.worker.join(timeout=35 if self.worker.name == 'pi-launch' else 540)
            if self.worker.is_alive():
                raise RuntimeError('deployment still active; leave state open for recovery')
        self.store.close()
        self.lease.close()

    def upgrade_status(self):
        return {'reservation': self.store.upgrade_reservation(), 'instance_id': self.instance_id}

    def terminal_preflight(self, value):
        """Read the live provider's frozen policy, never disk or Engine state."""
        from .lifecycle_contract import IMAGE
        exact(value, ('image',))
        image = value['image']
        if not isinstance(image, str) or not IMAGE.fullmatch(image):
            raise ValueError('terminal preflight unavailable')
        listener = self.terminal_server
        if (self.closing or listener is None or listener.provider is None or
                listener.server is None or listener.thread is None or not listener.thread.is_alive()):
            raise ValueError('terminal preflight unavailable')
        provider = listener.provider
        with provider.lock:
            if (self.closing or self.terminal_server is not listener or provider.closed or
                    not provider.policy['enabled'] or image not in provider.policy['images'] or
                    listener.server.socket.fileno() < 0):
                raise ValueError('terminal preflight unavailable')
            return {'v': 1, 'profile': 'web-terminal-v1', 'image': image,
                    'instanceId': self.instance_id, 'ready': True}

    def _upgrade_idle(self):
        if (self.closing or (self.worker and self.worker.is_alive()) or self.pi_launches.busy() or self.lifecycle.active() or self.runtime_updates.active() or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list())):
            raise RuntimeError('unresolved work prevents upgrade')

    def reserve_upgrade(self, image):
        from .lifecycle_contract import IMAGE
        if not isinstance(image, str) or not IMAGE.fullmatch(image):
            raise ValueError('immutable upgrade image required')
        with self.store.lock:
            self.store.reconcile_results()
            with self.store._write_transaction():
                self.store.require_admission()
                self._upgrade_idle()
                reservation = {'id': secrets.token_hex(16), 'image': image,
                               'owner_instance': self.instance_id, 'created_at': int(time.time() * 1000)}
                self.store.db.execute('INSERT INTO upgrade_reservation (id,data) VALUES (1,?)', (_json(reservation),))
                self.store._append_event('upgrade_reserved', 'pi-gate', reservation=reservation['id'], image=image)
                return reservation

    def release_upgrade(self, key, action):
        from .lifecycle_contract import identifier
        identifier(key)
        if action not in ('finish', 'abort'):
            raise ValueError('explicit upgrade action required')
        with self.store.lock, self.store._write_transaction():
            reservation = self.store.upgrade_reservation()
            if not reservation or reservation['id'] != key:
                raise RuntimeError('upgrade reservation changed')
            self._upgrade_idle()
            if action == 'finish' and reservation['owner_instance'] == self.instance_id:
                raise RuntimeError('replacement instance not observed')
            self.store._append_event('upgrade_finished' if action == 'finish' else 'upgrade_aborted',
                                     'pi-gate', reservation=key, image=reservation['image'])
            self.store.db.execute('DELETE FROM upgrade_reservation WHERE id=1')
            return {'id': key, 'status': 'finished' if action == 'finish' else 'aborted'}

    def submit(self, value):
        with self.store.lock:
            self.store.require_admission()
            if self.runtime_updates.active():
                raise RuntimeError('runtime update reserves deployment admission')
            if self.policy is None:
                exact(value, ('commit',))
                return self.store.request(value['commit'])
        if not isinstance(value, dict):
            raise ValueError('request must be an object')
        service_id = value.get('service', 'pi-web-hub')
        service = self.store.service(service_id)
        field = 'commit' if service['kind'] == 'hub' else 'image'
        exact(value, (field, 'service') if 'service' in value else (field,))
        automatic = service['mode'] == 'auto' and not service.get('paused')
        stage = None
        if automatic and service['kind'] == 'hub':
            check_sha(value[field])
            try:
                automatic = self.head_resolver(service['source']) == value[field]
                if not automatic:
                    stage = 'manual_required_non_head'
            except Exception:
                automatic, stage = False, 'manual_required_source_unavailable'
        with self.store.lock:
            self.store.require_admission()
            if self.runtime_updates.active():
                raise RuntimeError('runtime update reserves deployment admission')
            if self.closing or self.store.service(service_id)['policy_hash'] != service['policy_hash']:
                raise RuntimeError('policy changed during request validation')
            job = self.store.request_version(service_id, {field: value[field]}, automatic=automatic)
            if stage and job['status'] == 'pending':
                job = self.store.update(job['id'], stage=stage)
            return job

    def verify_execution(self, job, cutover=False):
        invalid = PreconditionChanged if cutover else RuntimeError
        with self.store.lock:
            self.store.require_admission()
            if self.lifecycle.active() or self.runtime_updates.active():
                raise invalid('lifecycle inspection or work is active')
        if 'snapshot' not in job:
            if self.policy is not None and self.store.service(job.get('service', 'pi-web-hub'))['mode'] == 'disabled':
                raise invalid('service disabled')
            return  # Legacy manually approved Hub request.
        with self.store.lock:
            current = self.store.service(job['service'])
            if (current['policy_hash'] != job['policy_hash'] or current['mode'] == 'disabled' or
                    (job.get('automatic') and (current['mode'] != 'auto' or current.get('paused')))):
                raise invalid('service policy changed')
        if job.get('automatic') and job['snapshot']['kind'] == 'hub':
            try:
                head = self.head_resolver(job['snapshot']['source'])
            except Exception as error:
                raise invalid('automatic source validation unavailable') from error
            if head != job['commit']:
                raise invalid('automatic source head changed')
        # Source checks may block: recheck policy after them, under the same lock
        # that private policy updates use. This records the cutover authorization.
        with self.store.lock:
            latest = self.store.service(job['service'])
            self.store.require_admission()
            if latest['policy_hash'] != job['policy_hash'] or latest['mode'] == 'disabled':
                raise invalid('service policy changed')
            if cutover:
                self.store.update(job['id'], stage='cutover_authorized',
                                  cutover_authorized_at=int(time.time()))

    def _execute(self, job):
        try:
            self.verify_execution(job)
        except Exception:
            self.store.update(job['id'], status='stale', stage='execution_precondition_changed')
            return
        try:
            if hasattr(self.deployer, 'check_target_for'):
                baseline = self.deployer.check_target_for(job)
                self.store.update(job['id'], baseline_id=baseline['Id'])
            self.deployer.run(self.store.get(job['id']))
        except PreconditionChanged:
            latest = self.store.get(job['id'])
            if latest.get('old_id'):
                try:
                    self.deployer.restore(latest)
                except Exception:
                    self.store.update(
                        job['id'], status='recovery_required', stage='worker_failed',
                        error='Administrator inspection required')
            elif latest.get('status') != 'recovery_required':
                self.store.update(
                    job['id'], status='stale', stage='cutover_precondition_changed',
                    error='Authorization changed before cutover; live target unchanged')
        except Exception:
            latest = self.store.get(job['id'])
            self.store.update(job['id'], status='recovery_required' if latest.get('old_id') else 'failed',
                              stage='worker_failed', error='Administrator inspection required')
        finally:
            self.store.account_job_result(job['id'])

    def tick(self):
        with self.store.lock:
            if self.closing or self.store.upgrade_reservation() or (self.worker and self.worker.is_alive()):
                return
            # A worker may finish its terminal write but fail to commit its
            # receipt. Reconcile before dispatch; any accounting error fails closed.
            self.store.reconcile_results()
            if self.pi_launches.busy() and self.pi_launches.tick():
                return
            if any(j['status'] in ACTIVE for j in self.store.list()):
                return
            if self.runtime_updates.tick():
                return
            if self.lifecycle.tick():
                return
            for job in reversed(self.store.list()):
                if job['status'] != 'queued':
                    continue
                current = self.store.service(job['service'])
                if (current['policy_hash'] != job['policy_hash'] or current['mode'] != 'auto' or current.get('paused')):
                    self.store.update(job['id'], status='stale', stage='policy_changed_before_dispatch')
                    continue
                job = self.store.update(job['id'], status='deploying', stage='approved_by_policy',
                                        authorized_at=int(time.time()))
                self.worker = threading.Thread(target=self._execute, args=(job,), daemon=False)
                self.worker.start()
                return
            # Stable Pi lifetime does not reserve admission. Existing work gets
            # priority over the bounded background exit/reconciliation poll.
            self.pi_launches.tick()

    def _confirm(self, job, commit=None, plan=None):
        if 'snapshot' in job:
            if plan is None or commit is not None:
                raise RuntimeError('reviewed plan required for snapshot request')
            if not isinstance(plan, str) or len(plan) != 64 or job.get('plan_hash') != plan:
                raise RuntimeError('reviewed plan mismatch')
            return
        if commit is None or plan is not None:
            raise RuntimeError('reviewed commit required for legacy Hub request')
        check_sha(commit)
        if job.get('service', 'pi-web-hub') != 'pi-web-hub' or job.get('commit') != commit:
            raise RuntimeError('reviewed Hub commit mismatch')

    def approve(self, identifier, commit=None, plan=None):
        with self.store.lock:
            self.store.require_admission()
            if self.lifecycle.active() or self.runtime_updates.active():
                raise RuntimeError('lifecycle inspection or work is active')
            job = self.store.get(identifier)
            self._confirm(job, commit, plan)
            if job['status'] != 'pending':
                raise RuntimeError('request/commit no longer eligible for approval')
            if 'snapshot' in job:
                current = self.store.service(job['service'])
                if current['policy_hash'] != job['policy_hash'] or current['mode'] == 'disabled':
                    raise RuntimeError('service policy changed')
            elif self.policy is not None and self.store.service(job.get('service', 'pi-web-hub'))['mode'] == 'disabled':
                raise RuntimeError('service disabled')
            if any(j['status'] in ACTIVE for j in self.store.list()):
                raise RuntimeError('another deployment or recovery is active')
            if self.closing or (self.worker and self.worker.is_alive()):
                raise RuntimeError('worker unavailable')
            # Keep earlier outcomes ordered before this deployment can reset the
            # counter; a failed receipt must also block manual worker admission.
            self.store.reconcile_results()
            job = self.store.update(identifier, status='deploying', stage='approved_by_host',
                                    authorized_at=int(time.time()))
            self.worker = threading.Thread(target=self._execute, args=(job,), daemon=False)
            self.worker.start()
            return public(job)

    def rollback(self, identifier, commit=None, plan=None):
        with self.store.lock:
            self.store.require_admission()
            if self.lifecycle.active() or self.runtime_updates.active():
                raise RuntimeError('lifecycle inspection or work is active')
            job = self.store.get(identifier)
            self._confirm(job, commit, plan)
            if job['status'] not in ('deployed', 'recovery_required') or not job.get('old_id'):
                raise RuntimeError('request not eligible for rollback')
            if self.closing or (self.worker and self.worker.is_alive()) or any(
                    j['status'] in ('deploying', 'recovering') for j in self.store.list()):
                raise RuntimeError('deployment is active')
            if any(j['status'] == 'recovery_required' and j['id'] != identifier for j in self.store.list()):
                raise RuntimeError('another recovery requires administrator inspection')
            target = job['snapshot']['target'] if 'snapshot' in job else self.deployer.policy['target']
        current = self.deployer.engine.inspect(target)
        with self.store.lock:
            self.store.require_admission()
            if self.lifecycle.active() or self.runtime_updates.active():
                raise RuntimeError('lifecycle inspection or work is active')
            latest = self.store.get(identifier)
            if latest != job:
                raise RuntimeError('request changed while target was inspected')
            if self.closing or (self.worker and self.worker.is_alive()) or any(
                    j['status'] in ('deploying', 'recovering') for j in self.store.list()):
                raise RuntimeError('deployment is active')
            if any(j['status'] == 'recovery_required' and j['id'] != identifier for j in self.store.list()):
                raise RuntimeError('another recovery requires administrator inspection')
            if job['status'] == 'deployed' and (not current or current['Id'] != job.get('new_id')):
                raise RuntimeError('this job is no longer the current deployment')
            # Preserve the deployment result before an explicit rollback replaces
            # its status, even if the original worker missed its accounting call.
            self.store.account_job_result(identifier)
            job = self.store.update(identifier, status='recovering', stage='host_requested_rollback')
            self.worker = threading.Thread(target=self.deployer.restore, args=(job,), daemon=False)
            self.worker.start()
            return public(job)

    def resolve(self, identifier, target_id):
        with self.store.lock:
            job = self.store.get(identifier)
            if (job['status'] != 'recovery_required' or job.get('old_id') or
                    self.closing or (self.worker and self.worker.is_alive())):
                raise RuntimeError('only pre-cutover recovery can be resolved')
            baseline_id = job.get('baseline_id')
            if not isinstance(baseline_id, str) or not baseline_id:
                raise RuntimeError('stored target baseline is required')
        item = self.deployer.check_target_for(job)
        with self.store.lock:
            latest = self.store.get(identifier)
            if latest != job:
                raise RuntimeError('request changed while target was inspected')
            if (latest['status'] != 'recovery_required' or latest.get('old_id') or
                    self.closing or (self.worker and self.worker.is_alive())):
                raise RuntimeError('only pre-cutover recovery can be resolved')
            current_id = item.get('Id') if isinstance(item, dict) else None
            if current_id != baseline_id or target_id != baseline_id:
                raise RuntimeError('target identity mismatch')
            self.store.update(identifier, status='failed', stage='host_resolved_pre_cutover')
            self.store.audit('resolve', job.get('service', 'pi-web-hub'), request=identifier, target_id=target_id)
            return public(self.store.get(identifier))


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('unexpected or missing request fields')


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log Authorization, posted bodies, release output or tokens.

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, value):
        raw = json.dumps(value, ensure_ascii=True).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(raw)
        self.close_connection = True

    def body(self, maximum=None, strict=False):
        if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type') != 'application/json':
            raise ValueError('JSON Content-Type and Content-Length required')
        lengths = self.headers.get_all('Content-Length', [])
        maximum = maximum if maximum is not None else (65536 if self.server.is_admin else 4096)
        if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= maximum:
            raise ValueError('body length invalid')
        raw = self.rfile.read(int(lengths[0]))
        if strict:
            from .terminal_contract import pairs, nonfinite
            return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=pairs, parse_constant=nonfinite)
        return json.loads(raw)

    def dispatch(self):
        gate = self.server.gate
        admin = self.server.is_admin
        management = self.path.startswith('/v1/hub-management')
        if not admin:
            port = self.server.server_address[1]
            if management and any(len(self.headers.get_all(name, [])) > 1 for name in
                                  ('Host', 'Origin', 'Authorization', 'Content-Type', 'Transfer-Encoding')):
                self.reply(400, {'error': 'ambiguous management headers'})
                return
            if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                self.reply(403, {'error': 'Host not allowed'})
                return
            origin = self.headers.get('Origin')
            if origin and origin not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
                self.reply(403, {'error': 'Origin not allowed'})
                return
            if self.command == 'GET' and self.path == '/healthz':
                self.reply(200, {'ok': True})
                return
            auth = self.headers.get('Authorization', '')
            lifecycle_route = self.path.startswith('/v1/pi-lifecycle/')
            expected_token = (gate.hub_management_token if management else
                              gate.lifecycle_token if lifecycle_route else gate.token)
            if not hmac.compare_digest(auth.encode('utf-8'), ('Bearer ' + expected_token).encode('ascii')):
                self.reply(401, {'error': 'request credential required'})
                return
        try:
            route = urlsplit(self.path)
            if not admin and management:
                gate.hub_management.handle(self)
            elif admin and self.command == 'POST' and self.path == '/admin/hub-management-export':
                exact(self.body(maximum=4096, strict=True), ())
                self.reply(200, {'token': gate.hub_management_token})
            elif not admin and route.path in ('/v1/runtime-versions', '/v1/runtime-readiness'):
                if self.command != 'GET':
                    self.reply(405, {'error': 'method not allowed'})
                    return
                params = parse_qs(route.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
                if (route.fragment or set(params) - {'query', 'cursor'} or
                        any(len(values) != 1 for values in params.values()) or
                        (route.path.endswith('readiness') and params)):
                    raise ValueError('invalid runtime discovery query')
                value = (gate.runtime_updates.catalog.catalog(params.get('query', [''])[0], params.get('cursor', [None])[0] or None)
                         if route.path.endswith('versions') else gate.runtime_updates.readiness())
                self.reply(200, value)
            elif admin and self.command == 'POST' and self.path == '/admin/terminal-preflight':
                self.reply(200, gate.terminal_preflight(self.body(maximum=4096, strict=True)))
            elif admin and self.command == 'GET' and self.path == '/admin/upgrade-status':
                self.reply(200, gate.upgrade_status())
            elif admin and self.command == 'POST' and self.path == '/admin/upgrade-reserve':
                value = self.body()
                exact(value, ('image',))
                self.reply(200, gate.reserve_upgrade(value['image']))
            elif admin and self.command == 'POST' and self.path in ('/admin/upgrade-finish', '/admin/upgrade-abort'):
                value = self.body()
                abort = self.path.endswith('-abort')
                exact(value, ('id', 'acknowledge') if abort else ('id',))
                if abort and value['acknowledge'] != 'inspected_no_replacement':
                    raise ValueError('host inspection acknowledgment required')
                self.reply(200, gate.release_upgrade(value['id'], 'abort' if abort else 'finish'))
            elif not admin and self.command == 'GET' and self.path.startswith('/v1/pi-lifecycle/runs/'):
                self.reply(200, gate.lifecycle.target(self.path.removeprefix('/v1/pi-lifecycle/runs/')))
            elif self.command == 'GET' and self.path in ('/v1/runtime-updates', '/admin/runtime-updates'):
                if self.path.startswith('/admin') and not admin:
                    self.reply(404, {'error': 'not found'})
                else:
                    self.reply(200, {'policy': gate.runtime_updates.policy(), 'jobs': gate.runtime_updates.jobs(),
                                     'active': gate.runtime_updates.active()})
            elif self.command == 'GET' and self.path.startswith(('/v1/runtime-updates/', '/admin/runtime-updates/')):
                if self.path.startswith('/admin') and not admin:
                    self.reply(404, {'error': 'not found'})
                else:
                    self.reply(200, gate.runtime_updates.get(self.path.rsplit('/', 1)[-1]))
            elif not admin and self.command == 'POST' and self.path == '/v1/runtime-updates':
                self.reply(202, gate.runtime_updates.submit(self.body()))
            elif admin and self.command == 'POST' and self.path == '/admin/runtime-policy':
                self.reply(200, gate.runtime_updates.set_policy(self.body()))
            elif admin and self.command == 'POST' and self.path == '/admin/runtime-resolve':
                value = self.body()
                exact(value, ('id', 'acknowledge'))
                self.reply(200, gate.runtime_updates.resolve(value['id'], value['acknowledge']))
            elif admin and self.command == 'POST' and self.path in ('/admin/runtime-approve', '/admin/runtime-reject'):
                value = self.body()
                exact(value, ('id',))
                action = gate.runtime_updates.approve if self.path.endswith('-approve') else gate.runtime_updates.reject
                self.reply(200, action(value['id']))
            elif not admin and self.command == 'GET' and self.path.startswith('/v1/pi-lifecycle/restarts/'):
                self.reply(200, gate.lifecycle.get(self.path.removeprefix('/v1/pi-lifecycle/restarts/')))
            elif not admin and self.command == 'POST' and self.path == '/v1/pi-lifecycle/restarts':
                self.reply(202, gate.lifecycle.submit(self.body()))
            elif admin and self.command == 'GET' and self.path == '/admin/lifecycle':
                self.reply(200, {'policy': gate.lifecycle.policy(), 'jobs': gate.lifecycle.jobs()[:100],
                                 'active': gate.lifecycle.active()})
            elif admin and self.command == 'GET' and self.path.startswith('/admin/lifecycle/'):
                self.reply(200, gate.lifecycle.get(self.path.removeprefix('/admin/lifecycle/')))
            elif admin and self.command == 'POST' and self.path == '/admin/lifecycle-policy':
                self.reply(200, gate.lifecycle.set_policy(self.body()))
            elif admin and self.command == 'POST' and self.path == '/admin/lifecycle-export':
                exact(self.body(), ())
                self.reply(200, {'token': gate.lifecycle_token})
            elif admin and self.command == 'POST' and self.path in ('/admin/lifecycle-approve', '/admin/lifecycle-reject'):
                value = self.body()
                exact(value, ('id',))
                action = gate.lifecycle.approve if self.path.endswith('-approve') else gate.lifecycle.reject
                self.reply(200, action(value['id']))
            elif admin and self.command == 'POST' and self.path == '/admin/lifecycle-resolve':
                value = self.body()
                exact(value, ('id', 'runtime_id', 'acknowledge'))
                self.reply(200, gate.lifecycle.resolve(value['id'], value['runtime_id'], value['acknowledge']))
            elif self.command == 'GET' and self.path in ('/v1/requests', '/admin/requests'):
                if self.path.startswith('/admin') and not admin:
                    self.reply(404, {'error': 'not found'})
                else:
                    all_jobs = gate.store.list()
                    value = {'requests': [admin_public(j) if admin else public(j) for j in all_jobs[:100]]}
                    if admin:
                        value['active'] = [admin_public(j) for j in all_jobs if j['status'] in ACTIVE]
                        value['lifecycle_active'] = gate.lifecycle.active()
                        value['runtime_active'] = gate.runtime_updates.active()
                        value['upgrade'] = gate.upgrade_status()
                    self.reply(200, value)
            elif self.command == 'GET' and admin and self.path.startswith('/admin/requests/'):
                self.reply(200, admin_public(gate.store.get(self.path.removeprefix('/admin/requests/'))))
            elif self.command == 'POST' and self.path == '/v1/requests' and not admin:
                value = self.body()
                self.reply(201, public(gate.submit(value)))
            elif self.command == 'GET' and self.path in ('/v1/services', '/admin/services'):
                if self.path.startswith('/admin') and not admin:
                    self.reply(404, {'error': 'not found'})
                else:
                    from .registry import service_public
                    self.reply(200, {'services': [service_public(s) for s in gate.store.services()]})
            elif self.command == 'POST' and self.path == '/v1/intents' and not admin:
                self.reply(201, gate.store.intent(self.body()))
            elif self.command == 'GET' and self.path == '/admin/intents' and admin:
                self.reply(200, {'intents': gate.store.intents()})
            elif self.command == 'GET' and self.path == '/admin/events' and admin:
                self.reply(200, {'events': gate.store.events()})
            elif self.command == 'POST' and admin and self.path in ('/admin/policy', '/admin/resume'):
                value = self.body()
                with gate.store.lock:
                    if self.path == '/admin/policy':
                        exact(value, ('service', 'mode'))
                        result = gate.store.set_mode(value['service'], value['mode'])
                    else:
                        exact(value, ('service',))
                        result = gate.store.resume_service(value['service'])
                from .registry import service_public
                self.reply(200, service_public(result))
            elif self.command == 'POST' and admin and self.path == '/admin/register':
                from .registry import service_public
                definition = self.body()
                with gate.store.lock:
                    gate.store.require_admission()
                    if gate.lifecycle.active() or gate.runtime_updates.active() or any(j['status'] in ACTIVE for j in gate.store.list()):
                        raise RuntimeError('cannot change registration during deployment')
                    result = service_public(gate.store.register_service(definition))
                self.reply(200, result)
            elif self.command == 'POST' and admin and self.path == '/admin/reject-intent':
                value = self.body()
                exact(value, ('id',))
                self.reply(200, gate.store.reject_intent(value['id']))
            elif self.command == 'POST' and admin and self.path == '/admin/resolve':
                value = self.body()
                exact(value, ('id', 'target_id'))
                self.reply(200, gate.resolve(value['id'], value['target_id']))
            elif self.command == 'POST' and admin and self.path in ('/admin/approve', '/admin/rollback'):
                value = self.body()
                if not isinstance(value, dict):
                    raise ValueError('request must be object')
                exact(value, ('id', 'plan') if 'plan' in value else ('id', 'commit'))
                action = gate.approve if self.path == '/admin/approve' else gate.rollback
                self.reply(202, action(value['id'], commit=value.get('commit'), plan=value.get('plan')))
            elif self.command == 'POST' and admin and self.path == '/admin/reject':
                value = self.body()
                exact(value, ('id',))
                with gate.store.lock:
                    job = gate.store.get(value['id'])
                    if job['status'] not in ('pending', 'queued'):
                        raise RuntimeError('only unstarted requests can be rejected')
                    result = public(gate.store.update(value['id'], status='rejected', stage='host_rejected'))
                self.reply(200, result)
            else:
                self.reply(404, {'error': 'not found'})
        except (ValueError, TypeError, json.JSONDecodeError):
            self.reply(400, {'error': 'invalid request'})
        except KeyError:
            self.reply(404, {'error': 'request not found'})
        except RegistryUnavailable:
            self.reply(503, {'error': 'official runtime registry unavailable'})
        except RuntimeError:
            self.reply(409, {'error': 'request conflicts with current state or quota'})
        except Exception:
            self.reply(500, {'error': 'operation failed; administrator inspection required'})

    do_GET = dispatch
    do_POST = dispatch


class LimitedThreads:
    daemon_threads = True
    capacity = 32

    def __init__(self, *args, **kwargs):
        # Independent admission pools: TCP saturation must not deny emergency admin.
        self.slots = threading.BoundedSemaphore(self.capacity)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class HTTPServer(LimitedThreads, socketserver.ThreadingMixIn, http.server.HTTPServer):
    is_admin = False


class AdminServer(LimitedThreads, socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    is_admin = True
    capacity = 4


def start_servers(gate, port=16182):
    http = HTTPServer(('127.0.0.1', port), Handler)
    http.gate = gate
    address = gate.directory / 'admin.sock'
    if address.exists():
        if not stat.S_ISSOCK(address.lstat().st_mode):
            raise ValueError('refusing to overwrite non-socket admin path')
        address.unlink()
    admin = AdminServer(str(address), Handler)
    os.chmod(address, 0o600)
    admin.gate = gate
    for server in (http, admin):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return http, admin


def admin_public(job):
    # Host status is often pasted into chats; keep private runtime templates out.
    return {key: value for key, value in job.items() if key != 'snapshot'}


def start_terminal(gate, policy, ipc=Path('/run/pi-terminal-provider'),
                   credentials=Path('/run/pi-terminal-credentials')):
    from .terminal_contract import policy as validate_policy
    from .terminal_provider import TerminalListener
    policy = validate_policy(policy)
    if not policy['enabled']:
        return None
    if gate.terminal_server is not None:
        raise RuntimeError('terminal listener already started')
    gate.terminal_server = TerminalListener(gate, policy, ipc, credentials)
    return gate.terminal_server


def main():
    from .router import DeploymentRouter
    from .engine import Engine
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default='/state')
    parser.add_argument('--policy', default='/app/policy.json')
    parser.add_argument('--port', type=int, default=16182)
    parser.add_argument('--terminal-policy', default='/app/terminal-policy.json')
    parser.add_argument('--launch-policy', help='Explicit private JSON launch profile; omitted means disabled')
    args = parser.parse_args()
    policy = json.loads(Path(args.policy).read_text())
    gate = Gate(Path(args.state), policy=policy, launch_policy=Path(args.launch_policy) if args.launch_policy else None)
    gate.deployer = DeploymentRouter(gate.store, Engine(), policy, before_cutover=gate.verify_execution)
    start_terminal(gate, json.loads(Path(args.terminal_policy).read_text()))
    gate.lifecycle.recover()
    gate.pi_launches.recover()
    if not gate.store.upgrade_reservation() and not gate.pi_launches.busy() and not gate.lifecycle.active() and not gate.runtime_updates.active():
        gate.deployer.recover()
    http, admin = start_servers(gate, args.port)
    done = threading.Event()
    def stopping(*_args):
        gate.closing = True
        done.set()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, stopping)
    print('Pi deployment gate ready; per-service approval policies active', flush=True)
    while not done.wait(0.5):
        gate.tick()
    http.shutdown()
    admin.shutdown()
    http.server_close()
    admin.server_close()
    gate.close()


if __name__ == '__main__':
    main()

import hashlib
import json

from .artifacts import build_context, fetch_bundle, terminal_digest
from .errors import PreconditionChanged
from .store import ACTIVE


class Deployer:
    def __init__(self, store, engine, policy, fetch=fetch_bundle, before_cutover=None):
        self.store, self.engine, self.policy, self.fetch = store, engine, policy, fetch
        self.before_cutover = before_cutover

    def target_body(self, image, job):
        p = self.policy
        health = "fetch('http://127.0.0.1:%d/api/sessions',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" % p['health_port']
        binds = [p['private_volume'] + ':/hub/private:rw', p['runtime_volume'] + ':/run/pi-web-hub:rw']
        if p.get('terminal_provider') is True:
            binds += ['pi-terminal-provider-ipc:/run/pi-terminal-provider:ro',
                      'pi-terminal-provider-credentials:/run/pi-terminal-credentials:ro']
        return {'Image': image, 'User': '1000:1000', 'WorkingDir': '/opt/pi-web-ui',
                'Entrypoint': ['node', '/opt/pi-web-ui/dist/hub/pi-web-hub.mjs'],
                'Cmd': ['serve', '--config', '/hub/private/config.json'],
                'Env': ['HOME=/home/node', 'NODE_ENV=production'],
                'Labels': {'pi.deploy-gate.job': job, 'pi.deploy-gate.target': p['target']},
                'Healthcheck': {'Test': ['CMD', 'node', '-e', health], 'Interval': 5000000000,
                                'Timeout': 5000000000, 'StartPeriod': 3000000000, 'Retries': 3},
                'HostConfig': {'NetworkMode': 'host', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true'], 'Memory': 512 * 1024 * 1024,
                               'NanoCpus': 1000000000, 'PidsLimit': 128,
                               'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                               'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'},
                               'Binds': binds,
                               'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}}}

    def check_target(self):
        p = self.policy
        item = self.engine.inspect(p['target'])
        if (not item or not item['State']['Running'] or
                item['State'].get('Health', {}).get('Status') != 'healthy'):
            raise ValueError('target Hub is not healthy')
        expected = {('/hub/private', p['private_volume']): True, ('/run/pi-web-hub', p['runtime_volume']): True}
        mounts = item.get('Mounts', [])
        # The exact legacy template is the only initial migration concession.
        # Partial provider mounts, different volumes or changed access never qualify.
        if p.get('terminal_provider') is True and len(mounts) == 4:
            expected.update({('/run/pi-terminal-provider', 'pi-terminal-provider-ipc'): False,
                             ('/run/pi-terminal-credentials', 'pi-terminal-provider-credentials'): False})
        if len(mounts) != len(expected) or {(m['Destination'], m.get('Name')) for m in mounts} != expected.keys():
            raise ValueError('target mounts differ from approved policy')
        if any(m['Type'] != 'volume' or m['RW'] is not expected[(m['Destination'], m.get('Name'))] or m.get('Propagation', '') not in ('', 'rprivate')
               or m.get('SubPath') or m.get('Subpath') for m in mounts):
            raise ValueError('target mount access differs from approved policy')
        host = item['HostConfig']
        config = item['Config']
        if (config.get('User') != '1000:1000' or
                config.get('Entrypoint') != ['node', '/opt/pi-web-ui/dist/hub/pi-web-hub.mjs'] or
                config.get('Cmd') != ['serve', '--config', '/hub/private/config.json'] or
                config.get('WorkingDir') != '/opt/pi-web-ui' or
                host.get('Privileged') or host.get('CapAdd') or host.get('Devices') or
                host.get('DeviceRequests') or host.get('GroupAdd') or
                host.get('IpcMode', 'private') != 'private' or host.get('UTSMode') or host.get('UsernsMode') or
                host.get('CgroupnsMode', 'private') != 'private' or
                host.get('PidMode') or host['NetworkMode'] != 'host' or not host['ReadonlyRootfs'] or
                [c.upper() for c in host.get('CapDrop', [])] != ['ALL'] or
                host.get('SecurityOpt') not in (['no-new-privileges'], ['no-new-privileges:true'])):
            raise ValueError('target security policy changed')
        approved = self.target_body(item['Image'], 'validation')
        for field in ('Memory', 'NanoCpus', 'PidsLimit', 'RestartPolicy', 'Tmpfs', 'LogConfig'):
            if host.get(field) != approved['HostConfig'][field]:
                raise ValueError('target resource/lifecycle policy changed')
        for mount in host.get('Mounts') or []:
            if (mount.get('Type') != 'volume' or
                    (mount.get('Target'), mount.get('Source')) not in expected or
                    mount.get('ReadOnly', False) is not (not expected[(mount.get('Target'), mount.get('Source'))]) or
                    mount.get('VolumeOptions', {}) != {'NoCopy': True} or
                    mount.get('BindOptions') or mount.get('TmpfsOptions')):
                raise ValueError('target mount options changed')
        if host.get('Mounts') and (host.get('Binds') or
                len(host['Mounts']) != len(expected) or
                {(m.get('Target'), m.get('Source')) for m in host['Mounts']} != expected.keys()):
            raise ValueError('target mount inventory changed')
        expected_binds = [name + ':' + destination + (':rw' if rw else ':ro')
                          for (destination, name), rw in expected.items()]
        if host.get('Binds') and sorted(host['Binds']) != sorted(expected_binds):
            raise ValueError('target bind options changed')
        inherited = dict(v.split('=', 1) for v in self.engine.image_env(item['Image']))
        env = config.get('Env') or []
        actual = dict(v.split('=', 1) for v in env)
        for key, value in (('HOME', '/home/node'), ('NODE_ENV', 'production')):
            if key in actual:
                inherited[key] = value
        if len(actual) != len(env) or actual != inherited:
            raise ValueError('target environment changed')
        health = config.get('Healthcheck', {})
        test = health.get('Test', [])
        desired = approved['Healthcheck']['Test']
        if (test[:3] != desired[:3] or len(test) != 4 or
                ''.join(test[3].split()) != ''.join(desired[3].split()) or
                tuple(health.get(k, 0) for k in ('Interval', 'Timeout', 'StartPeriod', 'Retries')) not in
                ((5000000000, 5000000000, 3000000000, 3), (15000000000, 5000000000, 5000000000, 3)) or
                health.get('StartInterval', 0) != 0):
            raise ValueError('target healthcheck policy changed')
        return item

    def prepare(self, job):
        identifier = job['id']
        self.store.update(identifier, stage='fetching')
        release = self.fetch(job['commit'])
        bundle, license = release[:2]
        terminal = release[2] if len(release) == 3 else None
        if self.policy.get('terminal_provider') is True and terminal is None:
            raise ValueError('terminal-enabled Hub requires complete browser assets')
        digest = hashlib.sha256(bundle).hexdigest()
        self.store.update(identifier, stage='building', bundle_sha256=digest)
        tag = 'pi-web-hub:gate-' + job['commit'] + '-' + identifier
        self.engine.ensure_base(self.policy['base_image'])
        labels = {'org.opencontainers.image.revision': job['commit'],
                  'pi.deploy-gate.bundle-sha256': digest,
                  'pi.deploy-gate.base-image': self.policy['base_image']}
        if terminal is not None:
            labels['pi.deploy-gate.terminal-sha256'] = terminal_digest(terminal)
            self.store.update(identifier, terminal_sha256=labels['pi.deploy-gate.terminal-sha256'])
        return self.engine.build(build_context(bundle, license, self.policy['base_image'], job['commit'], terminal=terminal), tag, labels)

    def probe(self, image, job):
        self.engine.probe(image, job['id'])

    def check_created(self, identifier, image, job):
        pass  # Legacy Hub behavior; typed adapters enforce their fixed template.

    def check_restore(self, item, job):
        pass

    def check_recovery_candidate(self, identifier, job):
        pass  # Image adapters re-inspect the full saved template at recovery boundaries.

    def cleanup_probe(self, job):
        self.engine.cleanup_probe(job['id'], job['candidate_image'])

    def run(self, job):
        identifier = job['id']
        try:
            old = self.check_target()
            image = self.prepare(job)
            self.store.update(identifier, stage='validating', candidate_image=image)
            self.probe(image, job)
            # Recheck immediately before touching the live service.
            current = self.check_target()
            if current['Id'] != old['Id'] or current['Image'] != old['Image']:
                raise ValueError('Hub changed while preparing deployment')
            backup = self.policy['target'] + '-gate-backup-' + identifier
            if self.engine.inspect(backup):
                raise ValueError('backup name already exists')
            if self.before_cutover:
                self.before_cutover(job, cutover=True)
            self.store.update(identifier, stage='cutover', old_id=old['Id'], old_image=old['Image'],
                              backup=backup, candidate_image=image)
            self.engine.stop(old['Id'])
            self.engine.rename(old['Id'], backup)
            new = self.engine.create(self.policy['target'], self.target_body(image, identifier))
            self.store.update(identifier, new_id=new)
            self.check_created(new, image, job)
            self.engine.start(new)
            if not self.engine.healthy(new, self.policy.get('health_timeout', 40)):
                raise ValueError('new Hub did not become healthy')
            self.store.update(identifier, status='deployed', stage='complete')
        except PreconditionChanged:
            latest = self.store.get(identifier)
            if latest.get('old_id'):
                # Never classify an exception as harmless stale work once the
                # ledger says destructive cutover began.
                self.restore(latest)
            else:
                if latest.get('candidate_image'):
                    try:
                        self.cleanup_probe(latest)
                    except Exception:
                        self.store.update(
                            identifier, status='recovery_required', stage='probe_cleanup_required',
                            error='Recorded validation container changed; administrator inspection required')
                        return
                self.store.update(
                    identifier, status='stale', stage='cutover_precondition_changed',
                    error='Authorization changed before cutover; live target unchanged')
        except Exception:
            latest = self.store.get(identifier)
            if latest.get('old_id'):
                self.restore(latest)
            else:
                if latest.get('candidate_image'):
                    try:
                        self.cleanup_probe(latest)
                    except Exception:
                        self.store.update(identifier, status='recovery_required', stage='probe_cleanup_required',
                                          error='Recorded validation container changed; administrator inspection required')
                        return
                self.store.update(identifier, status='failed', stage='pre_cutover_failed',
                                  error='Candidate could not be validated or authorization expired; live target unchanged')

    def restore(self, job):
        identifier = job['id']
        candidate = None
        try:
            old = self.engine.inspect(job['old_id'])
            if (not old or old['Name'].lstrip('/') not in (self.policy['target'], job['backup']) or
                    (job.get('old_image') and old['Image'] != job['old_image'])):
                raise ValueError('previous Hub is unavailable or moved')
            self.check_restore(old, job)
            current = self.engine.inspect(self.policy['target'])
            if current and current['Id'] != old['Id']:
                if (current['Config'].get('Labels', {}).get('pi.deploy-gate.job') != identifier or
                        current['Image'] != job['candidate_image'] or
                        (job.get('new_id') and current['Id'] != job['new_id'])):
                    raise ValueError('foreign Hub replacement; manual recovery required')
                self.check_recovery_candidate(current['Id'], job)
                candidate = current
            elif job.get('recovery_candidate_id'):
                candidate = self.engine.inspect(job['recovery_candidate_id'])
                if candidate and (candidate['Name'].lstrip('/') != job['recovery_name'] or
                                  candidate['Image'] != job['candidate_image'] or
                                  candidate['Config'].get('Labels', {}).get('pi.deploy-gate.job') != identifier):
                    candidate = None
                    raise ValueError('preserved candidate identity changed')
            if candidate:
                self.check_recovery_candidate(candidate['Id'], job)
                recovery_name = self.policy['target'] + '-gate-recovery-' + identifier
                occupied = self.engine.inspect(recovery_name)
                if occupied and occupied['Id'] != candidate['Id']:
                    candidate = None
                    raise ValueError('foreign recovery name conflict')
                self.store.update(identifier, stage='preserving_candidate', recovery_name=recovery_name,
                                  recovery_candidate_id=candidate['Id'],
                                  recovery_candidate_was_running=job.get('recovery_candidate_was_running',
                                                                         candidate['State']['Running']))
                if candidate['State']['Running']:
                    self.engine.stop(candidate['Id'])
                if candidate['Name'].lstrip('/') != recovery_name:
                    self.engine.rename(candidate['Id'], recovery_name)
            self.store.update(identifier, stage='restoring_previous')
            if old['Name'].lstrip('/') != self.policy['target']:
                self.engine.rename(old['Id'], self.policy['target'])
            if not old['State']['Running']:
                self.engine.start(old['Id'])
            # The previous container retains its own health interval/start period.
            # A deliberately short candidate deadline must not prevent rollback.
            if not self.engine.healthy(old['Id'], max(20, self.policy.get('health_timeout', 40))):
                raise ValueError('previous Hub failed health check')
            self.store.update(identifier, status='rolled_back', stage='previous_container_restored',
                              error='Deployment not active; previous Hub restored')
        except Exception:
            # A failed old generation must not destroy the known candidate. Restore
            # its name/state only when BOTH exact identities remain ours.
            if candidate:
                try:
                    current = self.engine.inspect(self.policy['target'])
                    held = self.engine.inspect(candidate['Id'])
                    recorded = self.store.get(identifier)
                    if (held and held['Name'].lstrip('/') == recorded.get('recovery_name') and
                            held['Image'] == job['candidate_image'] and
                            held['Config'].get('Labels', {}).get('pi.deploy-gate.job') == identifier and
                            (not current or current['Id'] == old['Id'])):
                        self.check_recovery_candidate(held['Id'], recorded)
                        self.store.update(identifier, stage='restoring_preserved_candidate')
                        if current:
                            if current['State']['Running']:
                                self.engine.stop(old['Id'])
                            self.engine.rename(old['Id'], job['backup'])
                        self.engine.rename(held['Id'], self.policy['target'])
                        if recorded.get('recovery_candidate_was_running', candidate['State']['Running']):
                            self.check_recovery_candidate(held['Id'], recorded)
                            self.engine.start(held['Id'])
                except Exception:
                    pass  # Leave exact recorded IDs for host inspection; never delete.
            self.store.update(identifier, status='recovery_required', stage='manual_recovery_required',
                              error='Automatic recovery stopped; inspect recorded container IDs before proceeding')

    def recover(self):
        for job in self.store.list():
            self.recover_one(job)

    def recover_one(self, job):
        if job['status'] == 'recovery_required':
            return  # Manual recovery is not retried merely by restarting the gate.
        if job['status'] in ACTIVE:
            if job.get('candidate_image'):
                try:
                    self.cleanup_probe(job)
                except Exception:
                    self.store.update(job['id'], status='recovery_required', stage='probe_cleanup_required',
                                      error='Recorded validation container changed; administrator inspection required')
                    return
            if job.get('old_id'):
                self.restore(job)
            else:
                self.store.update(job['id'], status='failed', stage='interrupted_before_cutover',
                                  error='Gate restarted before cutover; live target unchanged')

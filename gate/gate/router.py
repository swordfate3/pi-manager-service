"""Dispatch from the immutable ledger snapshot, never from today's registry."""
from copy import deepcopy

from .artifacts import fetch_bundle
from .deploy import Deployer
from .image_deploy import ImageDeployer
from .store import ACTIVE


class DeploymentRouter:
    def __init__(self, store, engine, legacy_policy, before_cutover=None, fetch=fetch_bundle):
        self.store, self.engine = store, engine
        self.policy = deepcopy(legacy_policy)
        self.before_cutover, self.fetch = before_cutover, fetch

    def _adapter(self, job):
        snapshot = job.get('snapshot')
        if snapshot is None:
            if 'commit' not in job or 'image' in job:
                raise ValueError('only legacy Hub jobs may lack a snapshot')
            return Deployer(self.store, self.engine, self.policy, fetch=self.fetch,
                            before_cutover=self.before_cutover)
        policy = deepcopy(snapshot['policy'])
        if snapshot['target'] != policy['target']:
            raise ValueError('snapshot target mismatch')
        if snapshot['kind'] == 'hub':
            return Deployer(self.store, self.engine, policy, fetch=self.fetch,
                            before_cutover=self.before_cutover)
        if snapshot['kind'] == 'image':
            return ImageDeployer(self.store, self.engine, policy, before_cutover=self.before_cutover)
        raise ValueError('unsupported saved deployment kind')

    def run(self, job):
        self._adapter(job).run(job)

    def restore(self, job):
        self._adapter(job).restore(job)

    def check_target_for(self, job):
        return self._adapter(job).check_target()

    def recover(self):
        # main() calls this before servers/queue dispatch. Include already-terminal
        # rows: termination may have followed their status write but preceded receipt.
        self.store.reconcile_results()
        for job in reversed(self.store.list()):
            if job['status'] not in ACTIVE or job['status'] == 'recovery_required':
                continue
            try:
                self._adapter(job).recover_one(job)
            except Exception:
                self.store.update(job['id'], status='recovery_required', stage='manual_recovery_required',
                                  error='Saved deployment cannot be safely recovered; administrator inspection required')
            self.store.account_job_result(job['id'])

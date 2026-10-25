"""Frozen captures are data only, bounded and bound to the exact restart."""
import hashlib
import io
import tarfile
import unittest
from unittest.mock import patch

from gate import runtime_restore


def archive(data, *, name='session.jsonl', kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.size = len(data) if kind == tarfile.REGTYPE else 0
        tar.addfile(entry, io.BytesIO(data) if entry.size else None)
    return output.getvalue()


class RestoreValidation(unittest.TestCase):
    def test_archive_returns_only_the_bound_frozen_bytes(self):
        data = b'{"type":"session"}\n'
        descriptor = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        self.assertEqual(runtime_restore.capture_bytes(archive(data), descriptor), data)
        with self.assertRaises(ValueError):
            runtime_restore.capture_bytes(archive(data + b'changed'), descriptor)

    def test_archive_rejects_paths_links_extra_members_and_size_bombs(self):
        descriptor = {'bytes': 1, 'sha256': hashlib.sha256(b'x').hexdigest()}
        for raw in (archive(b'x', name='../session.jsonl'), archive(b'x', kind=tarfile.SYMTYPE),
                    archive(b'x', kind=tarfile.LNKTYPE), archive(b'xx')):
            with self.subTest(), self.assertRaises(ValueError):
                runtime_restore.capture_bytes(raw, descriptor)
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as tar:
            for name in ('session.jsonl', 'extra'):
                member = tarfile.TarInfo(name)
                member.size = 1
                tar.addfile(member, io.BytesIO(b'x'))
        with self.assertRaises(ValueError):
            runtime_restore.capture_bytes(raw.getvalue(), descriptor)

    def test_restore_result_binds_all_identity_hashes_and_preservation_fields(self):
        snapshot = {'session_id':'session', 'leaf_id':None, 'cwd':'/workspace',
                    'provider':'probe', 'model':'faux', 'thinking':'medium'}
        parent = {'id':'a'*32, 'version':'1.4.0', 'profile':{'probe_sha256':'b'*64},
                  'release':{'node':'>=22.19.0'}, 'candidate':{'tree_sha256':'c'*64}}
        descriptor = {'sha256':'d'*64,'snapshot':snapshot}
        source = {'version':'1.3.0'}
        value = {'ok':True,'contract':'pi-runtime-restore-v1','candidate_tree_sha256':'c'*64,
            'session_sha256':'d'*64,'expected_hash':runtime_restore.digest(snapshot),'version':'1.4.0',
            'node':'24.21.0','restored':snapshot,'cwd_mode':'surrogate','no_replay':True}
        proof = runtime_restore.checked_result(value, parent, descriptor, source)
        self.assertEqual(proof['target_task'], parent['id'])
        self.assertEqual(proof['source_hash'], runtime_restore.digest(source))
        for changed in ({'version':'1.3.0'}, {'no_replay':False}, {'node':'20.0.0'},
                        {'restored':{**snapshot,'leaf_id':'other'}}, {'session_sha256':'e'*64}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                runtime_restore.checked_result({**value,**changed}, parent, descriptor, source)

    def test_global_refresh_obtains_restore_proof_before_durable_restart_intent(self):
        from test_lifecycle import LifecycleTest, BODY, KEY, CID, IMAGE
        fixture = LifecycleTest()
        fixture.setUp()
        try:
            life = fixture.lifecycle()
            life.submit(BODY)
            job = life._get(KEY)
            job.update(runtime_update_id='a'*32)
            # The parent-authorization boundary is separate from this lifecycle
            # sequencing test. No candidate/process compatibility is inferred.
            life._update(KEY, runtime_update_id='a'*32)
            order = []
            def proof(lifecycle, current, item, state, outer):
                self.assertNotIn('intent_at', lifecycle._get(KEY))
                order.append('restore')
                return lifecycle._update(KEY, restore_proof={'test':'bound-proof'})
            original = fixture.engine.lifecycle_control
            def control(cid, request, timeout=None):
                if request['action'] == 'restart':
                    order.append('restart')
                    self.assertEqual(request.pop('restore_proof'), {'test':'bound-proof'})
                return original(cid, request, timeout)
            fixture.engine.lifecycle_control = control
            with patch.object(life, '_policy_fence'), patch.object(runtime_restore, 'prepare_refresh', side_effect=proof):
                fixture.finish()
            self.assertEqual(order, ['restore','restart'])
            self.assertEqual(life.get(KEY)['status'], 'succeeded')
        finally:
            fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()

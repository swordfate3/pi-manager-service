import unittest
from gate.lifecycle_contract import control_request, snapshot


class RestoreWireContract(unittest.TestCase):
    def setUp(self):
        self.ids = {'run_id':'a'*32,'runtime_id':'runtime','session_id':'session','leaf_id':None}
        self.identity = {'contract':'pi-runtime-source-v1',
            'package':'/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent',
            'executable':'/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
            'version':'1.3.0','node':'>=22.19.0','tree_sha256':'c'*64}

    def test_restore_preparation_and_cancellation_are_closed_private_actions(self):
        control_request({**self.ids,'action':'prepare_restore','operation_id':'b'*32})
        control_request({'action':'cancel_restore','run_id':'a'*32,'operation_id':'b'*32})
        with self.assertRaises(ValueError):
            control_request({**self.ids,'action':'prepare_restore','operation_id':'b'*32,'path':'/etc/passwd'})

    def test_snapshot_carries_closed_launch_identity_without_making_it_compatibility(self):
        value = {**self.ids,'managed':True,'version':'1.3.0','idle':True,'pending':False,'busy':False,
                 'source_identity':self.identity}
        self.assertEqual(snapshot(value, self.ids['run_id'])['source_identity'], self.identity)
        for changed in ({'package':'/etc'}, {'version':'1.4.0'}, {'extra':'grant'}):
            with self.subTest(changed=changed), self.assertRaises((ValueError, RuntimeError)):
                snapshot({**value,'source_identity':{**self.identity,**changed}}, self.ids['run_id'])

    def test_restore_proof_cannot_contain_executable_commands_or_arbitrary_paths(self):
        proof = {'session_sha256':'c'*64,'expected_hash':'d'*64,'source_hash':'e'*64,
            'target_tree_sha256':'f'*64,'target_task':'b'*32,'version':'1.4.0','profile_hash':'a'*64}
        control_request({**self.ids,'action':'restart','operation_id':'b'*32,'restore_proof':proof})
        for changed in ({'command':'sh'}, {'target_task':'../../etc'}, {'version':'latest'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                control_request({**self.ids,'action':'restart','operation_id':'b'*32,
                                 'restore_proof':{**proof,**changed}})

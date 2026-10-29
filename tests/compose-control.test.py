import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'deploy/compose/control.py'

class CleanControl(unittest.TestCase):
    def test_help_and_removed_dispatch_do_not_need_docker_or_old_configuration(self):
        env={**os.environ,'PI_STACK_DOCKER':'/no/docker'}
        result=subprocess.run(['python3',str(SCRIPT),'--help'],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('update',result.stdout)
        for action in ['local','legacy','executor','prune']:
            result=subprocess.run(['python3',str(SCRIPT),action],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,2,(action,result.stderr))

    def test_status_uses_only_one_compose_and_never_ambient_env_files(self):
        with tempfile.TemporaryDirectory(prefix='pi-clean-control-') as temporary:
            root=Path(temporary)
            fake=root/'docker'
            fake.write_text('#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({"args":sys.argv[1:],"envfile":os.environ.get("COMPOSE_ENV_FILES"),"project":os.environ.get("COMPOSE_PROJECT_NAME")}))\n')
            fake.chmod(0o700)
            env={**os.environ,'PI_STACK_ROOT':str(root),'PI_STACK_DOCKER':str(fake),'COMPOSE_ENV_FILES':'/poison','COMPOSE_PROJECT_NAME':'poison'}
            result=subprocess.run(['python3',str(SCRIPT),'status'],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            row=json.loads(result.stdout)
            self.assertEqual(row['args'],['compose','--project-name','pi-stack','--project-directory',str(root),'--env-file','/dev/null','-f',str(root/'compose.yaml'),'ps','-a'])
            self.assertIsNone(row['envfile']);self.assertIsNone(row['project'])

if __name__=='__main__':unittest.main()

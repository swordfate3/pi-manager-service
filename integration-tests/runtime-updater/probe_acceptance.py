"""Test-only real offline source probe; never mounts existing user state."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'integrations/runtime-updater/gate'))
from gate.runtime_engine import RuntimeEngine

DRIVER = r'''
import importlib.util,json,sys,subprocess,tempfile,traceback
from pathlib import Path
def load(name):
 spec=importlib.util.spec_from_file_location(name,'/usr/local/lib/pi-runtime/'+name+'.py')
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
request=json.load(sys.stdin)
identity=load('runtime_identity').measure_package('/home/node/.local/bin/pi')
launcher={'__name__':'isolated_source_probe'}
exec(request['launcher'],launcher)
try:
 if request.get('restore_diagnostic'):
  # Standalone diagnostic, not full transition acceptance. All history is
  # freshly generated synthetic content, with a cwd absent from this helper.
  probe=load('runtime_probe')
  original_wait=probe.RealPi.wait
  def diagnostic_wait(instance,*args,**kwargs):
   try:
    return original_wait(instance,*args,**kwargs)
   except Exception:
    print(json.dumps({'synthetic_terminal':instance.output[-5000:].decode(errors='replace')}),flush=True)
    raise
  probe.RealPi.wait=diagnostic_wait
  with tempfile.TemporaryDirectory(dir='/tmp',prefix='pi-restore-diagnostic-') as temporary:
   root=Path(temporary)
   session=root/'session.jsonl'
   probe.seed_session(session,Path('/workspace/workspace'))
   work=root/'work';work.mkdir(mode=0o700)
   expected={'session_id':'probe-saved-session','leaf_id':'probe-leaf',
    'cwd':'/workspace/workspace','provider':'runtime-probe','model':'probe-model','thinking':'medium'}
   probe.isolation();probe.verify_profile(request['profile'])
   result=probe.run_restore(Path(identity['package']),session,expected,work)
 else:
  result=launcher['run_probe']({'source':identity,'profile':request['profile']},mode='--source')
 print(json.dumps(result),flush=True)
except subprocess.CalledProcessError as error:
 print(json.dumps({'error':'probe_exit','exit_code':error.returncode,'stdout':error.stdout}),flush=True)
 sys.exit(1)
except Exception as error:
 print(json.dumps({'error':type(error).__name__,'fixed_reason':str(error) if type(error).__name__=='ProbeFailure' else None,
  'frames':[(row.name,row.lineno) for row in traceback.extract_tb(error.__traceback__)]}),flush=True)
 sys.exit(1)
'''


def main():
    image = os.environ.get('PI_RUNTIME_TEST_IMAGE', '')
    if os.environ.get('PI_REAL_DOCKER_TEST') != '1' or not re.fullmatch(r'pi-runtime-update-test:[\w.-]+', image):
        raise ValueError('explicit test image and opt-in required')
    immutable = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], text=True).strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', immutable):
        raise ValueError('invalid test image identity')
    namespace = uuid.uuid4().hex
    volume = 'pi-runtime-update-test-' + namespace
    name = 'pi-runtime-update-test-probe-' + namespace
    profile = RuntimeEngine.profile({'policy': {'images': [immutable]}})
    launcher = (ROOT / 'integrations/runtime-updater/gate/gate/runtime_install.py').read_text().rsplit(
        "\nif __name__ == '__main__':", 1)[0]
    evidence = {'image': immutable, 'namespace': namespace, 'profile': profile, 'production_touched': False}
    try:
        subprocess.run(['docker', 'volume', 'create', '--label', 'pi.runtime.acceptance=' + namespace, volume],
                       check=True, stdout=subprocess.DEVNULL)
        result = subprocess.run(['docker', 'run', '--rm', '-i', '--name', name, '--user', '1000:1000',
            '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '1g', '--cpus', '2', '--pids-limit', '96', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
            '--mount', 'type=volume,source=' + volume + ',target=/home/node/.local,readonly',
            '--entrypoint', '/usr/bin/python3', immutable, '-I', '-c', DRIVER], input=json.dumps({
                'profile': profile, 'launcher': launcher,
                'restore_diagnostic': os.environ.get('PI_RUNTIME_PROBE_RESTORE') == '1'}),
            text=True, capture_output=True, timeout=300)
        evidence.update(exit_code=result.returncode, stdout=result.stdout[-16384:], stderr=result.stderr[-12000:],
                        diagnostic_only=os.environ.get('PI_RUNTIME_PROBE_RESTORE') == '1')
        print(json.dumps(evidence, indent=2), flush=True)
        return result.returncode
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'volume', 'rm', volume], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    raise SystemExit(main())

"""Official candidate preparation and offline probe, isolated from live Pi state."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'integrations/runtime-updater/gate'), str(Path(__file__).parent)]
from gate.runtime_catalog import RuntimeCatalog
from gate.engine import DockerError
from gate.runtime_engine import RuntimeEngine
from runtime_test_bootstrap import RuntimeTestEngine


def main():
    tag = os.environ.get('PI_RUNTIME_TEST_IMAGE', '')
    version = os.environ.get('PI_RUNTIME_TEST_TARGET', '1.4.0')
    if (os.environ.get('PI_REAL_DOCKER_TEST') != '1' or not re.fullmatch(r'pi-runtime-update-test:[\w.-]+', tag)
            or version not in ('1.3.0', '1.4.0')):
        raise ValueError('test-only opt-in, image and fixture version required')
    image = subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag], text=True).strip()
    namespace = uuid.uuid4().hex
    volume = 'pi-runtime-update-test-' + namespace
    engine = RuntimeTestEngine(runtime_volume=volume)
    runtime = RuntimeEngine(engine, volume=volume)
    job = {'id':namespace,'version':version,'policy':{'images':[image]},'helpers':{},
           'release':RuntimeCatalog().resolve(version)}
    job['profile'] = runtime.profile(job)
    identities = []
    try:
        subprocess.run(['docker','volume','create','--label','pi.runtime.acceptance='+namespace,volume],
                       check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['docker','run','--rm','--user','1000:1000','--network','none','--read-only',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m',
            '--mount','type=volume,source='+volume+',target=/home/node/.local',
            '--entrypoint','/bin/true',image], check=True)
        for phase in ('prepare','validate'):
            identity = runtime.create(job, phase)
            identities.append(identity)
            job['helpers'][phase] = {'id':identity,'intent_at':int(time.time()*1000)}
            runtime.start(job, phase)
            end = time.monotonic() + 900
            transient = 0
            while time.monotonic() < end:
                try:
                    result = runtime.poll(job, phase)
                except DockerError:
                    # Read-only outcome inspection can be retried; never replay
                    # the start intent or infer a successful install from this.
                    transient += 1
                    if transient > 3:
                        raise
                    time.sleep(.2)
                    continue
                if result['state'] == 'running':
                    time.sleep(.2)
                    continue
                print(json.dumps({'phase':phase,**result}),flush=True)
                if result['state'] != 'succeeded':
                    raise AssertionError('real candidate '+phase+' failed')
                if phase == 'prepare':
                    job['candidate'] = result['candidate']
                else:
                    job['evidence'] = result['evidence']
                break
            else:
                raise AssertionError('real candidate helper timed out')
        print(json.dumps({'accepted_candidate_only':True,'image':image,'release':job['release'],
                          'profile':job['profile'],'evidence':job['evidence'],
                          'production_touched':False}),flush=True)
    finally:
        for identity in identities:
            engine.call('DELETE','/containers/'+identity+'?force=1&v=1',timeout=3)
        subprocess.run(['docker','volume','rm',volume],check=True,stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()

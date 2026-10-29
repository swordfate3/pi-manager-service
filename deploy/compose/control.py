#!/usr/bin/env python3
"""One deployment entry, one Compose file. No legacy dispatch or local Hub code."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

REPOSITORY='https://github.com/swordfate3/pi-manager-service.git'
ROOT=Path(os.environ.get('PI_STACK_ROOT',Path(__file__).resolve().parent.parent)).resolve()
DOCKER=os.environ.get('PI_STACK_DOCKER','docker')
ENV={k:v for k,v in os.environ.items() if k not in ('COMPOSE_FILE','COMPOSE_ENV_FILES','COMPOSE_PROFILES','COMPOSE_PROJECT_NAME')}
ENV['COMPOSE_DISABLE_ENV_FILE']='1'
BASE=['compose','--project-name','pi-stack','--project-directory',str(ROOT),'--env-file','/dev/null','-f',str(ROOT/'compose.yaml')]

def run(args,capture=False,**kwargs):
    result=subprocess.run(args,check=True,env=ENV,text=True,stdout=subprocess.PIPE if capture else None,**kwargs)
    return result.stdout.strip() if capture else None

def config(name):
    file=ROOT/name
    info=file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>32768:
        raise ValueError('Unsafe private deployment file')
    return json.loads(file.read_text())

def render(image,commit,ref):
    hub=config('config/hub.json');pi=config('config/pi.json')
    paths=set(hub['workspaceRoots'].values())
    if pi['screenshots']['enabled']:paths.add(pi['screenshots']['source'])
    home=Path(hub['home'])
    for flag,file in [('ssh',home/'.ssh'),('bashrc',home/'.bashrc'),('huggingface',home/'.cache/huggingface/token')]:
        if pi['mounts'][flag] and file.exists():paths.add(str(file))
    args=[DOCKER,'run','--rm','--network','none','--read-only','--user',f'{os.getuid()}:{os.getgid()}','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','192m','--pids-limit','32','--mount',f'type=bind,src={ROOT},dst={ROOT}']
    for source in sorted(paths):
        if ',' in source or '\n' in source:raise ValueError('Unsafe mount coordinate')
        args+=['--mount',f'type=bind,src={source},dst={source},readonly']
    args+=['--entrypoint','node',image,'/opt/pi-stack/configure.mjs','--root',str(ROOT),'--commit',commit,'--ref',ref,'--docker-gid',str(Path('/var/run/docker.sock').stat().st_gid)]
    run(args)

def resolve_commit(ref):
    if re.fullmatch(r'[a-f0-9]{40}',ref):return ref
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}',ref) or '..' in ref:raise ValueError('Invalid branch or commit')
    lines=run(['git','ls-remote',REPOSITORY,'refs/heads/'+ref,'refs/tags/'+ref,'refs/tags/'+ref+'^{}'],capture=True).splitlines()
    rows=[line.split('\t') for line in lines]
    if any(len(r)!=2 or not re.fullmatch(r'[a-f0-9]{40}',r[0]) for r in rows):raise ValueError('Invalid remote ref result')
    branch=[r[0] for r in rows if r[1]=='refs/heads/'+ref]
    tags=[r[0] for r in rows if r[1]=='refs/tags/'+ref+'^{}'] or [r[0] for r in rows if r[1]=='refs/tags/'+ref]
    if branch and tags:raise ValueError('Ambiguous branch/tag; use an exact commit')
    commits=set(branch or tags)
    if len(commits)!=1:raise ValueError('Remote branch or tag unavailable')
    return commits.pop()

def install_adapters(image):
    # Only small maintenance adapters are copied to the host. Hub bundles remain
    # exclusively in the remote-built image, never in this deployment directory.
    name=run([DOCKER,'create','--entrypoint','/bin/true',image],capture=True)
    try:
        with tempfile.TemporaryDirectory(prefix='pi-stack-adapters-') as temporary:
            run([DOCKER,'cp',name+':/opt/pi-stack/.',temporary])
            for filename in ['configure.mjs','control.py']:
                shutil.copy2(Path(temporary)/filename,ROOT/'internal'/filename)
            shutil.copytree(Path(temporary)/'bin',ROOT/'internal/bin',dirs_exist_ok=True)
            for file in (ROOT/'internal/bin').iterdir():
                if file.is_file():file.chmod(0o755)
            shutil.copy2(Path(temporary)/'README.md',ROOT/'README.md')
    finally:run([DOCKER,'rm',name])

def update(ref=None):
    with (ROOT/'internal/update.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        live=run([DOCKER,'ps','-q','--filter','label=cn.swordfate.pi.local-id'],capture=True)
        if live:raise ValueError('Stop web-created Pi in the Hub before updating the Hub; terminal Pi may stay running')
        old=config('internal/release.json');ref=ref or old['ref'];commit=resolve_commit(ref)
        image='pi-stack-hub:'+commit[:12]
        print('Remote source: '+REPOSITORY+'#'+commit,flush=True)
        run([DOCKER,'build','--build-arg','SOURCE_COMMIT='+commit,'-f','deploy/compose/Dockerfile','-t',image,REPOSITORY+'#'+commit])
        # Validate/render before stopping the running service. No local source or
        # application bundles participate in this build or in normal startup.
        render(image,commit,ref)
        run([DOCKER,*BASE,'stop','hub','tunnel'] if config('config/hub.json').get('tunnel') else [DOCKER,*BASE,'stop','hub'])
        try:
            install_adapters(image)
            run([DOCKER,*BASE,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','75'])
        except Exception:
            print('Activation failed; restoring the previous image/configuration.',file=sys.stderr)
            render(old['image'],old['commit'],old['ref'])
            install_adapters(old['image'])
            run([DOCKER,*BASE,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','75'])
            raise
        print('Running remote commit: '+commit)

def main():
    parser=argparse.ArgumentParser(description='pi-dockerctl: one Compose stack; Hub code comes only from the remote image.')
    parser.add_argument('action',nargs='?',default='help',choices=['help','up','down','restart','status','logs','links','configure','build','update','version','password','config','pirun'])
    parser.add_argument('args',nargs=argparse.REMAINDER)
    opts=parser.parse_args();action=opts.action
    if action=='help':parser.print_help();return
    if action=='pirun':os.execv(str(ROOT/'internal/bin/pirun'),[str(ROOT/'internal/bin/pirun'),*opts.args])
    if action=='links':
        h=config('config/hub.json');print(h.get('publicOrigin',f'http://127.0.0.1:{h["port"]}')+'/');return
    if action=='version':print(json.dumps(config('internal/release.json'),indent=2));return
    if action=='update':
        if opts.args and (len(opts.args)!=2 or opts.args[0]!='--ref'):parser.error('update accepts only --ref BRANCH_OR_COMMIT')
        update(opts.args[1] if opts.args else None);return
    if action=='configure':
        if opts.args:parser.error('configure takes no arguments')
        r=config('internal/release.json');render(r['image'],r['commit'],r['ref']);return
    if action=='password':
        args=[DOCKER,'exec','-i'];
        if sys.stdin.isatty() and sys.stdout.isatty():args+=['-t']
        run([*args,'--user','1000:1000','pi-stack-hub','node','/opt/pi-manager/dist/manager/pi-manager-local.mjs','account-reset','--config',str(ROOT/'internal/hub-runtime.json')]);return
    if action!='logs' and opts.args:parser.error('This command takes no extra arguments')
    commands={'up':['up','-d','--no-build','--pull','never','--wait','--wait-timeout','75'],'down':['stop'],'restart':['restart'],'status':['ps','-a'],'config':['config','--no-interpolate'],'build':['build','hub']}
    if action=='logs':
        if len(opts.args)>1 or any(v not in ('hub','tunnel') for v in opts.args):parser.error('logs accepts hub or tunnel')
        run([DOCKER,*BASE,'logs','--tail','80',*(opts.args or ['hub'])]);return
    run([DOCKER,*BASE,*commands[action]])

if __name__=='__main__':
    try:main()
    except (OSError,ValueError,subprocess.CalledProcessError,KeyError) as error:
        # Never print private configuration, captured subprocess output or tokens.
        print('pi-dockerctl failed: '+(str(error) if isinstance(error,ValueError) else type(error).__name__),file=sys.stderr)
        raise SystemExit(1)

"""Opt-in, exact owned resources only. No build/pull or existing mutations."""
import json
import os
import subprocess
import uuid

IMAGE = 'sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6'
DAEMON = 'bac0be49-8ddb-4387-83aa-362f70f3ae8d'
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}

def docker(*args):
    return subprocess.check_output(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args],
                                   env=ENV, timeout=45, text=True).strip()

def snapshot():
    ids = docker('ps', '-aq', '--no-trunc').split()
    return {x['Id']: [x['State']['StartedAt'], x['State']['Running'], x['RestartCount']]
            for x in json.loads(docker('inspect', *ids))} if ids else {}

assert docker('info', '--format', '{{.ID}}') == DAEMON
assert docker('image', 'inspect', IMAGE, '--format', '{{.Id}}') == IMAGE
before = snapshot()
name = 'manager-candidate-storage-' + uuid.uuid4().hex
identity = None
try:
    identity = docker('create', '--name', name, '--label', 'pi.manager.candidate.acceptance=' + name,
        '--pull', 'never', '--user', '1000:1000', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m',
        '--memory-swap', '128m', '--pids-limit', '16', '--cpus', '0.5', '--log-driver', 'none',
        '--workdir', '/work', '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=1048576,nr_inodes=128,uid=1000,gid=1000,mode=700',
        '--entrypoint', '/usr/bin/python3', IMAGE, '-I', '-c',
        "import errno,json,os,subprocess; f=open('/work/full','wb',buffering=0); n=0\n"
        "try:\n while True: n+=f.write(b'x'*65536)\n"
        "except OSError as e:\n assert e.errno==errno.ENOSPC; print(json.dumps({'write_errno':e.errno,'bytes_written':n,'node':subprocess.check_output(['/usr/local/bin/node','--version'],text=True).strip(),'npm':subprocess.check_output(['/usr/local/bin/node','/usr/local/lib/node_modules/npm/bin/npm-cli.js','--version'],env={'HOME':'/work','PATH':'/usr/local/bin:/usr/bin:/bin'},text=True).strip()}))")
    print(docker('start', '-a', identity))
    assert json.loads(docker('inspect', identity))[0]['State']['ExitCode'] == 0
finally:
    if identity:
        info = json.loads(docker('inspect', identity))[0]
        assert info['Config']['Labels']['pi.manager.candidate.acceptance'] == name
        docker('rm', '-f', identity)
    after = snapshot()
    assert all(after.get(k) == v for k, v in before.items()), 'preexisting state changed'
    print(json.dumps({'preexisting_unchanged': len(before), 'owned_removed': identity}))

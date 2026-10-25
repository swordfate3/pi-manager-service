"""Fixed helper program, embedded by Gate; shared-volume files grant no authority.

Preparation never executes installed code. Validation deliberately refuses until
the real PTY/Web/session probe contract is implemented. A version check is not a
substitute. Keep this module self-contained for the isolated Python invocation.
"""
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

PACKAGE = '@earendil-works/pi-coding-agent'
REGISTRY = 'https://registry.npmjs.org/'
VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
MAX_ARTIFACT = 128 * 1024 * 1024
MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TREE_ENTRIES = 100000
CHECKS = ('exact_version', 'node_engine', 'web_extension', 'pty_guard',
          'input_barrier', 'async_taint', 'generation_idle', 'session_restore', 'no_replay')

# Policy for the trusted, image-owned npm implementation, not a sandbox for
# executing arbitrary JavaScript. Package lifecycle scripts stay disabled.
# Enforce the destination on *every* request, including redirects selected by
# npm's fetch stack, and forbid subprocess/alternate native fetch transports.
NPM_NETWORK_GUARD = r'''
'use strict';
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const fs = require('node:fs');
const {urlToHttpOptions} = require('node:url');
const {syncBuiltinESMExports} = require('node:module');
const deny = () => {
  // Optional dependency failures can be caught by npm. The parent must still
  // reject preparation rather than accepting a partially-policy-denied tree.
  try {fs.writeFileSync(__filename + '.denied', 'refused', {flag:'wx', mode:0o600});}
  catch (error) {if (error.code !== 'EEXIST') process.exit(70);}
  throw new Error('npm origin policy refused transport');
};
function destination(options) {
  if (!options || options.socketPath || options.path && !String(options.path).startsWith('/') ||
      options.auth || options.rejectUnauthorized === false ||
      options.hostname && options.hostname !== 'registry.npmjs.org' ||
      options.host && options.host !== 'registry.npmjs.org' ||
      !(options.hostname || options.host) ||
      options.port !== undefined && options.port !== '' && String(options.port) !== '443' ||
      options.servername && options.servername !== 'registry.npmjs.org' ||
      options.protocol && options.protocol !== 'https:') deny();
}
function options(args) {
  let value = args[0];
  if (typeof value === 'string' || value instanceof URL) {
    const url = new URL(value);
    if (url.username || url.password || url.protocol !== 'https:') deny();
    value = {...urlToHttpOptions(url), ...(typeof args[1] === 'object' ? args[1] : {})};
  }
  destination(value);
  for (const [name, content] of Object.entries(value.headers || {})) {
    if (name.toLowerCase() === 'host' && !['registry.npmjs.org', 'registry.npmjs.org:443'].includes(content)) deny();
  }
}
const request = https.request;
https.request = function(...args) {options(args); return Reflect.apply(request, this, args);};
https.get = function(...args) {const result = https.request(...args); result.end(); return result;};
http.request = http.get = deny;
const connect = tls.connect;
tls.connect = function(...args) {
  let value = args[0];
  if (typeof value === 'number') value = {port:value, ...(typeof args[1] === 'string' ? {host:args[1]} : args[1])};
  destination(value);
  return Reflect.apply(connect, this, args);
};
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = net._normalizeArgs(args);
  destination(normalized[0]);
  return Reflect.apply(socketConnect, this, args);
};
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = deny;
require('node:worker_threads').Worker = class {constructor() {deny();}};
globalThis.fetch = async () => deny();
syncBuiltinESMExports();
'''


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verify_probe_files(profile, root=Path('/usr/local/lib/pi-runtime')):
    """Never execute a launcher from the writable runtime volume."""
    if not isinstance(profile, dict):
        raise ValueError('probe profile missing')
    root = Path(root)
    rows = []
    for parent in (root, *root.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('probe directory is not immutable')
    for name in sorted(('runtime_probe.py', 'runtime_probe_provider.ts', 'runtime_probe_ws.mjs')):
        path = root / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
            raise ValueError('probe source is not immutable')
        rows.append((name, hashlib.sha256(path.read_bytes()).hexdigest()))
    if hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest() != profile.get('probe_sha256'):
        raise ValueError('probe identity changed')


def run_probe(request, *, root=Path('/usr/local/lib/pi-runtime'), mode=None):
    verify_probe_files(request.get('profile'), root)
    if mode not in (None, '--source', '--restore'):
        raise ValueError('invalid probe mode')
    command = ['/usr/bin/python3', '-I', str(root / 'runtime_probe.py')]
    if mode:
        command.append(mode)
    outcome = subprocess.run(command, input=json.dumps(request, sort_keys=True, separators=(',', ':')),
        text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=260, check=True,
        env={'HOME': '/tmp', 'PATH': '/usr/local/bin:/usr/bin:/bin'}, cwd='/tmp')
    if len(outcome.stdout) > 16384:
        raise ValueError('probe response exceeds bound')
    value = json.loads(outcome.stdout)
    if not isinstance(value, dict) or value.get('ok') is not True:
        raise ValueError('probe refused')
    return value


def pinned_release(value, version):
    if (not isinstance(value, dict) or set(value) != {'version', 'integrity', 'tarball', 'node'}
            or value['version'] != version or value['tarball'] != REGISTRY + PACKAGE +
            '/-/pi-coding-agent-' + version + '.tgz'
            or not isinstance(value['node'], str) or not re.fullmatch('>=' + VERSION, value['node'])
            or not isinstance(value['integrity'], str) or not value['integrity'].startswith('sha512-')):
        raise ValueError('invalid pinned release')
    raw = base64.b64decode(value['integrity'][7:], validate=True)
    if len(raw) != 64 or base64.b64encode(raw).decode() != value['integrity'][7:]:
        raise ValueError('invalid integrity')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('artifact redirect refused')


def download(url):
    # Only pinned_release can select this URL. No ambient proxies/auth handlers.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 120
    with opener.open(urllib.request.Request(url, headers={'Accept-Encoding': 'identity'}), timeout=15) as response:
        if response.status != 200 or response.geturl() != url:
            raise ValueError('artifact origin changed')
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise ValueError('artifact timeout')
            chunk = response.read1(min(65536, MAX_ARTIFACT + 1 - size))
            if not chunk:
                return b''.join(chunks)
            size += len(chunk)
            if size > MAX_ARTIFACT:
                raise ValueError('artifact too large')
            chunks.append(chunk)


def check_archive(data, release):
    if len(data) > MAX_ARTIFACT or hashlib.sha512(data).digest() != base64.b64decode(release['integrity'][7:]):
        raise ValueError('artifact integrity mismatch')
    manifest = None
    total = 0
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'package'
                    or not (member.isfile() or member.isdir()) or member.name in seen):
                raise ValueError('unsafe package archive')
            seen.add(member.name)
            total += member.size
            if total > MAX_TREE_BYTES or len(seen) > MAX_TREE_ENTRIES:
                raise ValueError('package archive too large')
            if member.name == 'package/package.json':
                if member.size > 1024 * 1024:
                    raise ValueError('package manifest too large')
                manifest = json.load(archive.extractfile(member))
    if not isinstance(manifest, dict) or manifest.get('name') != PACKAGE or manifest.get('version') != release['version']:
        raise ValueError('package identity mismatch')
    # Reject top-level URL/git/file dependency sources before invoking npm.
    # Transitive resolver egress still requires the isolated acceptance audit.
    for field in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        values = manifest.get(field, {})
        if not isinstance(values, dict) or any(not isinstance(v, str) or not re.fullmatch(
                r'[0-9xX*^~<>=| .+-]+', v) for v in values.values()):
            raise ValueError('unsupported dependency source')


def tree_digest(root):
    """Hash the complete installed tree, including modes and link destinations.

    No receipt exclusions. Reject escapes, special files, hardlinks and changes
    while reading. This detects drift, not hostile concurrent writers' races.
    """
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('invalid candidate directory')
    resolved = root.resolve(strict=True)
    result = hashlib.sha256()
    count, total = 0, 0

    def identity(value):
        # Reading a file or enumerating a directory may update atime. Keep
        # inode/mode/link/size and high resolution mutation times, never atime.
        return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
                value.st_uid, value.st_gid, value.st_size,
                value.st_mtime_ns, value.st_ctime_ns)

    def walk(directory):
        nonlocal count, total
        before = directory.stat(follow_symlinks=False)
        for entry in sorted(directory.iterdir(), key=lambda p: p.name):
            count += 1
            info = entry.lstat()
            if count > MAX_TREE_ENTRIES:
                raise ValueError('candidate tree too large')
            record = [str(entry.relative_to(root)), stat.S_IMODE(info.st_mode)]
            if stat.S_ISLNK(info.st_mode):
                if not entry.resolve(strict=True).is_relative_to(resolved):
                    raise ValueError('candidate symlink escapes release')
                record += ['link', os.readlink(entry)]
            elif stat.S_ISDIR(info.st_mode):
                record += ['directory']
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
                if total > MAX_TREE_BYTES:
                    raise ValueError('candidate tree too large')
                content = hashlib.sha256()
                fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    if identity(os.fstat(stream.fileno())) != identity(info):
                        raise ValueError('candidate changed')
                    while chunk := stream.read(65536):
                        content.update(chunk)
                    if identity(os.fstat(stream.fileno())) != identity(info):
                        raise ValueError('candidate changed')
                record += ['file', info.st_size, content.hexdigest()]
            else:
                raise ValueError('unsupported candidate entry')
            result.update(json.dumps(record, separators=(',', ':')).encode() + b'\n')
            if stat.S_ISDIR(info.st_mode):
                walk(entry)
            if identity(entry.lstat()) != identity(info):
                raise ValueError('candidate changed')
        if identity(directory.stat(follow_symlinks=False)) != identity(before):
            raise ValueError('candidate changed')

    walk(root)
    return result.hexdigest()


def entry_identity(entry):
    if entry.parent.is_symlink() or not entry.is_symlink():
        raise ValueError('runtime entrypoint must be a package symlink')
    info = entry.lstat()
    target = entry.resolve(strict=True)
    if not target.is_file() or target.stat().st_size > MAX_ARTIFACT:
        raise ValueError('invalid runtime entrypoint')
    return digest([os.readlink(entry), info.st_dev, info.st_ino, info.st_mtime_ns,
                   info.st_ctime_ns, hashlib.sha256(target.read_bytes()).hexdigest()])


def checked_candidate(value, release):
    if (not isinstance(value, dict) or set(value) != {'version', 'integrity', 'tree_sha256',
            'previous_target', 'previous_identity'} or value['version'] != release['version']
            or value['integrity'] != release['integrity']
            or any(not isinstance(value[k], str) or not re.fullmatch('[0-9a-f]{64}', value[k])
                   for k in ('tree_sha256', 'previous_identity'))
            or not isinstance(value['previous_target'], str) or not value['previous_target']
            or len(value['previous_target']) > 4096):
        raise ValueError('invalid candidate identity')
    return value


def checked_evidence(evidence, candidate, release, profile):
    if (not isinstance(profile, dict) or not isinstance(evidence, dict)
            or set(evidence) != {'candidate_hash', 'release_hash', 'profile_hash', 'node', 'checks'}
            or evidence['candidate_hash'] != digest(candidate)
            or evidence['release_hash'] != digest(release) or evidence['profile_hash'] != digest(profile)
            or not isinstance(evidence['node'], str) or not re.fullmatch(VERSION, evidence['node'])
            or tuple(map(int, evidence['node'].split('.'))) < tuple(map(int, release['node'][2:].split('.')))
            or not isinstance(evidence['checks'], dict) or set(evidence['checks']) != set(CHECKS)
            or any(value is not True for value in evidence['checks'].values())):
        raise ValueError('compatibility evidence missing or changed')
    return evidence


def install(prefix, version, task, action='prepare', *, release=None, candidate=None, evidence=None, profile=None):
    if (not isinstance(version, str) or len(version) > 64 or not re.fullmatch(VERSION, version)
            or not re.fullmatch('[0-9a-f]{32}', task) or action not in ('prepare', 'validate', 'activate')):
        raise ValueError('invalid exact runtime version or task')
    prefix = Path(prefix)
    activated = False
    try:
        pinned_release(release, version)
        if prefix.is_symlink() or not prefix.is_dir():
            raise ValueError('invalid runtime prefix')
        # Validate mounts are readonly; no lock creation or receipt writes here.
        lock_path = prefix / '.pi-runtime-update.lock'
        flags = os.O_RDONLY if action == 'validate' else os.O_RDWR | os.O_CREAT
        descriptor = os.open(lock_path, flags | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'rb' if action == 'validate' else 'r+b') as lock:
            if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
                raise ValueError('invalid runtime lock')
            fcntl.flock(lock, (fcntl.LOCK_SH if action == 'validate' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            entry = prefix / 'bin/pi'
            previous_identity = entry_identity(entry)
            previous = os.readlink(entry)
            releases = prefix / '.pi-releases'
            if action == 'prepare':
                releases.mkdir(mode=0o755, exist_ok=True)
            if releases.is_symlink() or not releases.is_dir():
                raise ValueError('invalid releases directory')
            directory = releases / task
            executable = directory / 'bin/pi'
            if action == 'prepare':
                if directory.exists() or directory.is_symlink():
                    return {'ok': False, 'stage': 'activation_unknown'}
                directory.mkdir(mode=0o755)
                data = download(release['tarball'])
                check_archive(data, release)
                with tempfile.TemporaryDirectory(prefix='pi-runtime-npm-') as scratch:
                    artifact = Path(scratch) / 'official.tgz'
                    artifact.write_bytes(data)
                    guard = Path(scratch) / 'npm-origin.cjs'
                    guard.write_text(NPM_NETWORK_GUARD)
                    environment = {'HOME': scratch, 'PATH': '/usr/local/bin:/usr/bin:/bin',
                        'NPM_CONFIG_USERCONFIG': '/dev/null', 'NPM_CONFIG_GLOBALCONFIG': scratch + '/globalrc',
                        'NPM_CONFIG_CACHE': scratch + '/cache', 'NPM_CONFIG_PREFIX': str(directory),
                        'NODE_OPTIONS': '--require=' + str(guard)}
                    command = ['/usr/local/bin/npm', '--prefix', str(directory), 'install', '-g',
                               '--ignore-scripts', '--min-release-age=0', '--no-audit', '--no-fund',
                               '--fetch-retries=0', '--fetch-timeout=60000',
                               '--registry=' + REGISTRY, str(artifact)]
                    subprocess.run(command, env=environment, cwd=scratch, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=840, check=True)
                    if Path(str(guard) + '.denied').exists():
                        raise ValueError('npm transport policy violation')
                package = directory / 'lib/node_modules' / PACKAGE / 'package.json'
                if not package.resolve(strict=True).is_relative_to(directory.resolve(strict=True)):
                    raise ValueError('package escapes candidate')
                metadata = json.loads(package.read_text())
                if metadata.get('name') != PACKAGE or metadata.get('version') != version:
                    raise ValueError('installed package identity mismatch')
                candidate = {'version': version, 'integrity': release['integrity'],
                    'previous_target': previous, 'previous_identity': previous_identity,
                    'tree_sha256': tree_digest(directory)}
            else:
                checked_candidate(candidate, release)
                if (candidate['previous_target'] != previous or candidate['previous_identity'] != previous_identity
                        or candidate['tree_sha256'] != tree_digest(directory)):
                    return {'ok': False, 'stage': 'candidate_changed'}
            if not executable.resolve(strict=True).is_relative_to(directory.resolve(strict=True)):
                raise ValueError('candidate escapes release')
            if entry_identity(entry) != previous_identity:
                return {'ok': False, 'stage': 'entrypoint_changed'}
            if action == 'prepare':
                return {'ok': True, 'version': version, 'changed': False, 'candidate': candidate}
            if action == 'validate':
                if not isinstance(profile, dict):
                    return {'ok': False, 'stage': 'compatibility_probe_unavailable'}
                try:
                    value = run_probe({'task': task, 'release': release, 'candidate': candidate, 'profile': profile})
                    checked_evidence(value.get('evidence'), candidate, release, profile)
                    if (set(value) != {'ok', 'version', 'changed', 'evidence'} or value['changed'] is not False
                            or value['version'] != version or candidate['tree_sha256'] != tree_digest(directory)
                            or previous_identity != entry_identity(entry)):
                        raise ValueError('probe binding changed')
                    return value
                except Exception:
                    return {'ok': False, 'stage': 'compatibility_probe_failed'}
            checked_evidence(evidence, candidate, release, profile)
            link = entry.parent / ('.pi-update-' + task)
            link.symlink_to(executable)
            activated = True
            os.replace(link, entry)
            descriptor = os.open(entry.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            return {'ok': True, 'version': version, 'changed': True}
    except Exception:
        return {'ok': False, 'stage': 'activation_unknown' if activated else 'install_failed'}


if __name__ == '__main__':
    arguments = json.loads(sys.argv[4]) if len(sys.argv) == 5 else {}
    outcome = install(Path('/home/node/.local'), sys.argv[1], sys.argv[2], sys.argv[3], **arguments)
    print(json.dumps(outcome, separators=(',', ':')), flush=True)
    sys.exit(0 if outcome['ok'] else 1)

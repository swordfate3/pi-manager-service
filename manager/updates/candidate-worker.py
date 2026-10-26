"""Fixed isolated npm worker. Never imports or executes candidate code.

All npm writes are inside one kernel-size/inode-bounded /work tmpfs. Only
validated, frozen files are exported through a bounded line protocol; no host
output directory is mounted. The parent independently bounds writes and hashes.
"""
import ast
import base64
import hashlib
import json
import os
import platform
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import time

MAX_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 60000
VERSION = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
NAME = r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*'

def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))

def integrity(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', value):
        raise ValueError('integrity invalid')
    raw = base64.b64decode(value[7:], validate=True)
    if len(raw) != 64 or base64.b64encode(raw).decode() != value[7:]: raise ValueError('integrity invalid')

def declarations(record):
    for field in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        values = record.get(field, {})
        if not isinstance(values, dict): raise ValueError('dependency declarations invalid')
        for name, value in values.items():
            if (not re.fullmatch(NAME, name) or not isinstance(value, str) or len(value) > 256
                    or not re.fullmatch(r'[0-9xX*^~<>=| .+-]+', value)):
                raise ValueError('dependency source refused')
    if record.get('bundledDependencies') or record.get('bundleDependencies') or record.get('inBundle') or record.get('link'):
        raise ValueError('unproven bundled/link source')

def validate_lock(value, release):
    if not isinstance(value, dict) or value.get('lockfileVersion') != 3 or not isinstance(value.get('packages'), dict):
        raise ValueError('lock v3 required')
    packages = value['packages']; top = 'node_modules/' + release['packageName']
    if len(packages) > MAX_ENTRIES or '' not in packages or top not in packages: raise ValueError('lock closure invalid')
    if packages[''].get('dependencies') != {release['packageName']: 'file:/input/artifact.tgz'}:
        raise ValueError('root artifact binding invalid')
    if any(packages[''].get(k) for k in ('optionalDependencies', 'peerDependencies', 'devDependencies')):
        raise ValueError('root declarations invalid')
    for key, item in packages.items():
        if key == '': continue
        if not isinstance(item, dict) or not re.fullmatch(r'(?:node_modules/' + NAME + r'/)*node_modules/' + NAME, key):
            raise ValueError('lock path invalid')
        name = key.rsplit('node_modules/', 1)[1]
        version = item.get('version')
        if not isinstance(version, str) or not re.fullmatch(VERSION, version) or len(version) > 64:
            raise ValueError('stable lock version required')
        if item.get('name', name) != name: raise ValueError('package alias refused')
        declarations(item); integrity(item.get('integrity'))
        if item.get('dev'): raise ValueError('development package in closure')
        if key == top:
            # npm 11.19.0 writes this exact relative spelling from /work/tree.
            if (version != release['version'] or item.get('resolved') not in ('file:/input/artifact.tgz', 'file:../../input/artifact.tgz')
                    or item['integrity'] != release['integrity']):
                raise ValueError('top artifact changed: version=' + str(version)[:64] + ', resolved=' + str(item.get('resolved'))[:128]
                                 + ', integrity_matches=' + str(item['integrity'] == release['integrity']))
        elif item.get('resolved') != 'https://registry.npmjs.org/' + name + '/-/' + name.split('/')[-1] + '-' + version + '.tgz':
            raise ValueError('nonofficial recursive source')
    return packages

def safe_relative(name, max_depth=32):
    parts = name.split('/')
    return (0 < len(name) <= 1024 and len(parts) <= max_depth and all(
        p not in ('', '.', '..') and re.fullmatch(r'[\x21-\x7e]+', p) and not re.search(r'[\\:<>"|?*]', p) for p in parts))

def optional_omission(item, system, cpu, libc):
    if item.get('optional') is not True: raise ValueError('required package omitted')
    for field, current in [('os', system), ('cpu', cpu), ('libc', libc)]:
        allowed = item.get(field, [])
        if not isinstance(allowed, list) or any(not isinstance(v, str) for v in allowed): raise ValueError('platform metadata invalid')
        positive = [v for v in allowed if not v.startswith('!')]
        if '!' + current in allowed or (positive and current not in positive and 'any' not in positive): return field
    raise ValueError('optional omission without platform evidence')

def tree_evidence(root, max_bytes=MAX_BYTES, max_entries=MAX_ENTRIES, max_depth=32):
    root = Path(root); rows = []; size = 0; count = 0
    def visit(directory, prefix=''):
        nonlocal size, count
        with os.scandir(directory) as entries:
            for entry in entries:
                name = prefix + entry.name; count += 1
                if count > max_entries or not safe_relative(name, max_depth): raise ValueError('tree entry/depth limit')
                info = entry.stat(follow_symlinks=False); mode = stat.S_IMODE(info.st_mode)
                if mode & 0o7000: raise ValueError('special mode refused')
                if stat.S_ISDIR(info.st_mode):
                    rows.append([name, 'directory', mode]); visit(Path(entry.path), name + '/')
                elif stat.S_ISREG(info.st_mode):
                    size += info.st_size
                    if size > max_bytes or info.st_nlink != 1: raise ValueError('tree bytes/hardlink refused')
                    h = hashlib.sha256()
                    with open(entry.path, 'rb') as stream:
                        while chunk := stream.read(65536): h.update(chunk)
                    after = os.stat(entry.path, follow_symlinks=False)
                    identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                    if identity(after) != identity(info): raise ValueError('tree changed')
                    rows.append([name, 'file', mode, info.st_size, h.hexdigest()])
                elif stat.S_ISLNK(info.st_mode):
                    target = os.readlink(entry.path)
                    size += len(target.encode())
                    if size > max_bytes: raise ValueError('tree byte limit')
                    if (PurePosixPath(name).parent.name != '.bin' or target.startswith('/') or len(target) > 1024
                            or not re.fullmatch(r'[a-zA-Z0-9@_./-]+', target)):
                        raise ValueError('unsafe bin link')
                    resolved = Path(entry.path).resolve(strict=True)
                    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file(): raise ValueError('bin escapes tree')
                    rows.append([name, 'link', target])
                else: raise ValueError('special entry refused')
    visit(root); rows.sort(key=lambda row: row[0])
    return {'sha256': sha(canonical(rows).encode()), 'rows': rows, 'bytes': size, 'entries': count}

def reconcile_bins(root, manifests, rows):
    """Every installed production declaration must have its exact npm scope link.

    Fail closed on shared-scope name collisions; do not infer npm's winning
    package. Separate nested node_modules scopes may expose the same bin name.
    Rows come from the complete actual filesystem walk, never from the lock.
    """
    root = Path(root); indexed = {row[0]: row for row in rows}; expected = {}
    for key, manifest in sorted(manifests.items()):
        bins = manifest.get('bin', {})
        if isinstance(bins, str): bins = {manifest['name'].split('/')[-1]: bins}
        if not isinstance(bins, dict): raise ValueError('bin declarations invalid')
        # The final node_modules component owns the .bin scope, including
        # scoped packages (not @scope/.bin) and nested installations.
        scope = key.rsplit('node_modules/', 1)[0] + 'node_modules/.bin/'
        for name, relative in bins.items():
            if (not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]+', name) or name in ('.', '..')
                    or not isinstance(relative, str)):
                raise ValueError('bin declarations invalid')
            target = key + '/' + relative.removeprefix('./')
            if not safe_relative(target): raise ValueError('executable path invalid')
            link = scope + name
            if link in expected: raise ValueError('bin collision in installation scope: ' + link)
            expected[link] = (name, target)
    executables = []
    for link, (name, target) in sorted(expected.items()):
        entry = indexed.get(link); executable = indexed.get(target)
        if entry is None: raise ValueError('bin link missing: ' + link)
        if executable is None or executable[1] != 'file' or not executable[2] & 0o111:
            raise ValueError('bin target not regular executable: ' + target)
        relative = os.path.relpath(root / target, (root / link).parent)
        if (entry[1] != 'link' or entry[2] != relative or not (root / link).is_symlink()
                or os.readlink(root / link) != relative or (root / link).resolve(strict=True) != root / target):
            raise ValueError('bin link target changed: ' + link)
        executables.append({'name': name, 'relativePath': target, 'sha256': executable[4], 'binLink': link})
    if any(row[1] == 'link' and row[0] not in expected for row in rows):
        raise ValueError('undeclared bin link')
    return executables

def run_bounded(argv, *, cwd, env, timeout=120, max_output=4 * 1024 * 1024):
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector(); buffers = [bytearray(), bytearray()]; total = 0
    for i, stream in enumerate((proc.stdout, proc.stderr)): selector.register(stream, selectors.EVENT_READ, i)
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() >= deadline: raise ValueError('npm deadline exceeded')
            for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk: selector.unregister(key.fileobj); continue
                total += len(chunk)
                if total > max_output: raise ValueError('npm output exceeded')
                buffers[key.data].extend(chunk)
        result = proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        if result != 0: raise ValueError('npm command failed (' + str(result) + '): ' + bytes(buffers[1][:2048]).decode('utf-8', errors='replace'))
        return bytes(buffers[0])
    finally:
        if proc.poll() is None: os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(); selector.close(); proc.stdout.close(); proc.stderr.close()

def main(request):
    release = request['release']; work = Path('/work'); tree = work / 'tree'; tree.mkdir(mode=0o700)
    for name in ('home', 'cache', 'scratch'): (work / name).mkdir(mode=0o700)
    artifact = Path('/input/artifact.tgz').read_bytes()
    if len(artifact) > 32 * 1024 * 1024 or 'sha512-' + base64.b64encode(hashlib.sha512(artifact).digest()).decode() != release['integrity']:
        raise ValueError('artifact changed at worker boundary')
    with tarfile.open('/input/artifact.tgz', 'r:gz') as archive:
        manifest = archive.extractfile('package/package.json')
        value = strict_json(manifest.read(1024 * 1024 + 1))
        if value.get('name') != release['packageName'] or value.get('version') != release['version']: raise ValueError('manifest mismatch')
        declarations(value)
    # Reuse exactly the audited source, not a fork silently diverging from Gate.
    source = ast.parse(Path('/guard-source.py').read_text())
    guard = next(ast.literal_eval(n.value) for n in source.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == 'NPM_NETWORK_GUARD' for t in n.targets))
    guard_file = work / 'guard.cjs'; guard_file.write_text(guard)
    for name in ('user.npmrc', 'global.npmrc'): (work / name).write_text('')
    env = {'HOME': '/work/home', 'PATH': '/usr/local/bin:/usr/bin:/bin', 'TMPDIR': '/work/scratch',
           'NODE_OPTIONS': '--require=/work/guard.cjs', 'NPM_CONFIG_USERCONFIG': '/work/user.npmrc',
           'NPM_CONFIG_GLOBALCONFIG': '/work/global.npmrc', 'NPM_CONFIG_CACHE': '/work/cache',
           'NPM_CONFIG_PREFIX': '/work/tree', 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/',
           'NPM_CONFIG_UPDATE_NOTIFIER': 'false', 'NPM_CONFIG_IGNORE_SCRIPTS': 'true', 'NPM_CONFIG_AUDIT': 'false',
           'NPM_CONFIG_FUND': 'false', 'NPM_CONFIG_ENGINE_STRICT': 'true', 'NPM_CONFIG_FETCH_RETRIES': '0',
           'NPM_CONFIG_FETCH_TIMEOUT': '15000', 'NPM_CONFIG_LOGS_MAX': '0'}
    npm = ['/usr/local/bin/node', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']
    def run(args, timeout=120):
        try: output = run_bounded(npm + args, cwd=str(tree), env=env, timeout=timeout)
        except ValueError as error: raise ValueError(args[0] + ': ' + str(error)) from None
        if Path(str(guard_file) + '.denied').exists(): raise ValueError('npm origin policy denied, including optional fallback')
        return output
    node_version = run_bounded(['/usr/local/bin/node', '--version'], cwd=str(tree), env=env, timeout=5).decode().strip()
    npm_version = run(['--version'], 5).decode().strip()
    (tree / 'package.json').write_text(canonical({'name': 'candidate', 'version': '1.0.0', 'private': True,
        'dependencies': {release['packageName']: 'file:/input/artifact.tgz'}}))
    run(['install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'])
    lock_bytes = (tree / 'package-lock.json').read_bytes()
    if len(lock_bytes) > 8 * 1024 * 1024: raise ValueError('lock too large')
    packages = validate_lock(strict_json(lock_bytes), release)
    run(['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'])
    if (tree / 'package-lock.json').read_bytes() != lock_bytes: raise ValueError('lock changed during ci')
    validation = run(['ls', '--all', '--omit=dev', '--json'])
    parsed = strict_json(validation)
    def no_problems(item):
        if not isinstance(item, dict) or item.get('problems') or item.get('invalid') or item.get('missing') or item.get('extraneous'):
            raise ValueError('npm dependency validation failed')
        for child in item.get('dependencies', {}).values(): no_problems(child)
    no_problems(parsed)
    omitted = []; manifests = {}
    for key, item in packages.items():
        if key == '': continue
        manifest_path = tree / key / 'package.json'
        if not manifest_path.exists():
            arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
            reason = optional_omission(item, 'linux', arch, platform.libc_ver()[0])
            omitted.append({'path': key, 'version': item['version'], 'os': item.get('os', []), 'cpu': item.get('cpu', []), 'libc': item.get('libc', []), 'reason': 'unsupported-' + reason})
            continue
        if manifest_path.stat().st_size > 1024 * 1024: raise ValueError('manifest too large')
        installed = strict_json(manifest_path.read_bytes())
        if installed.get('name') != key.rsplit('node_modules/', 1)[1] or installed.get('version') != item['version']:
            raise ValueError('installed package binding changed')
        declarations(installed)
        manifests[key] = installed
    # No interpreter imports the installed tree. Freeze then hash all bytes/modes.
    initial = tree_evidence(tree)
    for row in reversed(initial['rows']):
        if row[1] != 'link': os.chmod(tree / row[0], 0o500 if row[1] == 'directory' or row[2] & 0o111 else 0o400)
    tree.chmod(0o500); evidence = tree_evidence(tree)
    executables = reconcile_bins(tree, manifests, evidence['rows'])
    for row in evidence['rows']:
        print(canonical({'entry': row}), flush=True)
        if row[1] == 'file':
            with open(tree / row[0], 'rb') as stream:
                while chunk := stream.read(49152): print(canonical({'data': base64.b64encode(chunk).decode()}), flush=True)
            print('{"end":true}', flush=True)
    result = {'schema': 1, 'status': 'installed-unverified', 'runnable': False, 'activation': 'not-attempted',
        'release': release, 'candidateId': request['candidateId'], 'image': request['image'],
        'node': node_version, 'npm': npm_version, 'lockSha256': sha(lock_bytes), 'contentSha256': evidence['sha256'],
        'bytes': evidence['bytes'], 'entries': evidence['entries'], 'executables': executables,
        'optionalOmissions': omitted, 'dependencyValidationSha256': sha(validation), 'lifecycleMarkerAbsent': not (work / 'LIFECYCLE-RAN').exists()}
    if len(canonical(result)) > 1024 * 1024: raise ValueError('receipt too large')
    print(canonical({'result': result}), flush=True)

if __name__ == '__main__':
    try:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(ValueError('worker deadline exceeded')))
        signal.alarm(300)
        main(strict_json(base64.b64decode(sys.argv[1], validate=True)))
    except Exception as error:
        # Fixed categorization only; never stream npm diagnostics/credential-bearing URLs.
        print(canonical({'error': str(error) if isinstance(error, ValueError) else type(error).__name__})[:1024], file=sys.stderr)
        sys.exit(1)

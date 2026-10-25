#!/usr/bin/env python3
"""Fixed image-owned, offline real-Pi compatibility experiment.

Gate verifies this source before invocation and owns Docker isolation/admission.
stdin is identities, never commands/paths/checks. Only model answers are fake.
The CLI has no local/unsafe mode; unit tests of helpers are not evidence.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import uuid

RUNTIME = Path('/usr/local/lib/pi-runtime')
WEB = Path('/opt/pi-web-ui')
PREFIX = Path('/home/node/.local')
NODE = Path('/usr/local/bin/node')
PACKAGE = '@earendil-works/pi-coding-agent'
VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
CHECKS = ('exact_version', 'node_engine', 'web_extension', 'pty_guard',
          'input_barrier', 'async_taint', 'generation_idle', 'session_restore', 'no_replay')
PROBE_FILES = ('runtime_probe.py', 'runtime_probe_provider.ts', 'runtime_probe_ws.mjs')
MAX_MESSAGE = 16384
MAX_TRACE = 1024 * 1024


class ProbeFailure(Exception):
    """Only fixed stage codes escape the CLI, never candidate/session output."""


def require(condition, stage='contract'):
    if not condition:
        raise ProbeFailure(stage)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def stable_stat(info):
    # Reads legitimately change atime on relatime mounts; identity/content
    # comparisons retain nanosecond mtime/ctime and exclude access time.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid,
            info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def tree_digest(root):
    """Same serialization as task4a; additionally reject absolute internal links.

    Preserve relative links when relocating, never follow them while copying.
    Read-only input mounts are still required: hashing is not a hostile-writer lock.
    """
    root = Path(root)
    require(not root.is_symlink() and root.is_dir(), 'candidate')
    resolved = root.resolve(strict=True)
    result = hashlib.sha256()
    count, total = 0, 0

    def walk(directory):
        nonlocal count, total
        before = directory.stat(follow_symlinks=False)
        for entry in sorted(directory.iterdir(), key=lambda p: p.name):
            count += 1
            info = entry.lstat()
            require(count <= 100000, 'candidate_size')
            record = [str(entry.relative_to(root)), stat.S_IMODE(info.st_mode)]
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(entry)
                require(not os.path.isabs(target), 'candidate_link')
                try:
                    require(entry.resolve(strict=True).is_relative_to(resolved), 'candidate_link')
                except (OSError, RuntimeError) as error:
                    raise ProbeFailure('candidate_link') from error
                record += ['link', target]
            elif stat.S_ISDIR(info.st_mode):
                record += ['directory']
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
                require(total <= 2 * 1024 * 1024 * 1024, 'candidate_size')
                content = hashlib.sha256()
                with os.fdopen(os.open(entry, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                    require(stable_stat(os.fstat(stream.fileno())) == stable_stat(info), 'candidate_changed')
                    while chunk := stream.read(65536):
                        content.update(chunk)
                    require(stable_stat(os.fstat(stream.fileno())) == stable_stat(info), 'candidate_changed')
                record += ['file', info.st_size, content.hexdigest()]
            else:
                raise ProbeFailure('candidate_entry')
            result.update(json.dumps(record, separators=(',', ':')).encode() + b'\n')
            if stat.S_ISDIR(info.st_mode):
                walk(entry)
            require(stable_stat(entry.lstat()) == stable_stat(info), 'candidate_changed')
        require(stable_stat(directory.stat(follow_symlinks=False)) == stable_stat(before), 'candidate_changed')

    walk(root)
    return result.hexdigest()


def copy_candidate(source, destination, expected):
    require(tree_digest(source) == expected, 'candidate_changed')
    shutil.copytree(source, destination, symlinks=True)
    require(tree_digest(destination) == expected and tree_digest(source) == expected, 'candidate_changed')


def file_set_digest(root, names):
    rows = []
    for name in sorted(names):
        path = root / name
        require(not path.is_symlink() and path.is_file(), 'source')
        rows.append((name, hashlib.sha256(path.read_bytes()).hexdigest()))
    require(rows, 'source')
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()


def source_digest(root, suffixes):
    return file_set_digest(root, [str(p.relative_to(root)) for p in root.rglob('*')
                                  if p.is_file() and p.suffix in suffixes])


def immutable_sources(root):
    require(root.resolve(strict=True) == root, 'source')
    for path in [root, *root.parents, *root.rglob('*')]:
        info = path.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and
                not stat.S_ISLNK(info.st_mode), 'source_ownership')


def clean_environment(directory):
    # Nothing is inherited, including loaders, proxies, tokens, Pi discovery
    # configuration, npm configuration, SSH and Python search paths.
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(directory / 'home'),
            'TMPDIR': str(directory), 'XDG_CONFIG_HOME': str(directory / 'config'),
            'XDG_CACHE_HOME': str(directory / 'cache'), 'TERM': 'xterm-256color',
            'LANG': 'C.UTF-8', 'PI_OFFLINE': '1',
            'PI_CODING_AGENT_DIR': str(directory / 'agent'),
            'NPM_CONFIG_USERCONFIG': '/dev/null', 'NPM_CONFIG_GLOBALCONFIG': '/dev/null'}


def stop_group(process):
    # Every process here is a disposable probe child, never a live consumer.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=2)


def run_bounded(argv, cwd, env, *, timeout=15, limit=65536, payload=None):
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if payload else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        if payload:
            require(len(payload) <= MAX_MESSAGE, 'input_size')
            process.stdin.write(payload)
            process.stdin.close()
        while True:
            require(time.monotonic() < deadline, 'process_timeout')
            if select.select([process.stdout], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.extend(chunk)
                require(len(output) <= limit, 'process_output')
        require(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, 'process_exit')
        return bytes(output)
    finally:
        stop_group(process)
        process.stdout.close()
        if process.stdin and not process.stdin.closed:
            process.stdin.close()


def observations(path):
    if not path.exists():
        return []
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_TRACE, 'trace')
    raw = path.read_bytes()
    require(len(raw) <= MAX_TRACE and (not raw or raw.endswith(b'\n')), 'trace')
    try:
        rows = [json.loads(line) for line in raw.splitlines()]
    except (ValueError, UnicodeError) as error:
        raise ProbeFailure('trace') from error
    require(all(isinstance(row, dict) for row in rows), 'trace')
    return rows


def evidence(candidate, release, profile, node, checks):
    node_compatible(release, node)
    require(isinstance(checks, dict) and set(checks) == set(CHECKS) and
            all(value is True for value in checks.values()), 'checks')
    return {'candidate_hash': digest(candidate), 'release_hash': digest(release),
            'profile_hash': digest(profile), 'node': node, 'checks': dict(checks)}


def node_compatible(release, node):
    require(isinstance(node, str) and re.fullmatch(VERSION, node), 'node')
    require(re.fullmatch('>=' + VERSION, release['node']), 'engine')
    require(tuple(map(int, node.split('.'))) >= tuple(map(int, release['node'][2:].split('.'))), 'engine')


def request_identity(value):
    require(isinstance(value, dict) and set(value) == {'task', 'release', 'candidate', 'profile'}, 'request')
    require(isinstance(value['task'], str) and re.fullmatch('[0-9a-f]{32}', value['task']), 'task')
    release, candidate, profile = (value[k] for k in ('release', 'candidate', 'profile'))
    require(isinstance(release, dict) and set(release) == {'version', 'integrity', 'tarball', 'node'}, 'release')
    version = release['version']
    require(isinstance(version, str) and len(version) <= 64 and re.fullmatch(VERSION, version), 'version')
    require(release['tarball'] == 'https://registry.npmjs.org/' + PACKAGE + '/-/pi-coding-agent-' + version + '.tgz', 'release')
    require(isinstance(release['node'], str) and re.fullmatch('>=' + VERSION, release['node']), 'engine')
    integrity = release['integrity']
    require(isinstance(integrity, str) and integrity.startswith('sha512-'), 'integrity')
    raw = base64.b64decode(integrity[7:], validate=True)
    require(len(raw) == 64 and base64.b64encode(raw).decode() == integrity[7:], 'integrity')
    require(isinstance(candidate, dict) and set(candidate) == {
        'version', 'integrity', 'tree_sha256', 'previous_target', 'previous_identity'}, 'candidate')
    require(candidate['version'] == version and candidate['integrity'] == integrity, 'candidate')
    for key in ('tree_sha256', 'previous_identity'):
        require(isinstance(candidate[key], str) and re.fullmatch('[0-9a-f]{64}', candidate[key]), 'candidate')
    require(isinstance(candidate['previous_target'], str) and 0 < len(candidate['previous_target']) <= 4096, 'candidate')
    require(isinstance(profile, dict) and profile.get('contract') == 'pi-runtime-validation-v1', 'profile')
    require(isinstance(profile.get('image'), str) and re.fullmatch('sha256:[0-9a-f]{64}', profile['image']), 'profile')
    for key in ('helper_sha256', 'adapter_sha256', 'web_sha256', 'probe_sha256'):
        require(isinstance(profile.get(key), str) and re.fullmatch('[0-9a-f]{64}', profile[key]), 'profile')
    return release, candidate, profile


def isolation():
    """Defense in depth; Gate must independently inspect the exact Docker spec."""
    require(os.getuid() != 0, 'isolation_uid')
    require(set(os.listdir('/sys/class/net')) <= {'lo'}, 'isolation_network')
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        fields, filesystem = left.split(), right.split()
        mounts[fields[4]] = (set(fields[5].split(',')), filesystem[0])
    require('ro' in mounts['/'][0], 'isolation_root')
    require('ro' in mounts[str(PREFIX)][0], 'isolation_candidate')
    require(mounts['/tmp'][1] == 'tmpfs' and {'rw', 'nosuid', 'nodev'} <= mounts['/tmp'][0], 'isolation_tmp')
    require(not Path('/var/run/docker.sock').exists(), 'isolation_socket')
    # Standard container pseudo-filesystems and Docker-generated host files are
    # inert. Any additional mount (especially home/workspace/secrets) is refused.
    for path in mounts:
        require(path in ('/', '/tmp', str(PREFIX), '/etc/hosts', '/etc/hostname', '/etc/resolv.conf') or
                any(path == root or path.startswith(root + '/') for root in ('/proc', '/sys', '/dev')), 'isolation_mount')


def package_layout(prefix):
    package = prefix / 'lib/node_modules' / PACKAGE
    require((package / 'package.json').stat().st_size <= 1024 * 1024, 'package_metadata')
    metadata = json.loads((package / 'package.json').read_text())
    require(metadata.get('name') == PACKAGE and isinstance(metadata.get('version'), str) and
            re.fullmatch(VERSION, metadata['version']), 'package')
    require((prefix / 'bin/pi').resolve(strict=True).is_relative_to(prefix.resolve(strict=True)), 'package_entry')
    return package, metadata['version']


def stage_web(directory, candidate):
    """Resolve every SDK import to the disposable candidate, including jiti's peers."""
    package, _version = package_layout(candidate)
    # npm global installs normally nest these dependencies. Permit hoisting
    # only inside this candidate, never the image's initial 1.3 installation.
    ai = next((parent / 'node_modules/@earendil-works/pi-ai' for parent in [package, *package.parents]
               if parent.is_relative_to(candidate) and
               (parent / 'node_modules/@earendil-works/pi-ai/package.json').is_file()), None)
    require(ai is not None and ai.resolve(strict=True).is_relative_to(candidate.resolve(strict=True)), 'candidate_sdk')
    shutil.copytree(WEB / 'extensions', directory / 'extensions')
    shutil.copytree(WEB / 'node_modules/ws', directory / 'node_modules/ws')
    (directory / 'package.json').write_text('{"type":"module"}')
    peers = directory / 'node_modules/@earendil-works'
    peers.mkdir()
    (peers / 'pi-coding-agent').symlink_to(package)
    (peers / 'pi-ai').symlink_to(ai)
    shutil.copy2(RUNTIME / 'runtime_probe_provider.ts', directory / 'runtime_probe_provider.ts')
    require((peers / 'pi-coding-agent').resolve() == package.resolve(), 'candidate_sdk')
    return directory


def seed_session(path, cwd):
    """A persisted branch with model/thinking and a saved prompt that must not run."""
    timestamp = '2026-10-22T00:00:00.000Z'
    entries = [
        {'type': 'session', 'version': 3, 'id': 'probe-saved-session', 'timestamp': timestamp, 'cwd': str(cwd)},
        {'type': 'model_change', 'id': 'probe-model', 'parentId': None, 'timestamp': timestamp,
         'provider': 'runtime-probe', 'modelId': 'probe-model'},
        {'type': 'thinking_level_change', 'id': 'probe-thinking', 'parentId': 'probe-model',
         'timestamp': timestamp, 'thinkingLevel': 'medium'},
        {'type': 'message', 'id': 'probe-user', 'parentId': 'probe-thinking', 'timestamp': timestamp,
         'message': {'role': 'user', 'content': 'PROBE_SAVED_DO_NOT_REPLAY', 'timestamp': 1792627200000}},
        {'type': 'message', 'id': 'probe-leaf', 'parentId': 'probe-user', 'timestamp': timestamp,
         'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Saved synthetic answer'}],
                     'api': 'openai-completions', 'provider': 'runtime-probe', 'model': 'probe-model',
                     'stopReason': 'stop', 'timestamp': 1792627200000,
                     'usage': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2,
                               'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}}},
    ]
    path.write_text(''.join(json.dumps(entry, separators=(',', ':')) + '\n' for entry in entries))


def ipc(path, value):
    payload = json.dumps(value, separators=(',', ':')).encode() + b'\n'
    require(len(payload) <= MAX_MESSAGE, 'ipc_input')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(str(path))
        connection.sendall(payload)
        output = bytearray()
        while b'\n' not in output:
            chunk = connection.recv(min(4096, MAX_MESSAGE + 1 - len(output)))
            require(chunk, 'ipc_eof')
            output.extend(chunk)
            require(len(output) <= MAX_MESSAGE, 'ipc_output')
    line, remainder = bytes(output).split(b'\n', 1)
    require(not remainder, 'ipc_output')
    result = json.loads(line)
    require(isinstance(result, dict) and type(result.get('ok')) is bool, 'ipc_response')
    return result


def probe_supervisor_main(argv=None):
    """Evaluate same-version refresh inside the fixed offline experiment only.

    The live supervisor has no environment/receipt/CLI bypass. This subclass
    exists only in the isolated probe process, with disposable Pi/session state;
    it cannot issue a live Gate grant or change another supervisor instance.
    """
    isolation()
    import pi_supervisor as live

    class ProbeSupervisor(live.PiSupervisor):
        def verify_restore_proof(self, request, snapshot):
            if request.get('restore_proof') is not None:
                return super().verify_restore_proof(request, snapshot)
            if self.restore_capture is not None or self.installed_version() != snapshot['version']:
                raise live.ProtocolError
            return None

    arguments = live.parse_arguments(sys.argv[1:] if argv is None else argv)
    return ProbeSupervisor(arguments.child, arguments.stop_timeout, arguments.start_timeout).run()


class RealPi:
    """Disposable real TUI, optionally using the isolated supervisor experiment."""
    def __init__(self, directory, candidate, web, *, supervisor=False, guard=True,
                 session=None, expected=None, bootstrap=False):
        self.directory, self.candidate, self.web = directory, candidate, web
        self.supervisor = supervisor
        self.process = None
        self.fd = None
        self.drainer = None
        self.closed = threading.Event()
        self.failure = None
        self.output = bytearray()
        directory.mkdir(mode=0o700)
        self.cwd = directory / 'workspace'
        self.cwd.mkdir()
        self.runtime = directory / 'runtime'
        self.runtime.mkdir(mode=0o700)
        self.trace = directory / 'observations.jsonl'
        self.session = directory / 'session.jsonl'
        if session is None:
            seed_session(self.session, self.cwd)
        else:
            shutil.copyfile(session, self.session)
        selection = {key: expected[key] for key in ('provider', 'model')} if expected else {
            'provider': 'runtime-probe', 'model': 'probe-model'}
        (directory / 'selection.json').write_text(json.dumps(selection))
        self.env = clean_environment(directory)
        for name in ('home', 'agent', 'config', 'cache'):
            (directory / name).mkdir(mode=0o700)
        (directory / 'agent/settings.json').write_text('{"packages":[],"extensions":[],"autoCompact":false}')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.run_id, self.token = uuid.uuid4().hex, uuid.uuid4().hex + uuid.uuid4().hex
        self.env.update(PI_RUNTIME_RUN_ID=self.run_id, PI_RUNTIME_DIR=str(self.runtime),
                        PI_RUNTIME_PROBE_STATE=str(directory), PI_WEB_UI_HOST='127.0.0.1',
                        PI_WEB_UI_PORT=str(self.port), PI_WEB_UI_DISABLED='false',
                        PI_WEB_UI_STATIC_DIR=str(WEB / 'dist'))
        self.argv = [str(candidate / 'bin/pi'), '--provider', selection['provider'], '--model', selection['model'],
                     '--api-key', 'synthetic-probe-key', '--thinking', expected['thinking'] if expected else 'medium',
                     '--session', str(self.session), '--offline', '--no-tools', '--no-mcp', '--no-skills',
                     '--no-context-files', '--no-prompt-templates', '--no-themes', '--tui-mode', 'regular',
                     '--extension', str(web / 'runtime_probe_provider.ts'),
                     '--extension', str(web / 'extensions/mirror-server.ts')]
        if bootstrap:
            self.argv.append('PROBE_BOOTSTRAP_ONCE')
        if supervisor:
            require(guard, 'supervisor_guard')
            launcher = ('import sys;sys.path.insert(0,' + repr(str(RUNTIME)) + ');'
                        'from runtime_probe import probe_supervisor_main;'
                        'raise SystemExit(probe_supervisor_main())')
            self.argv = ['/usr/bin/python3', '-I', '-c', launcher,
                         '--stop-timeout', '5', '--start-timeout', '25', '--', *self.argv]
        else:
            # Explicit Node invocation fixes the runtime even if the candidate
            # changes its shebang. Supervisor's env PATH selects this same Node.
            self.argv = [str(NODE), *self.argv]
            self.env.update(PI_RUNTIME_CHILD_TOKEN=self.token,
                            PI_RUNTIME_EXTENSION_SOCKET=str(self.runtime / 'extension.sock'))
            if guard:
                self.env['NODE_OPTIONS'] = '--import=' + str(RUNTIME / 'pi_stdin_guard.mjs')

    def __enter__(self):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
        try:
            self.process = subprocess.Popen(self.argv, cwd=self.cwd, env=self.env,
                                            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise
        finally:
            os.close(slave)
        try:
            self.drainer = threading.Thread(target=self.drain, daemon=True)
            self.drainer.start()
        except BaseException:
            stop_group(self.process)
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_exception):
        if self.process is not None:
            stop_group(self.process)
        self.closed.set()
        if self.drainer is not None:
            self.drainer.join(timeout=1)
        if self.fd is not None:
            os.close(self.fd)

    def drain(self):
        pending = b''
        total = 0
        try:
            while not self.closed.is_set():
                if not select.select([self.fd], [], [], .05)[0]:
                    continue
                data = os.read(self.fd, 65536)
                if not data:
                    return
                total += len(data)
                if total > 8 * 1024 * 1024:
                    self.failure = 'pty_output'
                    return
                self.output = (self.output + data)[-65536:]
                pending += data
                # Match across read boundaries; answer only complete audited
                # reports. Never send user bytes to satisfy a startup prompt.
                while True:
                    match = re.search(rb'\x1b\[(?:6n|c)', pending)
                    if not match:
                        pending = pending[-8:]
                        break
                    response = b'\x1b[1;1R' if match.group() == b'\x1b[6n' else b'\x1b[?1;2c'
                    os.write(self.fd, response)
                    pending = pending[match.end():]
        except OSError:
            return  # PTY EIO is normal when its child exits.

    def rows(self, event=None):
        result = observations(self.trace)
        return result if event is None else [row for row in result if row.get('event') == event]

    def wait(self, predicate, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            require(self.process.poll() is None and not self.failure, self.failure or 'pi_exit')
            try:
                result = predicate()
                if result:
                    return result
            except (OSError, KeyError, ValueError, TimeoutError):
                pass  # Startup sockets and state may not exist yet.
            time.sleep(.025)
        raise ProbeFailure('pi_timeout')

    def ws(self, method, params=None):
        def listening():
            with socket.create_connection(('127.0.0.1', self.port), timeout=.2):
                return True
        self.wait(listening)
        request = {'port': self.port, 'method': method, 'params': params or {}}
        return json.loads(run_bounded([str(NODE), str(RUNTIME / 'runtime_probe_ws.mjs')],
                                     self.cwd, clean_environment(self.directory), timeout=10,
                                     limit=MAX_MESSAGE, payload=json.dumps(request).encode()))

    def control(self, action, **fields):
        if self.supervisor:
            return ipc(self.runtime / 'control.sock', {'action': action, **fields})
        return ipc(self.runtime / 'extension.sock', {'action': action, 'token': self.token, **fields})

    def snapshot(self):
        if not self.supervisor:
            reply = self.control('snapshot')
            require(reply.get('ok') is True and isinstance(reply.get('result'), dict), 'snapshot')
            return reply['result']
        reply = self.control('status')
        require(reply.get('ok') is True and isinstance(reply.get('result'), dict), 'snapshot')
        status = reply['result']
        # Public supervisor status intentionally has no cwd/provider/model.
        # Correlate an actual Web state and child observation with this runtime.
        web = self.ws('get_state')
        require(web.get('ok') is True and web['state']['runtime_id'] == status['runtime_id'], 'snapshot')
        for key in ('session_id', 'leaf_id'):
            require(web['state'][key] == status[key], 'snapshot')
        starts = self.rows('session_start')
        require(starts, 'snapshot')
        return {**status, **web['state'], 'cwd': starts[-1]['cwd']}

    def ready(self, version, node, *, eligible=True):
        self.wait(lambda: self.rows('session_start'))
        start = self.rows('session_start')[-1]
        require(start['version'] == version and start['node'] == node and start['tty'] is True, 'pi_identity')
        require(start['executable'] == str(NODE.resolve(strict=True)), 'node_identity')
        require(Path(start['cli']).is_relative_to(self.candidate.resolve(strict=True)), 'candidate_sdk')
        value = self.wait(lambda: self.snapshot())
        if eligible:
            value = self.wait(lambda: (value if (value := self.snapshot())['idle'] is True and
                                      value['pending'] is False and value['busy'] is False else None))
        require(value['version'] == version and value['run_id'] == self.run_id, 'web_identity')
        web = self.ws('get_state')
        require(web.get('ok') is True and web['state']['runtime_id'] == value['runtime_id'], 'web_extension')
        return value

    @staticmethod
    def expected(value):
        return {key: value[key] for key in ('runtime_id', 'session_id', 'leaf_id')}

    def prepare(self, value, operation):
        return self.control('prepare', expected=self.expected(value), operation_id=operation)

    def settle(self, seconds=.35):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            require(self.process.poll() is None and not self.failure, 'pi_exit')
            self.rows()  # Enforce trace bound throughout the observation period.
            time.sleep(.025)

    def send(self, data):
        os.write(self.fd, data)


def behavioral_checks(root, candidate, version, node):
    """All true values below follow assertions on actual TUI/IPC/WS behavior."""
    checks = {}
    package, metadata_version = package_layout(candidate)
    require(metadata_version == version, 'version')
    metadata = json.loads((package / 'package.json').read_text())
    node_compatible({'node': metadata.get('engines', {}).get('node', '')}, node)
    output = run_bounded([str(NODE), str(candidate / 'bin/pi'), '--version'], root, clean_environment(root))
    require(output.decode().strip() == version, 'version')
    checks['exact_version'] = True
    checks['node_engine'] = True  # Parent checked engines; every child proves its Node identity.
    web = stage_web(root / 'web', candidate)
    with RealPi(root / 'generation', candidate, web) as pi:
        initial = pi.ready(version, node)
        require(initial['leaf_id'] == 'probe-leaf' and not pi.rows('provider_call'), 'saved_session')
        checks['web_extension'] = True
        operation = uuid.uuid4().hex
        require(pi.prepare(initial, operation).get('ok') is True, 'prepare')
        require(pi.control('cancel', operation_id=operation).get('ok') is True, 'cancel')
        require(pi.ws('prompt', {'message': 'PROBE_GENERATION'}).get('ok') is True, 'generation')
        pi.wait(lambda: pi.rows('provider_call'))
        during = pi.snapshot()
        require(during['idle'] is False or during['busy'] is True, 'generation_active')
        require(pi.prepare(during, uuid.uuid4().hex).get('ok') is False, 'generation_prepare')
        (pi.directory / 'release-generation').touch()
        pi.wait(lambda: pi.rows('agent_end'))
        idle = pi.wait(lambda: (value if (value := pi.snapshot())['idle'] is True and
                               value['pending'] is False and value['busy'] is False else None))
        require(len(pi.rows('provider_call')) == 1 and pi.rows('provider_call')[0].get('generation') is True,
                'generation_calls')
        checks['generation_idle'] = True
        operation = uuid.uuid4().hex
        require(pi.prepare(idle, operation).get('ok') is True, 'barrier_prepare')
        index = len(pi.rows('stdin'))
        pi.send(b'PROBE_BARRIER_DROP\r')
        pi.settle()
        require(len(pi.rows('stdin')) == index and pi.snapshot()['leaf_id'] == idle['leaf_id'] and
                len(pi.rows('provider_call')) == 1 and not pi.rows('tool_call'), 'barrier_drop')
        require(pi.control('cancel', operation_id=operation).get('ok') is True, 'barrier_cancel')
        # A barrier must discard input, not defer it until cancellation. Observe
        # release separately before fresh input can mask a buffered replay.
        pi.settle(.7)
        require(len(pi.rows('stdin')) == index and pi.snapshot()['leaf_id'] == idle['leaf_id'] and
                len(pi.rows('provider_call')) == 1 and not pi.rows('tool_call'), 'barrier_cancel_replay')
        pi.send(b'Z')
        pi.wait(lambda: len(pi.rows('stdin')) > index)
        pi.settle()
        released = pi.rows('stdin')[index:]
        delivered = b''.join(base64.b64decode(row['data'], validate=True) for row in released)
        require(delivered == b'Z' and pi.snapshot()['leaf_id'] == idle['leaf_id'] and
                len(pi.rows('provider_call')) == 1 and not pi.rows('tool_call'), 'barrier_release_replay')
        require(released[-1]['safe'] is False and released[-1]['intact'] is True and
                pi.snapshot()['busy'] is True, 'barrier_taint')
        checks['input_barrier'] = True
    for name, data in (('unknown', b'X'), ('fragment', b'\x1b[')):
        with RealPi(root / name, candidate, web) as pi:
            initial = pi.ready(version, node)
            index = len(pi.rows('stdin'))
            pi.send(data)
            rows = pi.wait(lambda: (rows if len(rows := pi.rows('stdin')) > index else None))
            # Observer is a downstream data listener in the same synchronous
            # emit: false here proves taint happened before parser completion.
            require(rows[index]['safe'] is False and rows[index]['intact'] is True, 'input_taint')
            require(pi.snapshot()['busy'] is True and
                    pi.prepare(initial, uuid.uuid4().hex).get('ok') is False, 'input_prepare')
            if name == 'unknown':
                old_runtime = pi.snapshot()['runtime_id']
                require(pi.ws('prompt', {'message': '/runtime-probe-reload'}).get('ok') is True, 'input_reload')
                pi.wait(lambda: len(pi.rows('session_start')) >= 2)
                reloaded = pi.wait(lambda: (value if (value := pi.snapshot())['runtime_id'] != old_runtime else None))
                require(reloaded['busy'] is True and
                        pi.prepare(reloaded, uuid.uuid4().hex).get('ok') is False, 'input_reload_taint')
            require(not pi.rows('provider_call') and not pi.rows('tool_call'), 'input_replay')
    checks['pty_guard'] = True
    with RealPi(root / 'async', candidate, web) as pi:
        initial = pi.ready(version, node)
        require(pi.ws('prompt', {'message': '/runtime-probe-async'}).get('ok') is True, 'async_dispatch')
        pi.wait(lambda: pi.rows('async_start'))
        require(pi.snapshot()['busy'] is True and
                pi.prepare(initial, uuid.uuid4().hex).get('ok') is False, 'async_active')
        (pi.directory / 'release-async').touch()
        pi.wait(lambda: pi.rows('async_complete'))
        pi.settle()
        require(pi.snapshot()['busy'] is True and
                pi.prepare(pi.snapshot(), uuid.uuid4().hex).get('ok') is False, 'async_taint')
        old_runtime = pi.snapshot()['runtime_id']
        require(pi.ws('prompt', {'message': '/runtime-probe-reload'}).get('ok') is True, 'reload_dispatch')
        pi.wait(lambda: len(pi.rows('session_start')) >= 2)
        refreshed = pi.wait(lambda: (value if (value := pi.snapshot())['runtime_id'] != old_runtime else None))
        require(refreshed['busy'] is True and
                pi.prepare(refreshed, uuid.uuid4().hex).get('ok') is False, 'reload_taint')
        require(not pi.rows('provider_call') and not pi.rows('tool_call'), 'async_replay')
        checks['async_taint'] = True
    # Deliberately incompatible contract: real Pi + Web without the image
    # preload. A plausible version and usable Web endpoint cannot pass prepare.
    entry_before = os.readlink(candidate / 'bin/pi')
    with RealPi(root / 'incompatible', candidate, web, guard=False) as pi:
        initial = pi.ready(version, node, eligible=False)
        require(initial['busy'] is True and
                pi.prepare(initial, uuid.uuid4().hex).get('ok') is False, 'negative_contract')
    require(os.readlink(candidate / 'bin/pi') == entry_before, 'negative_entrypoint')
    with RealPi(root / 'refresh', candidate, web, supervisor=True, bootstrap=True) as pi:
        pi.ready(version, node, eligible=False)
        pi.wait(lambda: pi.rows('agent_end'))
        before = pi.wait(lambda: (value if (value := pi.snapshot())['idle'] is True and
                                 value['pending'] is False and value['busy'] is False else None))
        require(len(pi.rows('provider_call')) == 1 and pi.rows('provider_call')[0].get('bootstrap') is True,
                'bootstrap')
        session_before = pi.session.read_bytes()
        operation = uuid.uuid4().hex
        reply = pi.control('restart', run_id=pi.run_id, operation_id=operation, **pi.expected(before))
        require(reply.get('ok') is True, 'restart_dispatch')
        def completed():
            result = pi.control('status')
            if result.get('ok') is not True:
                return None
            operation = result['result'].get('operation', {})
            if operation.get('status') == 'running':
                return None
            require(operation.get('status') == 'succeeded', 'restart_failed')
            return result['result']
        pi.wait(completed, timeout=40)
        after = pi.ready(version, node)
        require(after['runtime_id'] != before['runtime_id'], 'refresh_identity')
        for key in ('session_id', 'leaf_id', 'session_file', 'cwd', 'provider', 'model', 'thinking'):
            require(after[key] == before[key], 'refresh_preservation')
        starts = pi.rows('session_start')
        require(len(starts) == 2 and starts[0]['pid'] != starts[1]['pid'], 'refresh_child')
        pi.settle(.7)
        require(len(pi.rows('provider_call')) == 1 and not pi.rows('tool_call') and
                pi.session.read_bytes() == session_before, 'refresh_no_replay')
        checks['session_restore'] = True
        checks['no_replay'] = True
    require(set(checks) == set(CHECKS), 'checks')
    return checks


RESTORE_KEYS = ('session_id', 'leaf_id', 'cwd', 'provider', 'model', 'thinking')
SNAPSHOT_KEYS = set(RESTORE_KEYS) | {
    'run_id', 'runtime_id', 'session_file', 'version', 'idle', 'pending', 'busy'}


def private_tmp_directory(path):
    path = Path(path)
    require(path.is_absolute() and path != Path('/tmp') and path.is_relative_to('/tmp') and
            path.resolve(strict=True) == path, 'private_path')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'private_path')
    return path


def session_bytes(path):
    path = Path(path)
    require(path.is_absolute() and path.is_relative_to('/tmp') and path.resolve(strict=True) == path,
            'session_path')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and
                info.st_size <= 64 * 1024 * 1024, 'session_file')
        content = stream.read(64 * 1024 * 1024 + 1)
        require(len(content) <= 64 * 1024 * 1024 and
                stable_stat(os.fstat(stream.fileno())) == stable_stat(info) and
                stable_stat(path.lstat()) == stable_stat(info), 'session_changed')
    return content


def restore_snapshot(expected):
    require(isinstance(expected, dict) and set(RESTORE_KEYS) <= set(expected) <= SNAPSHOT_KEYS, 'restore_snapshot')
    for key in RESTORE_KEYS:
        value = expected[key]
        if key == 'leaf_id' and value is None:
            continue
        require(isinstance(value, str) and 0 < len(value) <= (8192 if key == 'cwd' else 256) and
                not any(ord(c) < 32 or ord(c) == 127 for c in value), 'restore_snapshot')
    require(os.path.isabs(expected['cwd']), 'restore_cwd')
    require(expected['thinking'] in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'), 'restore_thinking')
    return {key: expected[key] for key in RESTORE_KEYS}


def copy_runtime(source, destination):
    """Support an installer release prefix or measure_package(entry)['package'].

    A measured source package gets a disposable npm-style wrapper; its digest
    remains the measured package digest, not the wrapper's newly created files.
    """
    source = Path(source)
    require(source.is_absolute() and source.resolve(strict=True) == source and
            (source.is_relative_to(PREFIX) or source.is_relative_to('/tmp')), 'runtime_path')
    source_hash = tree_digest(source)
    if (source / 'lib/node_modules' / PACKAGE / 'package.json').is_file():
        copy_candidate(source, destination, source_hash)
        return source_hash
    require((source / 'package.json').stat().st_size <= 1024 * 1024, 'package_metadata')
    metadata = json.loads((source / 'package.json').read_text())
    require(metadata.get('name') == PACKAGE, 'package')
    package = destination / 'lib/node_modules' / PACKAGE
    package.parent.mkdir(parents=True)
    copy_candidate(source, package, source_hash)
    entry = metadata.get('bin')
    entry = entry.get('pi') if isinstance(entry, dict) else entry
    require(isinstance(entry, str) and entry and not os.path.isabs(entry) and
            (package / entry).resolve(strict=True).is_relative_to(package.resolve(strict=True)), 'package_entry')
    (destination / 'bin').mkdir()
    (destination / 'bin/pi').symlink_to(os.path.relpath(package / entry, destination / 'bin'))
    return source_hash


def run_restore(candidate_prefix, session_path, expected, workdir):
    """Restore a frozen private copy with real Pi, without calling any model.

    Gate checks profile/readonly mounts and binds this result to its capture.
    The disposable header's cwd is mapped to its private workspace; every other
    header field and every following byte are preserved. The frozen capture is
    never rewritten. Real cwd accessibility and final pre-stop identity/barrier
    rechecks belong to Gate/the live supervisor.
    """
    expected_fields = restore_snapshot(expected)
    workdir = private_tmp_directory(workdir)
    session_path = Path(session_path)
    content = session_bytes(session_path)
    header_raw = content.split(b'\n', 1)[0]
    require(len(header_raw) <= 65536, 'session_header')
    header = json.loads(header_raw)
    require(isinstance(header, dict) and header.get('type') == 'session' and
            header.get('id') == expected_fields['session_id'] and header.get('cwd') == expected_fields['cwd'],
            'session_header')
    require(type(header.get('version')) is int and 0 < header['version'] <= 2**53 - 1, 'restore_format')
    source_hash = copy_runtime(Path(candidate_prefix), workdir / 'candidate')
    candidate = workdir / 'candidate'
    # Bind the whole executed prefix before any candidate invocation. For a
    # measured-package input this also pins the generated bin/pi wrapper and
    # its entrypoint, in addition to the package bytes verified by copy_runtime.
    executed_hash = tree_digest(candidate)
    package, version = package_layout(candidate)
    metadata = json.loads((package / 'package.json').read_text())
    node = run_bounded([str(NODE), '--version'], workdir, clean_environment(workdir)).decode().strip().removeprefix('v')
    node_compatible({'node': metadata.get('engines', {}).get('node', '')}, node)
    reported = run_bounded([str(NODE), str(candidate / 'bin/pi'), '--version'], workdir, clean_environment(workdir))
    require(reported.decode().strip() == version, 'restore_version')
    web = stage_web(workdir / 'web', candidate)
    # The original project's cwd is deliberately absent from the offline helper.
    # Pi otherwise stops at its missing-cwd confirmation before extensions load.
    # Translate only this metadata in a second private copy, not the capture or
    # message body; report cwd_mode=surrogate rather than actual-cwd validation.
    _, history = content.split(b'\n', 1)
    surrogate = (json.dumps({**header, 'cwd': str(workdir / 'restore/workspace')},
                           separators=(',', ':')).encode() + b'\n' + history)
    surrogate_path = workdir / 'surrogate-session.jsonl'
    with surrogate_path.open('xb') as stream:
        stream.write(surrogate)
    surrogate_path.chmod(0o400)
    with RealPi(workdir / 'restore', candidate, web, session=surrogate_path, expected=expected_fields) as pi:
        # Session inspection must work even if a source package is ineligible
        # for refresh. Gate still requires independent source behavioral proof.
        actual = pi.ready(version, node, eligible=False)
        # A future header may open without migration or any byte changes. Its
        # format must still be supported by the selected SDK, not inferred from
        # successful startup, preserved history, or the Pi release number.
        starts = pi.rows('session_start')
        sdk_format = starts[0].get('session_format') if len(starts) == 1 else None
        require(type(sdk_format) is int and header['version'] <= sdk_format <= 2**53 - 1, 'restore_format')
        for key in ('session_id', 'leaf_id', 'provider', 'model', 'thinking'):
            require(actual[key] == expected_fields[key], 'restore_mismatch')
        require(actual['cwd'] == str(pi.cwd) and actual['idle'] is True and actual['pending'] is False,
                'restore_state')
        pi.settle(.8)
        after = pi.snapshot()
        for key in ('session_id', 'leaf_id', 'provider', 'model', 'thinking'):
            require(after[key] == expected_fields[key], 'restore_mismatch')
        require(not pi.rows('provider_call') and not pi.rows('tool_call'), 'restore_replay')
    require(not pi.rows('provider_call') and not pi.rows('tool_call'), 'restore_replay')
    # Inspect after child shutdown too: matching scalar IDs/settings do not
    # prove that opening the capture preserved its ancestors and message text.
    require(session_bytes(pi.session) == surrogate and session_bytes(surrogate_path) == surrogate,
            'restore_history_changed')
    require(tree_digest(candidate) == executed_hash, 'restore_runtime_changed')
    require(session_bytes(session_path) == content and tree_digest(Path(candidate_prefix)) == source_hash,
            'restore_input_changed')
    return {'ok': True, 'contract': 'pi-runtime-restore-v1', 'candidate_tree_sha256': source_hash,
            'session_sha256': hashlib.sha256(content).hexdigest(), 'expected_hash': digest(expected),
            'version': version, 'node': node, 'restored': expected_fields,
            'cwd_mode': 'surrogate', 'no_replay': True}


def source_identity(source):
    require(isinstance(source, dict) and set(source) == {
        'contract', 'package', 'executable', 'version', 'node', 'tree_sha256'}, 'source_identity')
    require(source['contract'] == 'pi-runtime-source-v1', 'source_identity')
    require(isinstance(source['version'], str) and re.fullmatch(VERSION, source['version']), 'source_version')
    require(isinstance(source['node'], str) and re.fullmatch('>=' + VERSION, source['node']), 'source_engine')
    require(isinstance(source['tree_sha256'], str) and re.fullmatch('[0-9a-f]{64}', source['tree_sha256']), 'source_hash')
    for key in ('package', 'executable'):
        value = source[key]
        require(isinstance(value, str) and len(value) <= 4096 and not any(ord(c) < 32 for c in value), 'source_path')
        path = Path(value)
        require(path.is_absolute() and path != PREFIX and path.is_relative_to(PREFIX) and
                '..' not in path.parts and str(path) == value, 'source_path')
    package, executable = Path(source['package']), Path(source['executable'])
    require(executable.is_relative_to(package) and executable != package, 'source_executable')
    require(package.resolve(strict=True) == package and executable.resolve(strict=True) == executable and
            executable.is_file(), 'source_path')
    return package, executable


def probe_source(identity, profile):
    """Independently exercise measured source bytes; make no integrity/origin claim."""
    package, executable = source_identity(identity)
    isolation()
    verify_profile(profile)  # Before candidate execution or extension imports.
    require(tree_digest(package) == identity['tree_sha256'], 'source_changed')
    require((package / 'package.json').stat().st_size <= 1024 * 1024, 'package_metadata')
    metadata = json.loads((package / 'package.json').read_text())
    require(metadata.get('name') == PACKAGE and metadata.get('version') == identity['version'] and
            metadata.get('engines', {}).get('node') == identity['node'], 'source_metadata')
    with tempfile.TemporaryDirectory(prefix='pi-probe-source-', dir='/tmp') as temporary:
        root = Path(temporary)
        candidate = root / 'candidate'
        copied_hash = copy_runtime(package, candidate)
        require(copied_hash == identity['tree_sha256'], 'source_changed')
        copied_package, version = package_layout(candidate)
        require((candidate / 'bin/pi').resolve(strict=True) ==
                copied_package / executable.relative_to(package), 'source_executable')
        node = run_bounded([str(NODE), '--version'], root, clean_environment(root)).decode().strip().removeprefix('v')
        node_compatible({'node': identity['node']}, node)
        checks = behavioral_checks(root, candidate, version, node)
        require(tree_digest(package) == identity['tree_sha256'] and
                tree_digest(copied_package) == identity['tree_sha256'], 'source_changed')
        require(set(checks) == set(CHECKS) and all(value is True for value in checks.values()), 'source_checks')
    return {'ok': True, 'source_hash': digest(identity), 'profile_hash': digest(profile),
            'node': node, 'checks': checks}


def verify_profile(profile):
    require(isinstance(profile, dict) and profile.get('contract') == 'pi-runtime-validation-v1', 'profile')
    require(isinstance(profile.get('image'), str) and re.fullmatch('sha256:[0-9a-f]{64}', profile['image']), 'profile')
    for key in ('helper_sha256', 'adapter_sha256', 'web_sha256', 'probe_sha256'):
        require(isinstance(profile.get(key), str) and re.fullmatch('[0-9a-f]{64}', profile[key]), 'profile')
    immutable_sources(RUNTIME)
    immutable_sources(WEB / 'extensions')
    immutable_sources(WEB / 'node_modules/ws')
    require(file_set_digest(RUNTIME, PROBE_FILES) == profile.get('probe_sha256'), 'probe_identity')
    require(source_digest(RUNTIME, {'.py', '.mjs'}) == profile.get('adapter_sha256'), 'adapter_identity')
    require(source_digest(WEB / 'extensions', {'.ts', '.mjs'}) == profile.get('web_sha256'), 'web_identity')


def interrupted(_signal, _frame):
    raise ProbeFailure('probe_interrupted')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(240)
    try:
        raw = sys.stdin.buffer.read(MAX_MESSAGE + 1)
        require(len(raw) <= MAX_MESSAGE, 'request_size')
        request = json.loads(raw)
        if sys.argv[1:] == ['--source']:
            require(isinstance(request, dict) and set(request) == {'source', 'profile'}, 'source_request')
            result = probe_source(request['source'], request['profile'])
            print(json.dumps(result, separators=(',', ':')), flush=True)
            return 0
        if sys.argv[1:] == ['--restore']:
            require(isinstance(request, dict) and set(request) == {
                'candidate_prefix', 'session_path', 'expected', 'workdir', 'profile'}, 'restore_request')
            isolation()
            verify_profile(request['profile'])
            result = run_restore(Path(request['candidate_prefix']), Path(request['session_path']),
                                 request['expected'], Path(request['workdir']))
            print(json.dumps(result, separators=(',', ':')), flush=True)
            return 0
        require(not sys.argv[1:], 'arguments')
        release, candidate, profile = request_identity(request)
        isolation()
        verify_profile(profile)
        source = PREFIX / '.pi-releases' / request['task']
        require(source.resolve(strict=True) == source, 'candidate_path')
        with tempfile.TemporaryDirectory(prefix='pi-probe-', dir='/tmp') as temporary:
            root = Path(temporary)
            copied = root / 'candidate'
            copy_candidate(source, copied, candidate['tree_sha256'])
            node = run_bounded([str(NODE), '--version'], root, clean_environment(root)).decode().strip()
            require(node.startswith('v'), 'node')
            node = node[1:]
            # Check engines before executing any candidate code.
            node_compatible(release, node)
            checks = behavioral_checks(root, copied, release['version'], node)
            require(tree_digest(source) == candidate['tree_sha256'] and
                    tree_digest(copied) == candidate['tree_sha256'], 'candidate_changed')
            result = {'ok': True, 'version': release['version'], 'changed': False,
                      'evidence': evidence(candidate, release, profile, node, checks)}
        print(json.dumps(result, separators=(',', ':')), flush=True)
        return 0
    except Exception:
        print('{"ok":false,"stage":"compatibility_probe_failed"}', flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())

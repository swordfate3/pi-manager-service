"""Private Gate↔Hub provider. Closing a helper never signals the Pi process."""
import hmac
import fcntl
import os
from pathlib import Path
import secrets
import select
import socket
import socketserver
import stat
import threading
import time

from . import terminal_contract as wire
from .lifecycle import Deadline


class Multiplex:
    def __init__(self):
        self.pending = bytearray()
        self.size = None

    def feed(self, data):
        self.pending.extend(data)
        output = bytearray()
        while True:
            if self.size is None:
                if len(self.pending) < 8:
                    break
                header = self.pending[:8]
                del self.pending[:8]
                self.size = int.from_bytes(header[4:], 'big')
                if header[:4] != b'\x01\0\0\0' or not 1 <= self.size <= wire.FRAME:
                    raise ValueError('terminal multiplex refused')
            if len(self.pending) < self.size:
                break
            output.extend(self.pending[:self.size])
            del self.pending[:self.size]
            self.size = None
        return output


class TerminalProvider:
    def __init__(self, gate, policy, token):
        self.gate, self.policy = gate, wire.policy(policy)
        if (not isinstance(token, str) or len(token) != 64 or
                any(c not in '0123456789abcdef' for c in token) or
                token in (gate.token, gate.lifecycle_token)):
            raise ValueError('independent terminal credential required')
        self.token = token
        self.lock = threading.Lock()
        self.peers, self.bindings, self.runs = set(), set(), {}
        self.closed = False

    @staticmethod
    def disconnect(connection):
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        connection.close()

    def close(self):
        with self.lock:
            self.closed = True
            peers = list(self.peers)
        for peer in peers:
            self.disconnect(peer)

    def handle(self, connection):
        helper, binding, run, scope, reserved = None, None, None, None, False
        with self.lock:
            if self.closed or not self.policy['enabled'] or len(self.peers) >= 8:
                self.disconnect(connection)
                return
            self.peers.add(connection)
        try:
            connection.settimeout(2)
            end, parser = time.monotonic() + 2, wire.Lines()
            opening = None
            while opening is None:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return
                connection.settimeout(remaining)
                data = connection.recv(32768)
                if not data:
                    return
                frames = parser.feed(data)
                if frames:
                    if len(frames) != 1 or parser.pending:
                        return
                    opening = frames[0]
            first = wire.first(opening)
            if not hmac.compare_digest(opening['token'], self.token):
                return  # No Docker operation before private authentication.
            opening.clear()
            run = first.get('runId') or first['target']['runId']
            if first['op'] == 'connect':
                binding, scope = first['binding']['connectionId'], first['scope']
                with self.lock:
                    slots = self.runs.get(run, [])
                    if binding in self.bindings or len(slots) >= 2 or (scope == 'write' and 'write' in slots):
                        return
                    self.bindings.add(binding)
                    self.runs.setdefault(run, []).append(scope)
                    reserved = True
            life = self.gate.lifecycle
            item = life._resolve(run, self.policy, deadline=Deadline(time, 4), role='terminal')
            fingerprint = life._target_hash(item)
            def inspect_again():
                if self.closed or self.gate.closing:
                    raise ValueError('terminal closed')
                if select.select([connection], [], [], 0)[0] and not connection.recv(1, socket.MSG_PEEK):
                    raise ValueError('terminal closed')
                life._resolve(run, self.policy, expected=item['Id'], expected_hash=fingerprint,
                              deadline=Deadline(time, 4), role='terminal')
            inspect_again()
            helper = life._engine().terminal_exec(item['Id'], inspect_again)
            self.relay(connection, helper, first, inspect_again)
        except Exception:
            # No exception strings, diagnostics, credentials or terminal content escape.
            pass
        finally:
            if helper is not None:
                self.disconnect(helper)
            self.disconnect(connection)
            with self.lock:
                self.peers.discard(connection)
                if reserved:
                    self.bindings.discard(binding)
                    self.runs[run].remove(scope)
                    if not self.runs[run]:
                        del self.runs[run]

    def relay(self, peer, helper, opening, inspect_again):
        peer.setblocking(False)
        inputs, outputs, mux = wire.Lines(), wire.Lines(), Multiplex()
        conversation = wire.Conversation(opening)
        queues = {helper: bytearray(wire.encode(opening)), peer: bytearray()}
        created = time.monotonic()
        next_inspect, first_deadline = created + .5, created + 2
        partial = {inputs: None, outputs: None, mux: None}
        blocked = {peer: None, helper: created}
        ending = False
        while not self.closed and not self.gate.closing:
            now = time.monotonic()
            if (now - created >= 300 or (conversation.ready is None and now >= first_deadline) or
                    any(start is not None and now - start >= 2 for start in (*partial.values(), *blocked.values()))):
                return
            if ending and not queues[peer]:
                return
            if now >= next_inspect:
                inspect_again()
                next_inspect = time.monotonic() + .5
            readable, writable, _ = select.select([] if ending else [peer, helper],
                                                   [sock for sock, queue in queues.items() if queue], [], .05)
            # Read first: a peer close cancels queued input before it can be written.
            for sock in readable:
                data = sock.recv(32768)
                if not data:
                    if sock is helper and not outputs.pending and not mux.pending and mux.size is None:
                        ending = True
                        continue
                    return
                if sock is peer:
                    values = inputs.feed(data)
                    for value in values:
                        conversation.request(value)
                        queues[helper].extend(wire.encode(value))
                    progress = [(inputs, bool(inputs.pending), bool(values))]
                else:
                    payload = mux.feed(data)
                    values = outputs.feed(payload)
                    for value in values:
                        keep = conversation.response(value)
                        queues[peer].extend(wire.encode(value))
                        if not keep or opening['op'] == 'status':
                            ending = True
                    # Mux payloads are nonempty: payload marks a completed packet,
                    # while values marks completed JSON lines, independently.
                    progress = [(mux, bool(mux.pending or mux.size is not None), bool(payload)),
                                (outputs, bool(outputs.pending), bool(values))]
                for parser, incomplete, completed in progress:
                    if not incomplete:
                        partial[parser] = None
                    elif completed or partial[parser] is None:
                        # Only a new unfinished frame gets a new deadline;
                        # receiving more bytes of the same frame never renews it.
                        partial[parser] = time.monotonic()
            for sock, queue in queues.items():
                if len(queue) > wire.QUEUE:
                    return
                if queue and blocked[sock] is None:
                    blocked[sock] = time.monotonic()
            for sock in writable:
                if sock is helper and ending:
                    continue
                try:
                    count = sock.send(queues[sock])
                except BlockingIOError:
                    continue
                if count <= 0:
                    return
                del queues[sock][:count]
                # Deadline covers the oldest queued batch, not inactivity alone.
                if not queues[sock]:
                    blocked[sock] = None


def private_parent(path):
    path = Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('unsafe terminal parent')
    info = path.stat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 1000 or
            stat.S_IMODE(info.st_mode) != 0o2770):
        raise ValueError('unsafe terminal parent')
    return path


def credential(parent):
    path = parent / 'provider.token'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            stream.write(secrets.token_hex(32))
            stream.flush()
            os.fsync(stream.fileno())
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or
                info.st_gid != 1000 or stat.S_IMODE(info.st_mode) != 0o640):
            raise ValueError('unsafe terminal credential')
        return stream.read(65)


class TerminalListener:
    """Production ownership: image-created setgid parents, no runtime chown/caps."""
    def __init__(self, gate, policy, ipc, credentials):
        from .service import LimitedThreads
        ipc, credentials = private_parent(ipc), private_parent(credentials)
        self.lease = None
        self.server = None
        self.thread = None
        self.address = ipc / 'provider.sock'
        self.provider = None
        try:
            fd = os.open(ipc / 'provider.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            self.lease = os.fdopen(fd, 'r+')
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                raise ValueError('unsafe terminal lock')
            fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.provider = TerminalProvider(gate, policy, credential(credentials))
            provider = self.provider
            class Handler(socketserver.BaseRequestHandler):
                def handle(self):
                    provider.handle(self.request)
            class Server(LimitedThreads, socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
                capacity = 8
                def handle_error(self, *_):
                    pass  # No terminal or credential diagnostics.
            if self.address.exists() or self.address.is_symlink():
                info = self.address.lstat()
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_gid != 1000:
                    raise ValueError('unsafe terminal socket')
                self.address.unlink()
            self.server = Server(str(self.address), Handler)
            os.chmod(self.address, 0o660)
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.provider is not None:
            self.provider.close()
        if self.server is not None:
            if self.thread is not None:
                self.server.shutdown()
                self.thread.join(2)
            self.server.server_close()
            self.address.unlink(missing_ok=True)
            self.server = None
        if self.lease is not None:
            self.lease.close()
            self.lease = None

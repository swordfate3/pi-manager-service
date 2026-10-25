"""Private, bounded pre-stop session capture; never restores the original file.

This only fences the input to a future offline restore check. A capture is NOT
compatibility evidence and cannot, by itself, authorize stopping a Pi process.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

MAX_SESSION = 64 * 1024 * 1024
LEASE_SECONDS = 150


def _identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _read(path, limit):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
                    before.st_nlink != 1 or before.st_size > limit):
                raise ValueError('session unavailable')
            content = stream.read(limit + 1)
            if (len(content) > limit or _identity(os.fstat(stream.fileno())) != _identity(before) or
                    _identity(path.lstat()) != _identity(before)):
                raise ValueError('session changed')
            return content, _identity(before)
    except OSError:
        raise ValueError('session unavailable') from None


class SessionCapture:
    def __init__(self, directory, snapshot, operation_id, *, clock=time.monotonic, limit=MAX_SESSION):
        if not isinstance(operation_id, str) or not re.fullmatch('[0-9a-f]{32}', operation_id):
            raise ValueError('invalid operation')
        if (type(limit) is not int or not 0 < limit <= MAX_SESSION or
                snapshot.get('idle') is not True or snapshot.get('pending') is not False or
                snapshot.get('busy') is not False):
            raise ValueError('session not idle')
        self.snapshot = copy.deepcopy(snapshot)
        self.clock, self.limit = clock, limit
        self.deadline = clock() + LEASE_SECONDS
        self.operation_id = operation_id
        self.source = Path(snapshot['session_file'])
        if not self.source.is_absolute() or '..' in self.source.parts:
            raise ValueError('invalid session path')
        content, self.source_identity = _read(self.source, limit)
        # Bound header parsing independently of the total history size. The real
        # target SDK decides format compatibility later, in disposable state.
        header_bytes = content.split(b'\n', 1)[0]
        if len(header_bytes) > 65536:
            raise ValueError('session header too large')
        try:
            header = json.loads(header_bytes)
        except (ValueError, UnicodeError):
            raise ValueError('session header unavailable') from None
        if (not isinstance(header, dict) or header.get('type') != 'session' or
                type(header.get('version')) is not int or header['version'] < 1 or
                header.get('id') != snapshot['session_id'] or header.get('cwd') != snapshot['cwd']):
            raise ValueError('session header mismatch')
        self.session_format = header['version']
        self.sha256 = hashlib.sha256(content).hexdigest()
        self.size = len(content)
        directory = Path(directory)
        parent = directory.lstat()
        if (directory.resolve(strict=True) != directory or not stat.S_ISDIR(parent.st_mode) or
                parent.st_uid != os.getuid() or parent.st_mode & 0o077):
            raise ValueError('unsafe capture parent')
        self.directory = directory / ('restore-' + operation_id)
        self.path = self.directory / 'session.jsonl'
        self.directory.mkdir(mode=0o700)  # Existing state is never silently reused.
        self.directory_identity = self.directory.lstat()
        self.closed = False
        try:
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
            with os.fdopen(descriptor, 'wb') as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            self.copy_identity = _identity(self.path.lstat())
            self.verify(snapshot)
        except BaseException:
            self.close()
            raise

    def descriptor(self):
        return {'contract': 'pi-runtime-restore-v1', 'operation_id': self.operation_id,
                'sha256': self.sha256, 'bytes': self.size, 'session_format': self.session_format,
                'snapshot': copy.deepcopy(self.snapshot)}

    def fence(self, snapshot):
        """Short final fence; full byte reads must precede the live snapshot."""
        if self.closed or self.clock() >= self.deadline or snapshot != self.snapshot:
            raise ValueError('capture expired or session changed')
        try:
            if (_identity(self.source.lstat()) != self.source_identity or
                    _identity(self.path.lstat()) != self.copy_identity):
                raise ValueError('captured files changed')
        except OSError:
            raise ValueError('capture unavailable') from None
        if self.clock() >= self.deadline:
            raise ValueError('capture expired')

    def verify(self, snapshot):
        self.fence(snapshot)
        content, identity = _read(self.source, self.limit)
        if identity != self.source_identity or hashlib.sha256(content).hexdigest() != self.sha256:
            raise ValueError('original session changed')
        copy_content, _ = _read(self.path, self.limit)
        if hashlib.sha256(copy_content).hexdigest() != self.sha256:
            raise ValueError('capture changed')
        # Reading/hashing up to two bounded histories can cross the deadline.
        # A successful entry check cannot authorize use after those reads.
        self.fence(snapshot)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            actual = self.directory.lstat()
            if (actual.st_dev, actual.st_ino) != (self.directory_identity.st_dev, self.directory_identity.st_ino):
                return
            self.path.unlink(missing_ok=True)
            self.directory.rmdir()
        except OSError:
            pass  # No recursive or broad cleanup, even on an unexpected entry.

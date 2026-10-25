"""Image-owned measurement of the actual package selected for a child launch.

Measurements are inputs to Gate's independent offline probe, NOT self-issued
compatibility grants. They do not isolate mutually writable, same-UID Agents.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

PACKAGE = '@earendil-works/pi-coding-agent'
VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 100000


def stable_stat(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def tree_digest(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('invalid package directory')
    resolved = root.resolve(strict=True)
    result = hashlib.sha256()
    count, total = 0, 0
    def walk(directory):
        nonlocal count, total
        before = directory.stat(follow_symlinks=False)
        for entry in sorted(directory.iterdir(), key=lambda value: value.name):
            count += 1
            info = entry.lstat()
            if count > MAX_ENTRIES:
                raise ValueError('package too large')
            row = [str(entry.relative_to(root)), stat.S_IMODE(info.st_mode)]
            if stat.S_ISLNK(info.st_mode):
                if not entry.resolve(strict=True).is_relative_to(resolved):
                    raise ValueError('package link escapes')
                row += ['link', os.readlink(entry)]
            elif stat.S_ISDIR(info.st_mode):
                row += ['directory']
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
                if total > MAX_BYTES:
                    raise ValueError('package too large')
                content = hashlib.sha256()
                descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as stream:
                    if stable_stat(os.fstat(stream.fileno())) != stable_stat(info):
                        raise ValueError('package changed')
                    while chunk := stream.read(65536):
                        content.update(chunk)
                    if stable_stat(os.fstat(stream.fileno())) != stable_stat(info):
                        raise ValueError('package changed')
                row += ['file', info.st_size, content.hexdigest()]
            else:
                raise ValueError('unsupported package entry')
            result.update(json.dumps(row, separators=(',', ':')).encode() + b'\n')
            if stat.S_ISDIR(info.st_mode):
                walk(entry)
            if stable_stat(entry.lstat()) != stable_stat(info):
                raise ValueError('package changed')
        if stable_stat(directory.stat(follow_symlinks=False)) != stable_stat(before):
            raise ValueError('package changed')
    walk(root)
    return result.hexdigest()


def measure_package(executable):
    executable = str(executable)
    if not os.path.isabs(executable):
        executable = shutil.which(executable)
        if executable is None:
            raise ValueError('package executable unavailable')
    selected = Path(executable)
    actual = selected.resolve(strict=True)
    if not actual.is_file():
        raise ValueError('package executable unavailable')
    for directory in list(actual.parents)[:8]:
        manifest = directory / 'package.json'
        if not manifest.is_file():
            continue
        if manifest.stat().st_size > 1024 * 1024:
            raise ValueError('package metadata unavailable')
        metadata = json.loads(manifest.read_text())
        if not isinstance(metadata, dict):
            raise ValueError('package metadata unavailable')
        if metadata.get('name') != PACKAGE:
            continue
        version, engines = metadata.get('version'), metadata.get('engines')
        if (not isinstance(version, str) or not re.fullmatch(VERSION, version) or
                not isinstance(engines, dict) or not isinstance(engines.get('node'), str) or
                not re.fullmatch('>=' + VERSION, engines['node'])):
            raise ValueError('package identity unavailable')
        content = tree_digest(directory)
        if selected.resolve(strict=True) != actual:
            raise ValueError('package entrypoint changed')
        return {'contract': 'pi-runtime-source-v1', 'package': str(directory),
                'executable': str(actual), 'version': version, 'node': engines['node'],
                'tree_sha256': content}
    raise ValueError('package identity unavailable')

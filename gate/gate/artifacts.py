import hashlib
import io
import re
import tarfile
import time
import urllib.request
from pathlib import PurePosixPath

from .store import check_sha

MAX_ARCHIVE = 32 * 1024 * 1024
MAX_BUNDLE = 4 * 1024 * 1024
TERMINAL_FILES = ('index.html', 'app.js', 'app.css')
MAX_TERMINAL_FILE = 2 * 1024 * 1024


def terminal_digest(assets):
    if (not isinstance(assets, dict) or set(assets) != set(TERMINAL_FILES) or
            any(not isinstance(data, bytes) or not 0 < len(data) <= MAX_TERMINAL_FILE
                for data in assets.values())):
        raise ValueError('terminal release requires the complete fixed browser inventory')
    digest = hashlib.sha256(b'pi-terminal-assets-v1\0')
    for name in TERMINAL_FILES:
        digest.update(name.encode() + b'\0')
        digest.update(len(assets[name]).to_bytes(8, 'big'))
        digest.update(assets[name])
    return digest.hexdigest()


def bundle_from_archive(data, commit):
    check_sha(commit)
    if len(data) > MAX_ARCHIVE:
        raise ValueError('archive too large')
    root = 'pi-web-ui-' + commit
    required = {'dist/hub/pi-web-hub.mjs': MAX_BUNDLE, 'LICENSE': 65536}
    wanted = dict(required, **{'dist/terminal/' + name: MAX_TERMINAL_FILE for name in TERMINAL_FILES})
    result = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r|gz') as archive:
        for index, member in enumerate(archive):
            pieces = PurePosixPath(member.name).parts
            if not pieces or pieces[0] != root or '..' in pieces or member.name.startswith('/'):
                raise ValueError('invalid archive path')
            total += member.size
            if index > 10000 or member.size < 0 or total > 256 * 1024 * 1024:
                raise ValueError('expanded archive too large')
            name = '/'.join(pieces[1:])
            if name not in wanted:
                continue
            if name in result or not member.isfile() or member.size <= 0 or member.size > wanted[name]:
                raise ValueError('unsafe or duplicate release artifact')
            result[name] = archive.extractfile(member).read(wanted[name] + 1)
    if not required.keys() <= result.keys():
        raise ValueError('release must contain prebuilt Hub and license')
    terminal = {name: result['dist/terminal/' + name] for name in TERMINAL_FILES
                if 'dist/terminal/' + name in result}
    pair = result['dist/hub/pi-web-hub.mjs'], result['LICENSE']
    if terminal:
        terminal_digest(terminal)  # Partial inventories fail, never silently disappear.
        return (*pair, terminal)
    return pair  # Keep historical releases and job snapshots deployable.


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('release redirects are not allowed')


def fetch_bundle(commit):
    check_sha(commit)
    url = 'https://codeload.github.com/swordfate3/pi-web-ui/tar.gz/' + commit
    # Do not inherit host proxy variables or credentials into this trusted path.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 90
    with opener.open(url, timeout=20) as response:
        output = bytearray()
        while True:
            block = response.read(65536)
            if not block:
                break
            output.extend(block)
            if len(output) > MAX_ARCHIVE or time.monotonic() > deadline:
                raise ValueError('release download exceeds limits')
    return bundle_from_archive(bytes(output), commit)


def build_context(bundle, license, base, commit, terminal=None):
    check_sha(commit)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', base):
        raise ValueError('base must be an exact local image ID')
    # Dockerfile FROM does not reliably accept a bare image ID with BuildKit.
    # Engine.ensure_base verifies this derived local alias before every build.
    alias = 'pi-web-hub:gate-base-' + base.removeprefix('sha256:')[:12]
    terminal_label = (f'LABEL pi.deploy-gate.terminal-sha256="{terminal_digest(terminal)}"\n'
                      if terminal is not None else '')
    dockerfile = (f'FROM {alias}\n'
                  f'LABEL org.opencontainers.image.revision="{commit}"\n'
                  f'LABEL pi.deploy-gate.bundle-sha256="{hashlib.sha256(bundle).hexdigest()}"\n'
                  f'LABEL pi.deploy-gate.base-image="{base}"\n'
                  'COPY pi-web-hub.mjs /opt/pi-web-ui/dist/hub/pi-web-hub.mjs\n'
                  'COPY LICENSE /opt/pi-web-ui/LICENSE\n' + terminal_label +
                  ('COPY terminal/ /opt/pi-web-ui/dist/terminal/\n' if terminal is not None else '')).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        files = [('Dockerfile', dockerfile), ('pi-web-hub.mjs', bundle), ('LICENSE', license)]
        if terminal is not None:
            files.extend(('terminal/' + name, terminal[name]) for name in TERMINAL_FILES)
        for name, data in files:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o444
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()

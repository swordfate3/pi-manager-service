"""Bounded public npm discovery. A published release is NOT a compatibility grant."""
import base64
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PACKAGE = '@earendil-works/pi-coding-agent'
REGISTRY = 'https://registry.npmjs.org/'
METADATA_URL = REGISTRY + urllib.parse.quote(PACKAGE, safe='@')
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
MAX_BYTES = 8 * 1024 * 1024
MAX_VERSIONS = 20000
PAGE_SIZE = 50
CACHE_SECONDS = 300
RETRY_SECONDS = 30


class RegistryUnavailable(RuntimeError):
    def __init__(self):
        super().__init__('official runtime registry unavailable or metadata invalid')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RegistryUnavailable()


def stable_version(value):
    return isinstance(value, str) and len(value) <= 64 and VERSION.fullmatch(value) is not None


def fetch_metadata(url, opener=None):
    """No browser URLs, redirect following, registry credential or unbounded body."""
    if url != METADATA_URL and not (url.startswith(METADATA_URL + '/') and
                                    stable_version(url.removeprefix(METADATA_URL + '/'))):
        raise RegistryUnavailable()
    opener = opener or urllib.request.build_opener(NoRedirect())
    accept = 'application/vnd.npm.install-v1+json' if url == METADATA_URL else 'application/json'
    request = urllib.request.Request(url, headers={'Accept': accept,
                                                   'Accept-Encoding': 'identity'})
    try:
        deadline = time.monotonic() + 8
        with opener.open(request, timeout=8) as response:
            if response.geturl() != url or response.status != 200:
                raise RegistryUnavailable()
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > MAX_BYTES):
                raise RegistryUnavailable()
            chunks, size = [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise RegistryUnavailable()
                chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise RegistryUnavailable()
                chunks.append(chunk)
            raw = b''.join(chunks)
            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        raise RegistryUnavailable()
                    result[key] = value
                return result
            return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=pairs,
                              parse_constant=lambda value: (_ for _ in ()).throw(RegistryUnavailable()))
    except (OSError, ValueError, UnicodeError, urllib.error.URLError) as error:
        raise RegistryUnavailable() from error


class RuntimeCatalog:
    def __init__(self, fetch=None, now=None):
        self.fetch = fetch or fetch_metadata
        self.now = now or time.time
        self.lock = threading.Lock()
        self.versions = None
        self.checked_at = None
        self.next_attempt = 0
        self.fresh_until = 0

    def _refresh(self):
        now = self.now()
        if now < self.next_attempt:
            return
        self.next_attempt = now + RETRY_SECONDS
        try:
            value = self.fetch(METADATA_URL)
            versions = value.get('versions') if isinstance(value, dict) else None
            if not isinstance(versions, dict) or len(versions) > MAX_VERSIONS:
                raise RegistryUnavailable()
            ordered = sorted((version for version in versions if stable_version(version)),
                             key=lambda version: tuple(map(int, version.split('.'))), reverse=True)
        except RegistryUnavailable:
            return
        self.versions = ordered
        self.checked_at = int(now * 1000)
        self.fresh_until = now + CACHE_SECONDS
        self.next_attempt = self.fresh_until

    def catalog(self, query='', cursor=None):
        if (not isinstance(query, str) or len(query) > 64 or not re.fullmatch(r'[0-9.]*', query) or
                (cursor is not None and (not isinstance(cursor, str) or len(cursor) > 256 or
                                        not re.fullmatch(r'[A-Za-z0-9_-]+', cursor)))):
            raise ValueError('invalid runtime catalog query')
        with self.lock:
            self._refresh()
            if self.versions is None:
                if cursor is not None:
                    raise ValueError('catalog cursor unavailable')
                return {'status': 'unavailable', 'versions': []}
            matching = [v for v in self.versions if v.startswith(query)]
            tag = hashlib.sha256(json.dumps([query, self.versions], separators=(',', ':')).encode()).hexdigest()[:32]
            offset = 0
            if cursor is not None:
                try:
                    value = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
                    if (not isinstance(value, list) or len(value) != 2 or value[0] != tag or
                            type(value[1]) is not int or value[1] <= 0 or value[1] >= len(matching) or
                            value[1] % PAGE_SIZE):
                        raise ValueError()
                    offset = value[1]
                except (ValueError, TypeError, UnicodeError) as error:
                    raise ValueError('invalid or expired runtime catalog cursor') from error
            result = {'status': 'fresh' if self.now() < self.fresh_until else 'stale',
                      'checked_at': self.checked_at,
                      'versions': [{'version': v} for v in matching[offset:offset + PAGE_SIZE]]}
            if offset + PAGE_SIZE < len(matching):
                raw = json.dumps([tag, offset + PAGE_SIZE], separators=(',', ':')).encode()
                result['next_cursor'] = base64.urlsafe_b64encode(raw).decode().rstrip('=')
            return result

    def resolve(self, version):
        if not stable_version(version):
            raise ValueError('exact stable runtime version required')
        value = self.fetch(METADATA_URL + '/' + version)
        try:
            if not isinstance(value, dict) or value.get('name') != PACKAGE or value.get('version') != version:
                raise RegistryUnavailable()
            dist = value['dist']
            integrity = dist['integrity']
            expected = REGISTRY + PACKAGE + '/-/pi-coding-agent-' + version + '.tgz'
            if dist['tarball'] != expected or not isinstance(integrity, str) or not integrity.startswith('sha512-'):
                raise RegistryUnavailable()
            digest = base64.b64decode(integrity[7:], validate=True)
            if len(digest) != 64 or base64.b64encode(digest).decode() != integrity[7:]:
                raise RegistryUnavailable()
            node = value['engines']['node']
            # Unsupported range expressions are unknown, never silently satisfied.
            if not isinstance(node, str) or not re.fullmatch(r'>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', node):
                raise RegistryUnavailable()
            return {'version': version, 'integrity': integrity, 'tarball': expected, 'node': node}
        except (KeyError, TypeError, ValueError) as error:
            raise RegistryUnavailable() from error

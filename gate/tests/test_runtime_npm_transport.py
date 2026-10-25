"""Real npm resolver/transport fixtures; no Docker or external registry access.

Run network cases explicitly with PI_RUNTIME_NPM_TRANSPORT=1. They require
loopback sockets, Node/npm, and openssl; permission denial is never bypassed.
The unchanged production guard sees registry.npmjs.org:443. A test-only TCP
adapter below it routes that destination and off-origin.invalid to local servers.
HTTP requests, TLS verification, tarball extraction, dependency resolution and
redirect handling remain real. Removing the guard must reach the forbidden sink.
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import threading
import unittest

from gate import runtime_install as installer


REGISTRY = 'https://registry.npmjs.org'
FORBIDDEN = 'https://off-origin.invalid/forbidden.tgz'
PARENT = 'pi-r2-parent'
LEAF = 'pi-r2-leaf'

# This adapter runs BEFORE the production preload. Its captured connect is
# called only AFTER the guard's wrappers. No request/response API is mocked.
# Unknown destinations throw, so a broken fixture cannot contact the Internet.
TCP_ADAPTER = r"""
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const connect = net.Socket.prototype.connect;
const config = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));
net.Socket.prototype.connect = function(...args) {
  const [options, callback] = net._normalizeArgs(args);
  const host = options.hostname || options.host;
  const key = host + ':' + options.port;
  fs.appendFileSync(config.trace, JSON.stringify({host,port:options.port}) + '\n');
  const port = config.routes[key];
  if (!port) throw new Error('unmapped fixture destination: ' + key);
  const local = {...options, host:'127.0.0.1', port};
  delete local.hostname;
  return Reflect.apply(connect, this, callback ? [local, callback] : [local]);
};
"""


def package_bytes(manifest, shrinkwrap=None):
    """Build registry-shaped bytes directly, without executing npm pack hooks."""
    files = {'package/package.json': json.dumps(manifest).encode(),
             'package/cli.js': b'throw new Error("fixture code must never execute");\n'}
    if shrinkwrap is not None:
        files['package/npm-shrinkwrap.json'] = json.dumps(shrinkwrap).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def integrity(data):
    return 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()


def root_manifest(optional=False):
    return {'name': installer.PACKAGE, 'version': '99.2.0', 'bin': {'pi': 'cli.js'},
            'scripts': {'preinstall': 'node cli.js', 'install': 'node cli.js',
                        'postinstall': 'node cli.js'},
            'optionalDependencies' if optional else 'dependencies': {PARENT: '1.0.0'}}


def lockfile(manifest, resolved, data, optional=False, dependency=PARENT):
    return {'name': manifest['name'], 'version': manifest['version'],
            'lockfileVersion': 3, 'requires': True,
            'packages': {'': manifest,
                         'node_modules/' + dependency: {'version': '1.0.0',
                             'resolved': resolved, 'integrity': integrity(data),
                             **({'optional': True} if optional else {})}}}


class _Server(ThreadingHTTPServer):
    daemon_threads = True


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.hits.append(self.path)
        status, headers, data = self.server.routes.get(
            self.path, (404, {}, b'unknown fixture URL'))
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class FixtureArtifacts(unittest.TestCase):
    """Offline checks cover fixture bytes and the real local-tarball npm launch."""

    def test_shrinkwrap_fixture_passes_real_artifact_preflight(self):
        leaf = package_bytes({'name': PARENT, 'version': '1.0.0'})
        manifest = root_manifest()
        data = package_bytes(manifest, lockfile(manifest, FORBIDDEN, leaf))
        release = {'version': '99.2.0', 'integrity': integrity(data), 'node': '>=22.0.0',
                   'tarball': REGISTRY + '/' + installer.PACKAGE + '/-/pi-coding-agent-99.2.0.tgz'}
        installer.pinned_release(release, '99.2.0')
        installer.check_archive(data, release)
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            value = json.load(archive.extractfile('package/npm-shrinkwrap.json'))
        self.assertEqual(value['packages']['node_modules/' + PARENT]['resolved'], FORBIDDEN)

    def test_real_npm_installs_local_bytes_without_running_package_scripts(self):
        node, npm = tools()
        with tempfile.TemporaryDirectory(prefix='pi-r2-offline-') as temporary:
            directory = Path(temporary)
            manifest = root_manifest()
            manifest.pop('dependencies')
            artifact = directory / 'official.tgz'
            artifact.write_bytes(package_bytes(manifest))
            guard = directory / 'guard.cjs'
            guard.write_text(installer.NPM_NETWORK_GUARD)
            result = subprocess.run(npm_command(node, npm, directory, artifact) + ['--offline'],
                cwd=directory, env=npm_environment(node, directory, [guard]),
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(Path(str(guard) + '.denied').exists())
            package = directory / 'prefix/lib/node_modules' / installer.PACKAGE / 'package.json'
            self.assertEqual(json.loads(package.read_text())['version'], '99.2.0')

    def test_fixture_javascript_parses(self):
        node, _ = tools()
        result = subprocess.run([node, '--check'], input=TCP_ADAPTER,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


def tools():
    node = os.environ.get('PI_RUNTIME_NPM_TRANSPORT_NODE', '/usr/local/bin/node')
    npm = os.environ.get('PI_RUNTIME_NPM_TRANSPORT_NPM', '/usr/local/bin/npm')
    if not Path(node).is_file() or not Path(npm).is_file():
        raise unittest.SkipTest('set PI_RUNTIME_NPM_TRANSPORT_NODE/NPM to real executable paths')
    # Calling npm-cli.js with the selected Node avoids ambient shebang/PATH drift.
    return str(Path(node).resolve()), str(Path(npm).resolve())


def npm_command(node, npm, directory, artifact):
    return [node, npm, '--prefix', str(directory / 'prefix'), 'install', '-g',
            '--ignore-scripts', '--min-release-age=0', '--no-audit', '--no-fund',
            '--fetch-retries=0', '--fetch-timeout=5000',
            '--registry=' + REGISTRY + '/', str(artifact)]


def npm_environment(node, directory, preloads):
    return {'HOME': str(directory),
            'PATH': str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin',
            'NPM_CONFIG_USERCONFIG': '/dev/null',
            'NPM_CONFIG_GLOBALCONFIG': str(directory / 'globalrc'),
            'NPM_CONFIG_CACHE': str(directory / 'cache'),
            'NPM_CONFIG_PREFIX': str(directory / 'prefix'),
            'NODE_OPTIONS': ' '.join('--require=' + str(path) for path in preloads)}


@unittest.skipUnless(os.environ.get('PI_RUNTIME_NPM_TRANSPORT') == '1',
                     'opt in with PI_RUNTIME_NPM_TRANSPORT=1; requires loopback sockets')
class RealNpmTransport(unittest.TestCase):
    def setUp(self):
        self.node, self.npm = tools()
        openssl = shutil.which('openssl')
        if openssl is None:
            self.skipTest('openssl is required for the disposable registry certificate')
        temporary = tempfile.TemporaryDirectory(prefix='pi-r2-transport-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.cert = self.directory / 'registry.pem'
        key = self.directory / 'registry.key'
        result = subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', str(key), '-out', str(self.cert), '-days', '1',
            '-subj', '/CN=registry.npmjs.org', '-addext',
            'subjectAltName=DNS:registry.npmjs.org,DNS:off-origin.invalid'],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.registry = self.server(key)
        self.forbidden_tls = self.server(key)
        self.forbidden_http = self.server()
        self.guard = self.directory / 'guard.cjs'
        self.guard.write_text(installer.NPM_NETWORK_GUARD)
        self.adapter = self.directory / 'tcp.cjs'
        self.adapter.write_text(TCP_ADAPTER)
        self.trace = self.directory / 'connections.jsonl'
        Path(str(self.adapter) + '.json').write_text(json.dumps({
            'trace': str(self.trace), 'routes': {
                'registry.npmjs.org:443': self.registry.server_port,
                'off-origin.invalid:443': self.forbidden_tls.server_port,
                'off-origin.invalid:80': self.forbidden_http.server_port}}))
        self.parent_manifest = {'name': PARENT, 'version': '1.0.0'}
        self.parent = package_bytes(self.parent_manifest)
        self.forbidden_tls.routes['/forbidden.tgz'] = (200, {}, self.parent)
        self.forbidden_http.routes['/forbidden.tgz'] = (200, {}, self.parent)

    def server(self, key=None):
        try:
            server = _Server(('127.0.0.1', 0), _Handler)
        except PermissionError as error:
            self.skipTest('loopback socket permission denied; no escalation: ' + str(error))
        self.addCleanup(server.server_close)
        server.hits = []
        server.routes = {}
        if key is not None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.shutdown)
        return server

    def packument(self, name, manifest, data, url):
        version = {**manifest, 'dist': {'tarball': url, 'integrity': integrity(data)}}
        body = json.dumps({'name': name, 'dist-tags': {'latest': '1.0.0'},
                           'versions': {'1.0.0': version}}).encode()
        self.registry.routes['/' + name] = (200, {'Content-Type': 'application/json'}, body)

    def run_npm(self, manifest=None, shrinkwrap=None, guarded=True):
        artifact = self.directory / 'official.tgz'
        artifact.write_bytes(package_bytes(manifest or root_manifest(), shrinkwrap))
        preloads = [self.adapter] + ([self.guard] if guarded else [])
        environment = npm_environment(self.node, self.directory, preloads)
        environment['NODE_EXTRA_CA_CERTS'] = str(self.cert)
        result = subprocess.run(npm_command(self.node, self.npm, self.directory, artifact),
            cwd=self.directory, env=environment, capture_output=True, text=True, timeout=30)
        connections = [json.loads(line) for line in self.trace.read_text().splitlines()] if self.trace.exists() else []
        self.diagnostic = json.dumps({'exit': result.returncode, 'registry': self.registry.hits,
            'forbidden_tls': self.forbidden_tls.hits, 'forbidden_http': self.forbidden_http.hits,
            'connections': connections, 'stderr': result.stderr[-6000:]}, indent=2)
        return result, connections

    def assert_refused(self, result, connections, optional=False):
        self.assertEqual(self.forbidden_tls.hits, [], self.diagnostic)
        self.assertEqual(self.forbidden_http.hits, [], self.diagnostic)
        self.assertTrue(all(item['host'] == 'registry.npmjs.org' for item in connections), self.diagnostic)
        self.assertTrue(Path(str(self.guard) + '.denied').is_file(), self.diagnostic)
        self.assertEqual(Path(str(self.guard) + '.denied').read_text(), 'refused')
        if optional:
            # npm can swallow optional dependency errors; the parent latch is
            # what prevents its exit 0 from authorizing preparation.
            self.assertEqual(result.returncode, 0, self.diagnostic)
        else:
            self.assertNotEqual(result.returncode, 0, self.diagnostic)

    def test_packaged_shrinkwrap_cannot_fetch_offorigin_tarball(self):
        manifest = {**self.parent_manifest, '_hasShrinkwrap': True, 'dependencies': {LEAF: '1.0.0'}}
        leaf = package_bytes({'name':LEAF, 'version':'1.0.0'})
        parent = package_bytes(manifest, lockfile(manifest, FORBIDDEN, leaf, dependency=LEAF))
        self.packument(PARENT, manifest, parent, REGISTRY + '/parent.tgz')
        self.registry.routes['/parent.tgz'] = (200, {}, parent)
        self.forbidden_tls.routes['/forbidden.tgz'] = (200, {}, leaf)
        self.packument(LEAF, {'name':LEAF,'version':'1.0.0'}, leaf, REGISTRY + '/leaf.tgz')
        self.registry.routes['/leaf.tgz'] = (200, {}, leaf)
        result, connections = self.run_npm()
        self.assertIn('/parent.tgz', self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections)

    def test_registry_metadata_cannot_select_offorigin_tarball(self):
        self.packument(PARENT, self.parent_manifest, self.parent, FORBIDDEN)
        result, connections = self.run_npm()
        self.assertIn('/' + PARENT, self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections)

    def test_transitive_dependency_cannot_fetch_offorigin_tarball(self):
        parent_manifest = {**self.parent_manifest, 'dependencies': {LEAF: '1.0.0'}}
        parent = package_bytes(parent_manifest)
        leaf_manifest = {'name': LEAF, 'version': '1.0.0'}
        leaf = package_bytes(leaf_manifest)
        self.packument(PARENT, parent_manifest, parent, REGISTRY + '/parent.tgz')
        self.registry.routes['/parent.tgz'] = (200, {}, parent)
        self.packument(LEAF, leaf_manifest, leaf, FORBIDDEN)
        result, connections = self.run_npm()
        self.assertIn('/' + LEAF, self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections)

    def test_registry_tarball_redirect_cannot_reach_offorigin(self):
        self.packument(PARENT, self.parent_manifest, self.parent, REGISTRY + '/redirect.tgz')
        self.registry.routes['/redirect.tgz'] = (302, {'Location': FORBIDDEN}, b'')
        result, connections = self.run_npm()
        self.assertIn('/redirect.tgz', self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections)

    def test_http_dependency_tarball_is_refused_before_connection(self):
        self.packument(PARENT, self.parent_manifest, self.parent,
                       'http://off-origin.invalid/forbidden.tgz')
        result, connections = self.run_npm()
        self.assertIn('/' + PARENT, self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections)

    def test_optional_dependency_refusal_latches_even_when_npm_succeeds(self):
        self.packument(PARENT, self.parent_manifest, self.parent, FORBIDDEN)
        result, connections = self.run_npm(root_manifest(optional=True))
        self.assertIn('/' + PARENT, self.registry.hits, self.diagnostic)
        self.assert_refused(result, connections, optional=True)

    def test_legitimate_registry_dependency_installs_without_latch(self):
        self.packument(PARENT, self.parent_manifest, self.parent, REGISTRY + '/parent.tgz')
        self.registry.routes['/parent.tgz'] = (200, {}, self.parent)
        result, _ = self.run_npm()
        self.assertEqual(result.returncode, 0, self.diagnostic)
        self.assertIn('/parent.tgz', self.registry.hits, self.diagnostic)
        self.assertEqual(self.forbidden_tls.hits, [], self.diagnostic)
        self.assertFalse(Path(str(self.guard) + '.denied').exists(), self.diagnostic)
        package = self.directory / 'prefix/lib/node_modules' / installer.PACKAGE
        dependency = package / 'node_modules' / PARENT / 'package.json'
        self.assertEqual(json.loads(dependency.read_text())['version'], '1.0.0')

    def test_guard_disabled_control_reaches_forbidden_sink(self):
        # This control proves zero forbidden hits is meaningful: the same real
        # resolver, TLS routing and fixture bytes reach the sink without guard.
        self.packument(PARENT, self.parent_manifest, self.parent, FORBIDDEN)
        result, connections = self.run_npm(guarded=False)
        self.assertEqual(result.returncode, 0, self.diagnostic)
        self.assertIn('/forbidden.tgz', self.forbidden_tls.hits, self.diagnostic)
        self.assertTrue(any(item['host'] == 'off-origin.invalid' for item in connections), self.diagnostic)


if __name__ == '__main__':
    unittest.main()

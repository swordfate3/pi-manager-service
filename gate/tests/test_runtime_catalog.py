"""Real catalog parsing, cursor and cache behavior; only network/time are inputs."""
import base64
import copy
import unittest
import io
import json

from gate.runtime_catalog import RuntimeCatalog, RegistryUnavailable, fetch_metadata, METADATA_URL, MAX_BYTES, NoRedirect


def release(version='1.4.0'):
    return {'name': '@earendil-works/pi-coding-agent', 'version': version,
            'engines': {'node': '>=22.19.0'},
            'dist': {'integrity': 'sha512-' + base64.b64encode(b'x' * 64).decode(),
                     'tarball': 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-' + version + '.tgz'}}


class RuntimeCatalogTest(unittest.TestCase):
    def setUp(self):
        self.clock = 1000.0
        self.calls = []
        self.metadata = {'versions': {v: {} for v in ('1.9.0', '1.10.0', '2.0.0-beta.1', '01.2.0')}}
        self.exact = release()
        self.failure = False

        def fetch(url):
            self.calls.append(url)
            if self.failure:
                raise RegistryUnavailable()
            return copy.deepcopy(self.exact if url.endswith('/1.4.0') else self.metadata)

        self.source = RuntimeCatalog(fetch=fetch, now=lambda: self.clock)

    def test_numeric_stable_catalog_without_version_allowlist(self):
        result = self.source.catalog()
        self.assertEqual([v['version'] for v in result['versions']], ['1.10.0', '1.9.0'])
        self.assertEqual(result['status'], 'fresh')
        self.assertEqual(result['checked_at'], 1000000)

    def test_paging_search_and_cursor_binding(self):
        self.metadata = {'versions': {f'1.0.{n}': {} for n in range(120)}}
        first = self.source.catalog('1.0.')
        second = self.source.catalog('1.0.', first['next_cursor'])
        third = self.source.catalog('1.0.', second['next_cursor'])
        self.assertEqual([len(r['versions']) for r in (first, second, third)], [50, 50, 20])
        self.assertNotIn('next_cursor', third)
        self.assertEqual(len({r['version'] for page in (first, second, third) for r in page['versions']}), 120)
        with self.assertRaises(ValueError):
            self.source.catalog('2.', first['next_cursor'])
        self.metadata['versions']['1.0.121'] = {}
        self.clock += 301
        with self.assertRaises(ValueError):
            self.source.catalog('1.0.', first['next_cursor'])

    def test_cache_and_failed_refresh_report_stale_without_fabricating_freshness(self):
        self.source.catalog()
        self.source.catalog()
        self.assertEqual(len(self.calls), 1)
        self.clock += 301
        self.failure = True
        stale = self.source.catalog()
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual(stale['checked_at'], 1000000)
        self.assertEqual(len(stale['versions']), 2)
        self.source.catalog()
        self.assertEqual(len(self.calls), 2, 'failed remote source must have retry backoff')

    def test_empty_network_failure_is_explicit_unavailable(self):
        self.failure = True
        self.assertEqual(self.source.catalog(), {'status': 'unavailable', 'versions': []})

    def test_query_and_cursor_are_bounded(self):
        for query in ('latest', '../x', '1.0?x=2', '1' * 65):
            with self.subTest(query=query), self.assertRaises(ValueError):
                self.source.catalog(query)
        for cursor in ('a' * 257, '../x', 'e30'):
            with self.subTest(cursor=cursor), self.assertRaises(ValueError):
                self.source.catalog('', cursor)

    def test_resolve_pins_exact_official_version_integrity_and_engine(self):
        result = self.source.resolve('1.4.0')
        self.assertEqual(result, {'version': '1.4.0', 'integrity': self.exact['dist']['integrity'],
                                  'tarball': self.exact['dist']['tarball'], 'node': '>=22.19.0'})
        self.assertIn('/1.4.0', self.calls[-1])
        self.assertNotIn('token', str(result))

    def test_invalid_exact_release_metadata_is_rejected(self):
        mutations = [lambda r: r.update(name='evil'), lambda r: r.update(version='1.3.0'),
                     lambda r: r['dist'].update(tarball='https://evil.invalid/pi.tgz'),
                     lambda r: r['dist'].update(tarball=r['dist']['tarball'] + '?secret=x'),
                     lambda r: r['dist'].update(integrity='sha1-' + 'x' * 20),
                     lambda r: r['dist'].update(integrity='sha512-' + 'x' * 88),
                     lambda r: r.update(engines={}), lambda r: r['engines'].update(node='*')]
        for mutate in mutations:
            self.exact = release()
            mutate(self.exact)
            with self.subTest(exact=self.exact), self.assertRaises(RegistryUnavailable):
                self.source.resolve('1.4.0')

    def test_tags_ranges_prereleases_and_urls_never_reach_registry(self):
        for version in ('latest', '^1.4.0', '1.4.0-beta.1', '1.4.0+build', 'v1.4.0', 'https://x/y', '01.4.0'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.source.resolve(version)
        self.assertEqual(self.calls, [])


class RegistryBoundaryTest(unittest.TestCase):
    def opener(self, url, raw=b'{}', headers=None, final=None):
        requests = []
        class Response(io.BytesIO):
            status = 200
            def geturl(self):
                return final or url
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                self.timeout = timeout
                response = Response(raw)
                response.headers = headers or {}
                return response
        return Opener(), requests

    def test_exact_release_uses_normal_json_accept_header(self):
        url = METADATA_URL + '/1.4.0'
        opener, requests = self.opener(url, json.dumps(release()).encode())
        self.assertEqual(fetch_metadata(url, opener)['version'], '1.4.0')
        self.assertEqual(requests[0].get_header('Accept'), 'application/json')
        self.assertIsNone(requests[0].get_header('Authorization'))
        self.assertLessEqual(opener.timeout, 8)

    def test_redirect_oversize_duplicate_json_and_unapproved_urls_fail_closed(self):
        cases = [(b'{}', {'Content-Length': str(MAX_BYTES + 1)}, None),
                 (b'{}', {}, 'https://evil.invalid/data'),
                 (b'{"versions":{},"versions":{}}', {}, None),
                 (b'NaN', {}, None)]
        for raw, headers, final in cases:
            opener, _ = self.opener(METADATA_URL, raw, headers, final)
            with self.subTest(raw=raw, headers=headers, final=final), self.assertRaises(RegistryUnavailable):
                fetch_metadata(METADATA_URL, opener)
        with self.assertRaises(RegistryUnavailable):
            NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid')
        with self.assertRaises(RegistryUnavailable):
            fetch_metadata('https://evil.invalid/private')


if __name__ == '__main__':
    unittest.main()

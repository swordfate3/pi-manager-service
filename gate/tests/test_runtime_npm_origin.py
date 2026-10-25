"""The trusted npm installer must not fetch off-origin dependency metadata."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from gate import runtime_install as installer


class NpmOrigin(unittest.TestCase):
    def run_guarded(self, source):
        with tempfile.TemporaryDirectory() as temporary:
            guard = Path(temporary) / 'origin.cjs'
            guard.write_text(getattr(installer, 'NPM_NETWORK_GUARD', ''))
            return subprocess.run([shutil.which('node'), '--require', str(guard), '-e', source],
                capture_output=True, text=True, timeout=10,
                env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': temporary})

    def test_offorigin_and_redirect_destinations_are_refused_before_opening_a_socket(self):
        for expression in (
            "require('https').request('https://off-origin.invalid/dependency.tgz')",
            "require('https').get(new URL('https://off-origin.invalid/redirect-target'))",
            "require('https').request('https://registry.npmjs.org/pkg', {hostname:'off-origin.invalid'})",
            "require('http').get('http://registry.npmjs.org/pkg')",
            "require('https').request('https://registry.npmjs.org:444/pkg')",
            "require('https').request('https://registry.npmjs.org/pkg', {socketPath:'/tmp/private.sock'})",
            "require('https').request('https://registry.npmjs.org/pkg', {headers:{host:'off-origin.invalid'}})",
            "require('net').connect(80, '127.0.0.1')",
            "require('tls').connect({host:'off-origin.invalid',port:443})",
            "require('child_process').spawn('/usr/bin/true')",
        ):
            with self.subTest(expression=expression):
                value = self.run_guarded("const a=require('assert/strict'); a.throws(()=>{" + expression +
                    "}, /npm origin policy/); console.log('refused');")
                self.assertEqual(value.returncode, 0, value.stderr)
                self.assertEqual(value.stdout.strip(), 'refused')

    def test_native_fetch_cannot_bypass_the_guarded_npm_transport(self):
        value = self.run_guarded("const a=require('assert/strict'); (async()=>{await a.rejects(" +
            "fetch('https://off-origin.invalid/pkg'), /npm origin policy/);console.log('refused')})()")
        self.assertEqual(value.returncode, 0, value.stderr)

    def test_fixed_registry_request_can_be_constructed_without_contacting_network(self):
        value = self.run_guarded("const https=require('https');const r=https.request(" +
            "'https://registry.npmjs.org/pkg');r.on('error',()=>{});r.destroy();console.log('allowed')")
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertEqual(value.stdout.strip(), 'allowed')

    def test_caught_optional_dependency_refusal_leaves_a_persistent_violation(self):
        value = self.run_guarded("try{require('https').request('https://off-origin.invalid/optional')}catch{};" +
            "require('assert/strict').equal(require('fs').existsSync(process.execArgv[1]+'.denied'),true)")
        self.assertEqual(value.returncode, 0, value.stderr)

    def test_pinned_npms_url_default_port_representation_is_not_offorigin(self):
        value = self.run_guarded("const https=require('https');const r=https.request({protocol:'https:'," +
            "host:'registry.npmjs.org',hostname:'registry.npmjs.org',port:'',path:'/pkg',auth:''});" +
            "r.on('error',()=>{});r.destroy();console.log('allowed')")
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertEqual(value.stdout.strip(), 'allowed')

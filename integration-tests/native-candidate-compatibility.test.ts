import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { NativeBackend } from '../manager/backends/native.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { digest, snapshotDialogue, webInventory } from '../manager/updates/compatibility-inputs.ts';
import { initializeHub } from '../hub/config.ts';
import { listen } from '../manager/http.ts';
import { packedWeb } from './fixtures/packed-web.ts';

test('actual native candidate preflight proves restore and fences BEFORE original synthetic consumer stops', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT || !process.env.PI_MANAGER_TEST_CANDIDATE_ROOT || !process.env.PI_MANAGER_TEST_RECEIPT_SHA256,
  timeout: 180_000,
}, async t => {
  const mod = await import('../manager/updates/native-compatibility.ts').catch(() => null);
  assert.ok(mod?.NativeCandidateCompatibility, 'native preflight verifier must exist');
  const candidates = process.env.PI_MANAGER_TEST_CANDIDATE_ROOT!;
  assert.equal(candidates, '/tmp/manager-candidate-official-SPwX0o/candidates');
  const candidateId = 'c-e302720684b002296b28295be46b483bf2ec8a1fa9e0d08850056e66e92abe2e';
  const receiptHash = process.env.PI_MANAGER_TEST_RECEIPT_SHA256!;
  assert.equal(receiptHash, 'f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3');
  const installer = await CandidateInstaller.open(JSON.parse(await readFile(path.join(candidates, 'policy.json'), 'utf8')));
  assert.equal((await installer.verify(candidateId, receiptHash)).release.version, '1.4.0');
  const root = await mkdtemp('/tmp/ncv-real-');
  const originalPeers = await realpath(path.resolve('node_modules'));
  const originalProfile = path.join(root, 'original'); await mkdir(originalProfile, { mode: 0o700 });
  const originalWeb = await packedWeb(originalProfile, process.env.PI_MANAGER_TEST_WEB_ROOT!, originalPeers);
  await symlink(originalPeers, path.join(originalProfile, 'node_modules'));
  const provider = path.join(originalProfile, 'provider.ts'); await copyFile(path.resolve('integration-tests/fixtures/native-update-provider.ts'), provider);
  const hubConfigFile = path.join(root, 'registrar/hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const reserve = await listen(async (_req, res) => { res.end(); }, 0), port = reserve.port; await reserve.close();
  const projects = path.join(root, 'projects'); await mkdir(path.join(projects, 'one'), { recursive: true, mode: 0o700 });
  const original = new NativeBackend({ piExecutable: path.join(originalPeers, '.bin/pi'), workspaceRoots: { projects },
    stateRoot: path.join(root, 'state'), agentRoot: path.join(root, 'agent'), runtimeControl: true,
    provider: { extensionPath: provider, name: 'native-update-fixture', model: 'fixed' },
    web: { extensionPath: path.join(originalWeb, 'extensions/mirror-server.ts'), hubConfigFile, port }, stopTimeoutMs: 2000 });
  t.after(async () => {
    for (const child of original.list()) assert.equal((await original.stop(child.instanceId)).status, 'stopped');
    // Evidence intentionally retained for controller inspection. No adopted PIDs.
    t.diagnostic(`private evidence retained: ${root}`);
  });
  const identity = await original.create({ instanceId: 'original', workspace: { root: 'projects', path: 'one' } });
  assert.equal((await original.generate('original', 'source 中文🙂\n  whitespace')).text, 'NATIVE_VERSION_OK 中文🙂');
  const snapshot = await original.snapshotRuntime('original'); assert.equal(snapshot.version, '1.1.0');
  const captures = path.join(root, 'captures'); await mkdir(captures, { mode: 0o700 });
  const operation = 'a'.repeat(32); await original.prepareRuntime('original', operation, snapshot);
  const capture = await original.captureRuntime('original', operation, captures);
  await original.cancelRuntime('original', operation);
  const descriptor = capture.descriptor(), saved = await readFile(path.join(captures, descriptor.reference));
  const rawOriginal = await readFile(snapshot.session_file!);
  const pack = path.join(root, 'pack'); await mkdir(pack, { mode: 0o700 });
  // Independent archive without peer/node_modules contamination; all writes are new test resources.
  const run = promisify(execFile);
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', pack], {
    cwd: process.env.PI_MANAGER_TEST_WEB_ROOT, env: { PATH: process.env.PATH, HOME: pack, NPM_CONFIG_CACHE: path.join(pack, 'cache'), NPM_CONFIG_USERCONFIG: path.join(pack, 'npmrc') },
  });
  const [{ filename }] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  await run('tar', ['-xzf', path.join(pack, filename), '-C', pack]);
  const webRoot = path.join(pack, 'package');
  async function privateProfile(dir: string) {
    await chmod(dir, 0o700);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await privateProfile(file); else { assert.ok(e.isFile()); await chmod(file, 0o600); }
    }
  }
  await privateProfile(webRoot);
  const web = { root: webRoot, sha256: (await webInventory(webRoot)).sha256 };
  const proofRoot = path.join(root, 'ledger/operations', '9'.repeat(64), 'native-preflight/proof');
  await mkdir(path.dirname(proofRoot), { recursive: true, mode: 0o700 });
  const options = { installer, root: proofRoot, web, captures: { root: captures }, trustedLocal: true as const };
  const verifier = await mod.NativeCandidateCompatibility.create(options);
  const request = { candidateId, receiptHash, session: { reference: descriptor.reference, sha256: descriptor.sha256, sessionId: descriptor.sessionId, leafId: descriptor.leafId! } };
  const proof = await verifier.verify(request);
  const child = JSON.parse(await readFile(path.join(options.root, proof.result.evidenceKey, 'restored-child.json'), 'utf8'));
  assert.ok(Buffer.byteLength(path.join(child.stateDir, 'run/control.sock')) <= 100);
  assert.equal(child.workspace.startsWith('/tmp/ncv-run-'), true);
  assert.equal(child.workspace.startsWith(proofRoot), false);
  const terminal = JSON.parse(await readFile(path.join(options.root, proof.result.evidenceKey, 'sdk-terminal.json'), 'utf8'));
  assert.equal(terminal.code, 0); assert.equal(terminal.signal, null);
  assert.throws(() => process.kill(terminal.pid, 0), { code: 'ESRCH' });
  assert.equal(proof.result.updates, false); assert.equal(proof.result.activation, 'not-attempted');
  assert.equal(proof.result.session.dialogueSha256, digest(JSON.stringify(snapshotDialogue(saved))));
  assert.equal(Object.isFrozen(proof.result.session), true);
  await verifier.revalidate(proof);
  await t.test('evidence records real Web prompt/mutation refusal under the private fence', async () => {
    const evidence = JSON.parse(await readFile(path.join(options.root, proof.result.evidenceKey, 'evidence.json'), 'utf8'));
    assert.equal(evidence.observations.webInputFenced, true);
    assert.equal(evidence.observations.webMutationFenced, true);
  });
  await t.test('raw SDK evidence mutation invalidates the opaque proof', async () => {
    const outputFile = path.join(options.root, proof.result.evidenceKey, 'sdk-output.json');
    const output = await readFile(outputFile); await chmod(outputFile, 0o600); await writeFile(outputFile, '{}');
    try { await assert.rejects(verifier.revalidate(proof), { code: 'evidence-changed' }); }
    finally { await writeFile(outputFile, output); await chmod(outputFile, 0o400); }
  });
  assert.equal((await original.inspect('original'))?.pid, identity.pid);
  assert.deepEqual(await readFile(snapshot.session_file!), rawOriginal);
  assert.deepEqual(await readFile(path.join(captures, descriptor.reference)), saved);
  await assert.rejects(verifier.revalidate(structuredClone(proof)), { code: 'proof-invalid' });
  const other = await mod.NativeCandidateCompatibility.create({ ...options, root: path.join(root, 'other') });
  await assert.rejects(other.revalidate(proof), { code: 'proof-invalid' });
  await assert.rejects(verifier.verify(request), { code: 'evidence-exists' });
  const captureFile = path.join(captures, descriptor.reference); await chmod(captureFile, 0o600); await writeFile(captureFile, saved.toString().replace('whitespace', 'CHANGED'));
  await assert.rejects(verifier.revalidate(proof), { code: 'session-changed' });
  await writeFile(captureFile, saved); await chmod(captureFile, 0o400);
  const evidenceFile = path.join(options.root, proof.result.evidenceKey, 'evidence.json');
  const evidence = await readFile(evidenceFile);
  await chmod(evidenceFile, 0o600); await writeFile(evidenceFile, '{}');
  await assert.rejects(verifier.revalidate(proof), { code: 'evidence-changed' });
  await writeFile(evidenceFile, evidence); await chmod(evidenceFile, 0o400);
  await verifier.revalidate(proof);
  await t.test('actual runtime history marked truncated refuses proof while original remains alive', async sub => {
    const refusal = await mod.NativeCandidateCompatibility.create({ ...options, root: path.join(root, 'truncated') });
    const emit = WebSocket.prototype.emit;
    let altered = false;
    const spy = sub.mock.method(WebSocket.prototype, 'emit', function (this: WebSocket, event: string | symbol, ...args: any[]) {
      if (event === 'message') {
        const frame = JSON.parse(args[0].toString());
        if (frame.type === 'res' && frame.id === 'history-0' && frame.result?.history) {
          frame.result.history.truncatedEntries = 1; args[0] = Buffer.from(JSON.stringify(frame)); altered = true;
        }
      }
      return emit.call(this, event, ...args);
    });
    try { await assert.rejects(refusal.verify(request), { code: 'behavior-incompatible' }); }
    finally { spy.mock.restore(); }
    assert.equal(altered, true);
    const entries = await readdir(path.join(root, 'truncated'));
    assert.equal(entries.includes('.writer'), false, 'known refusal releases only after owned children stop');
    const attempt = entries.find(n => n.startsWith('v-'))!;
    assert.equal((await readdir(path.join(root, 'truncated', attempt))).includes('evidence.json'), false);
    assert.equal((await original.inspect('original'))?.pid, identity.pid);
    assert.deepEqual(await readFile(snapshot.session_file!), rawOriginal);
  });
  assert.equal((await original.generate('original', 'still alive after preflight')).text, 'NATIVE_VERSION_OK 中文🙂');
  t.diagnostic(JSON.stringify({ proof: proof.result, host: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch }, originalAliveDuringProof: true }));
});

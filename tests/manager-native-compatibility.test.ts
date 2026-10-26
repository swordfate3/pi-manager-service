import assert from 'node:assert/strict';
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { hash, treeHash } from '../manager/updates/candidate-storage.ts';
import { webInventory } from '../manager/updates/compatibility-inputs.ts';
import { NativeBackend } from '../manager/backends/native.ts';
import { artifact, IMAGE, DAEMON } from '../integration-tests/candidate-install/fixtures.ts';

// Inert, real-FS rejection fixtures, never positive candidate acceptance.
async function fixture(t: any, engine = '>=20.0.0', ownedChild = false) {
  const mod = await import('../manager/updates/native-compatibility.ts').catch(() => null);
  assert.ok(mod?.NativeCandidateCompatibility, 'native preflight verifier must exist');
  const root = await mkdtemp('/tmp/ncv-unit-');
  t.after(async () => {
    async function writable(p: string) { await chmod(p, 0o700); for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await writable(path.join(p, e.name)); }
    await writable(root); await rm(root, { recursive: true, force: true });
  });
  const save = async (p: string, text: string, mode = 0o400) => { await mkdir(path.dirname(p), { recursive: true, mode: 0o700 }); await writeFile(p, text, { mode }); };
  const installer = await CandidateInstaller.create({ root: path.join(root, 'candidates'), preparedRoot: path.join(root, 'unused'), hostPreparedRoot: path.join(root, 'unused'),
    hostWorkerPath: '/unused/worker', hostGuardSource: '/unused/guard', socketPath: '/unused/socket', image: IMAGE, daemonId: DAEMON, network: 'none' });
  const candidateId = 'c-' + 'a'.repeat(64), directory = path.join(installer.config.root, candidateId), tree = path.join(directory, 'tree');
  const release = artifact({ engines: { node: engine } }).release;
  const cli = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const cliBytes = ownedChild ? await readFile(new URL('./fixtures/native-child.mjs', import.meta.url), 'utf8') : 'process.exit(23);';
  await save(path.join(tree, cli), cliBytes, 0o500);
  await save(path.join(tree, 'package-lock.json'), '{}');
  await save(path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/package.json'), JSON.stringify({ name: release.packageName, version: release.version, engines: { node: engine }, bin: { pi: 'dist/bundle/cli.js' }, exports: { '.': './dist/index.js' } }));
  await save(path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'), 'throw Error("inert SDK");');
  await save(path.join(tree, 'node_modules/@earendil-works/pi-ai/package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', exports: { '.': './dist/index.js', './compat': './dist/index.js' } }));
  await save(path.join(tree, 'node_modules/@earendil-works/pi-ai/dist/index.js'), 'throw Error("inert SDK");');
  await save(path.join(tree, 'node_modules/ws/package.json'), '{}');
  async function freeze(p: string) { for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await freeze(path.join(p, e.name)); await chmod(p, 0o500); }
  await freeze(tree);
  const receipt = { schema: 1, candidateId, image: IMAGE, release, status: 'installed-unverified', runnable: false, activation: 'not-attempted', node: 'v24.21.0',
    contentSha256: await treeHash(tree), lockSha256: hash('{}'), executables: [{ name: 'pi', relativePath: cli, sha256: hash(cliBytes) }] };
  await save(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
  await save(path.join(directory, 'intent.json'), JSON.stringify({ release, image: IMAGE, daemonId: DAEMON }));
  const web = path.join(root, 'web');
  await save(path.join(web, 'package.json'), JSON.stringify({ name: '@kkkiio/pi-web-ui', version: '1.0.0', peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.1.0' } }));
  await save(path.join(web, 'extensions/mirror-server.ts'), '// inert'); await save(path.join(web, 'dist/index.html'), 'inert');
  const outputs = [{ path: 'index.html', sha256: hash('inert') }];
  await save(path.join(web, 'dist/build-manifest.json'), JSON.stringify({ schemaVersion: 1, source: { count: 0, files: [], sha256: hash('[]') }, outputs: { count: 1, files: outputs, sha256: hash(JSON.stringify(outputs)) } }));
  const captures = path.join(root, 'captures'); await mkdir(captures, { mode: 0o700 });
  const bytes = [
    { type: 'session', version: 3, id: 'saved', cwd: '/original', timestamp: '2026-10-26' },
    { type: 'model_change', id: 'model', parentId: null, timestamp: '2026-10-26', provider: 'source-provider', modelId: 'source-model' },
    { type: 'message', id: 'leaf', parentId: 'model', timestamp: '2026-10-26', message: { role: 'user', content: '中文🙂\n  exact', timestamp: 1 } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  await save(path.join(captures, 'saved.jsonl'), bytes);
  const options = { installer, root: path.join(root, 'evidence'), web: { root: web, sha256: (await webInventory(web)).sha256 }, captures: { root: captures }, trustedLocal: true as const };
  const verifier = await mod.NativeCandidateCompatibility.create(options);
  const request = { candidateId, receiptHash: hash(JSON.stringify(receipt)), session: { reference: 'saved.jsonl', sha256: hash(bytes), sessionId: 'saved', leafId: 'leaf' } };
  return { mod, root, options, verifier, request, directory, tree, bytes, save };
}

test('closed requests reject path/argv injection and nonprimitive identities before admission', async t => {
  const f = await fixture(t);
  for (const patch of [{ argv: [] }, { candidateId: {} }, { receiptHash: 4 }, { session: { ...f.request.session, reference: '../saved.jsonl' } },
    { session: { ...f.request.session, sessionId: {} } }, { session: { ...f.request.session, leafId: null } }]) {
    await assert.rejects(f.verifier.verify({ ...f.request, ...patch } as any), { code: 'request-invalid' });
  }
  assert.deepEqual(await readdir(f.options.root), ['policy.json']);
  await assert.rejects(f.verifier.revalidate({ result: {} } as any), { code: 'proof-invalid' });
});

test('explicit trust and closed construction profiles are required', async t => {
  const f = await fixture(t);
  for (const patch of [{ trustedLocal: false }, { executable: process.execPath }, { web: { ...f.options.web, argv: [] } }])
    await assert.rejects(f.mod.NativeCandidateCompatibility.create({ ...f.options, ...patch } as any), { code: 'options-invalid' });
});

test('nested coordinator evidence roots are accepted without weakening private socket limits', async t => {
  const f = await fixture(t), root = path.join(f.root, 'operations', 'a'.repeat(64), 'compatibility', 'proof');
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  const verifier = await f.mod.NativeCandidateCompatibility.create({ ...f.options, root });
  await assert.rejects(verifier.verify({ ...f.request, receiptHash: '0'.repeat(64) }), { code: 'content-invalid' });
  assert.deepEqual(await readdir(root), ['policy.json']);
});

test('non-Linux host refuses explicitly before creating an evidence root', async t => {
  const f = await fixture(t), original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
  try { await assert.rejects(f.mod.NativeCandidateCompatibility.create({ ...f.options, root: path.join(f.root, 'unsupported') }), { code: 'host-unsupported' }); }
  finally { Object.defineProperty(process, 'platform', original); }
  assert.equal((await readdir(f.root)).includes('unsupported'), false);
});

test('receipt, Web, capture hashes and actual host engine refuse before executing inert candidate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.verifier.verify({ ...f.request, receiptHash: '0'.repeat(64) }), { code: 'content-invalid' });
  await assert.rejects(f.verifier.verify({ ...f.request, session: { ...f.request.session, sha256: '0'.repeat(64) } }), { code: 'session-changed' });
  await f.save(path.join(f.options.web.root, 'extra.txt'), 'changed');
  await assert.rejects(f.verifier.verify(f.request), { code: 'web-changed' });
  assert.equal((await readdir(f.options.root)).includes('.writer'), false);
  const newer = await fixture(t, '>=99.0.0');
  await assert.rejects(newer.verifier.verify(newer.request), { code: 'node-incompatible' });
});

test('unsupported capture or symlink is refused; request is copied before first await', async t => {
  const f = await fixture(t), file = path.join(f.options.captures.root, 'saved.jsonl');
  const incompatible = await fixture(t, '>=99.0.0');
  const request = structuredClone(incompatible.request), running = incompatible.verifier.verify(request);
  request.receiptHash = '0'.repeat(64); request.session.sha256 = '0'.repeat(64);
  await assert.rejects(running, { code: 'node-incompatible' });
  await chmod(file, 0o600); await writeFile(file, f.bytes.replace('"version":3', '"version":2'));
  await assert.rejects(f.verifier.verify(f.request), { code: 'session-invalid' });
  await symlink(file, path.join(f.options.captures.root, 'link.jsonl'));
  await assert.rejects(f.verifier.verify({ ...f.request, session: { ...f.request.session, reference: 'link.jsonl' } }), { code: 'input-unsafe' });
});

for (const fault of ['behavior', 'revocation', 'evidence persistence'] as const) test(`owned disposable child: ${fault} cannot publish proof or lose uncertain admission`, async t => {
  const f = await fixture(t, '>=20.0.0', true);
  const create = NativeBackend.prototype.create;
  let child: Awaited<ReturnType<NativeBackend['create']>> | undefined;
  t.mock.method(NativeBackend.prototype, 'create', async function (this: NativeBackend, request: any) {
    const attempt = (await readdir(f.options.root)).find(n => n.startsWith('v-'))!;
    const intent = JSON.parse(await readFile(path.join(f.options.root, attempt, 'intent.json'), 'utf8'));
    await writeFile(path.join(intent.run.root, 'workspace/scenario.json'), '"normal"');
    child = await create.call(this, request);
    if (fault === 'evidence persistence') await mkdir(path.join(f.options.root, attempt, 'seed-child.json'));
    if (fault === 'revocation') await mkdir(path.join(intent.run.root, 'registrar/state/.writer.lock'), { mode: 0o700 });
    return child;
  });
  const stop = t.mock.method(NativeBackend.prototype, 'stop');
  await assert.rejects(f.verifier.verify(f.request), { code: fault === 'behavior' ? 'behavior-incompatible' : 'native-outcome-unknown' });
  assert.ok(child); const pid = child.pid; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(stop.mock.calls.length, 1, 'exact stop never retried after uncertainty');
  const files = await readdir(f.options.root), attempt = files.find(n => n.startsWith('v-'))!;
  assert.equal((await readdir(path.join(f.options.root, attempt))).includes('evidence.json'), false);
  assert.equal(files.includes('.writer'), fault !== 'behavior');
  await assert.rejects(f.verifier.verify(f.request), { code: fault === 'behavior' ? 'evidence-exists' : 'reconciliation-required' });
  assert.equal(stop.mock.calls.length, 1);
});

test('verified receipt cannot hide wrong package version, CLI digest or selected candidate mutation', async t => {
  const f = await fixture(t);
  const pkgFile = path.join(f.tree, 'node_modules/@earendil-works/pi-coding-agent/package.json');
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8')); pkg.version = '0.0.0';
  await chmod(pkgFile, 0o600); await writeFile(pkgFile, JSON.stringify(pkg)); await chmod(pkgFile, 0o400);
  const receiptFile = path.join(f.directory, 'receipt.json'), receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  receipt.contentSha256 = await treeHash(f.tree);
  await chmod(receiptFile, 0o600); await writeFile(receiptFile, JSON.stringify(receipt));
  await assert.rejects(f.verifier.verify({ ...f.request, receiptHash: hash(JSON.stringify(receipt)) }), { code: 'candidate-unsupported' });
  await writeFile(receiptFile, '{}');
  await assert.rejects(f.verifier.verify(f.request), { code: 'content-invalid' });
  assert.equal((await readdir(f.options.root)).some(n => n.startsWith('v-')), false);
});

test('construction pins shipped provider code and rejects later source mutation without executing candidate', async t => {
  const f = await fixture(t), source = path.join(f.root, 'distribution');
  await mkdir(source, { mode: 0o700 });
  for (const name of ['manager', 'hub', 'protocol']) await cp(path.resolve(name), path.join(source, name), { recursive: true });
  await mkdir(path.join(source, 'runtime'), { mode: 0o700 });
  await copyFile(path.resolve('runtime/pi_rpc_guard.mjs'), path.join(source, 'runtime/pi_rpc_guard.mjs'));
  await symlink(await realpath(path.resolve('node_modules')), path.join(source, 'node_modules'));
  const { CandidateInstaller: Installer } = await import(pathToFileURL(path.join(source, 'manager/updates/candidate.ts')).href);
  const { NativeCandidateCompatibility: Verifier } = await import(pathToFileURL(path.join(source, 'manager/updates/native-compatibility.ts')).href);
  const verifier = await Verifier.create({ ...f.options, installer: await Installer.open(f.options.installer.config), root: path.join(f.root, 'pinned') });
  await writeFile(path.join(source, 'manager/updates/native-compatibility-provider.mjs'), '// changed shipped code');
  await assert.rejects(verifier.verify(f.request), { code: 'host-or-source-changed' });
  assert.deepEqual(await readdir(path.join(f.root, 'pinned')), ['policy.json']);
});

test('exclusive admission and bounded quota refuse without replay or pruning', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.options.root, '.writer'), 'unresolved', { mode: 0o600 });
  await assert.rejects(f.verifier.verify(f.request), { code: 'reconciliation-required' });
  assert.equal(await readFile(path.join(f.options.root, '.writer'), 'utf8'), 'unresolved');
  const full = await fixture(t);
  for (let i = 0; i < 8; i++) await mkdir(path.join(full.options.root, 'v-' + String(i).padStart(64, '0')), { mode: 0o700 });
  await assert.rejects(full.verifier.verify(full.request), { code: 'evidence-limit' });
  assert.equal((await readdir(full.options.root)).length, 9);
});

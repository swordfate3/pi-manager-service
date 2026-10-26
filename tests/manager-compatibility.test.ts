import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { hash, treeHash } from '../manager/updates/candidate-storage.ts';
import { inventory, parseProbe, webInventory } from '../manager/updates/compatibility-inputs.ts';
import { prepared, IMAGE as TEST_IMAGE, DAEMON as TEST_DAEMON } from '../integration-tests/candidate-install/fixtures.ts';

// These are protocol doubles with an inert installed tree, NEVER actual Pi acceptance.
async function fixture(t: any, pins = { image: TEST_IMAGE, daemon: TEST_DAEMON }) {
  const IMAGE = pins.image, DAEMON = pins.daemon;
  const mod = await import('../manager/updates/compatibility.ts').catch(() => null);
  assert.ok(mod?.CandidateCompatibility, 'private behavioral sidecar must exist');
  const root = await mkdtemp('/tmp/compat-double-');
  t.after(async () => {
    async function writable(p: string) { await chmod(p, 0o700); for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await writable(path.join(p, e.name)); }
    await writable(root); await rm(root, { recursive: true, force: true });
  });
  const save = async (p: string, b: string, mode = 0o400) => { await mkdir(path.dirname(p), { recursive: true, mode: 0o700 }); await writeFile(p, b, { mode }); };
  const f = await prepared(path.join(root, 'artifacts'));
  const socketPath = path.join(root, 'docker.sock');
  const installer = await CandidateInstaller.create({ root: path.join(root, 'candidates'), preparedRoot: path.join(root, 'artifacts'), hostPreparedRoot: path.join(root, 'artifacts'),
    hostWorkerPath: '/fixed/worker.py', hostGuardSource: '/fixed/guard.py', image: IMAGE, daemonId: DAEMON, socketPath, network: 'none' });
  const candidateId = 'c-' + 'a'.repeat(64), candidate = path.join(installer.config.root, candidateId), tree = path.join(candidate, 'tree');
  await save(path.join(tree, 'package-lock.json'), '{}');
  await save(path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '// inert protocol double');
  async function freeze(p: string) { for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await freeze(path.join(p, e.name)); await chmod(p, 0o500); }
  await freeze(tree);
  const receipt = { schema: 1, candidateId, image: IMAGE, release: f.release, status: 'installed-unverified', runnable: false, activation: 'not-attempted', node: 'v24.21.0',
    contentSha256: await treeHash(tree), lockSha256: hash('{}'), executables: [{ name: 'pi', relativePath: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', sha256: hash('// inert protocol double') }] };
  await save(path.join(candidate, 'receipt.json'), JSON.stringify(receipt));
  await save(path.join(candidate, 'intent.json'), JSON.stringify({ release: f.release, image: IMAGE, daemonId: DAEMON }));
  const web = path.join(root, 'web'), sources = path.join(root, 'sources');
  const pkg = JSON.stringify({ name: '@kkkiio/pi-web-ui', version: '1.0.1', peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.1.0' } });
  await save(path.join(web, 'package.json'), pkg); await save(path.join(web, 'extensions/mirror-server.ts'), '// fixture'); await save(path.join(web, 'dist/index.html'), 'fixture');
  const source = [{ path: 'extensions/mirror-server.ts', sha256: hash('// fixture') }, { path: 'package.json', sha256: hash(pkg) }];
  const outputs = [{ path: 'index.html', sha256: hash('fixture') }];
  await save(path.join(web, 'dist/build-manifest.json'), JSON.stringify({ schemaVersion: 1, source: { count: source.length, files: source, sha256: hash(JSON.stringify(source)) }, outputs: { count: 1, files: outputs, sha256: hash(JSON.stringify(outputs)) } }));
  for (const name of ['compatibility-probe.mjs', 'compatibility-provider.mjs', 'compatibility-inputs.ts', 'json.ts', 'pi_rpc_guard.mjs']) await save(path.join(sources, name), '// protocol fixture');
  const state = { daemon: DAEMON, image: IMAGE, lose: false, wrongOwner: false, inheritedLabels: false, failInspectOnce: false, calls: [] as any[], container: undefined as any };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    state.calls.push({ method: req.method, url: req.url, body });
    const send = (v: any, status = 200) => { res.writeHead(status); res.end(JSON.stringify(v)); };
    if (req.url === '/info') return send({ ID: state.daemon });
    if (req.url?.startsWith('/images/')) return send({ Id: state.image, Config: { Volumes: null } });
    if (req.url?.startsWith('/containers/create')) {
      state.container = { Id: 'b'.repeat(64), Image: IMAGE, Config: body, HostConfig: body.HostConfig, State: { Running: false, ExitCode: 0 },
        Mounts: body.HostConfig.Mounts.map((m: any) => ({ Type: 'bind', Source: m.Source, Destination: m.Target, RW: !m.ReadOnly })) };
      if (state.inheritedLabels) state.container.Config.Labels = { 'org.opencontainers.image.revision': 'pinned', ...Object.fromEntries(Object.entries(body.Labels).reverse()) };
      if (state.lose) return req.socket.destroy(); return send({ Id: state.container.Id });
    }
    if (req.method === 'DELETE') { state.container = undefined; res.writeHead(204); return res.end(); }
    if (req.url?.endsWith('/json')) {
      if (state.failInspectOnce) { state.failInspectOnce = false; return send({ message: 'first post-start inspection unavailable' }, 500); }
      if (state.wrongOwner) state.container.Config.Labels = {}; return send(state.container);
    }
    return send({}, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const options = { installer, root: path.join(root, 'evidence'), hostCandidateRoot: installer.config.root,
    web: { root: web, hostRoot: web, sha256: (await webInventory(web)).sha256 }, sources: { root: sources, hostRoot: sources, sha256: (await inventory(sources)).sha256 } };
  const verifier = await mod.CandidateCompatibility.create(options);
  return { ...f, root, mod, installer, verifier, options, state, candidate, request: { candidateId, receiptHash: hash(JSON.stringify(receipt)) } };
}

test('protocol double: unknown request fields and changed receipt/source fail before any Docker mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.verifier.verify({ ...f.request, argv: ['--help'] } as any), { code: 'request-invalid' });
  await assert.rejects(f.verifier.verify({ ...f.request, receiptHash: '0'.repeat(64) }), { code: 'content-invalid' });
  const source = path.join(f.options.sources.root, 'compatibility-probe.mjs'); await chmod(source, 0o600); await writeFile(source, 'mutated');
  await assert.rejects(f.verifier.verify(f.request), { code: 'source-changed' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
});

for (const mismatch of ['daemon', 'image'] as const) test(`protocol double: wrong ${mismatch} cannot create a container`, async t => {
  const f = await fixture(t); f.state[mismatch] = 'wrong';
  await assert.rejects(f.verifier.verify(f.request), { code: mismatch + '-mismatch' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
});

test('protocol double: lost create retains intent and lock, no replay/adoption/removal', async t => {
  const f = await fixture(t); f.state.lose = true;
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' });
  await assert.rejects(f.verifier.verify(f.request), { code: 'reconciliation-required' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 1);
  const dirs = await readdir(f.options.root); assert.ok(dirs.includes('.writer'));
  const intent = JSON.parse(await readFile(path.join(f.options.root, dirs.find(n => n.startsWith('v-'))!, 'intent.json'), 'utf8'));
  assert.equal(intent.binding.receiptHash, f.request.receiptHash);
  const spec = f.state.calls.find(c => c.method === 'POST').body;
  assert.equal(spec.User, '1000:1000'); assert.equal(spec.HostConfig.NetworkMode, 'none'); assert.equal(spec.NetworkDisabled, true);
  assert.equal(spec.HostConfig.ReadonlyRootfs, true); assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']); assert.deepEqual(spec.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal(spec.HostConfig.MemorySwap, spec.HostConfig.Memory); assert.ok(spec.HostConfig.Tmpfs['/work'].includes('size=268435456'));
  assert.ok(spec.HostConfig.Mounts.every((m: any) => m.ReadOnly && !m.Source.includes('docker.sock')));
});

test('protocol double: wrong ownership is never started or removed', async t => {
  const f = await fixture(t); f.state.wrongOwner = true;
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 1);
});

test('packed Web inventory independently covers shipped extras absent from the build-source subset', async t => {
  const f = await fixture(t), p = path.join(f.options.web.root, 'extensions/imessage-bridge.ts');
  await writeFile(p, '// shipped extra', { mode: 0o400 });
  const inv = await webInventory(f.options.web.root);
  assert.notEqual(inv.sha256, f.options.web.sha256);
  assert.ok(inv.files.some(x => x.path === 'extensions/imessage-bridge.ts' && x.sha256 === hash('// shipped extra')));
  await assert.rejects(f.verifier.verify(f.request), { code: 'web-changed' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
});

test('bounded attachment rejects oversized output and kills only its own local attach process', async t => {
  const f = await fixture(t);
  const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0; child.kill = () => { killed++; child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', null)); };
  t.mock.method(cp, 'spawn', () => { queueMicrotask(() => child.stdout.write(Buffer.alloc(65537))); return child; });
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' }); assert.equal(killed, 1);
  await retainedUnknown(f);
});

function output(binding: any) {
  return { schema: 1, status: 'compatible', binding, observations: [
    { event: 'selected-sdk', module: '/candidate/node_modules/sdk/index.js', version: binding.release.version, node: binding.node },
    { event: 'web-read', httpStatus: 200, readOk: true, bodySha256: '1'.repeat(64) },
    { event: 'generation-settled', disposition: 'started', aborted: false, text: 'COMPAT_RESPONSE' },
    { event: 'barrier-rejected', promptOk: false, mutationOk: false, wrongCancelOk: false },
    { event: 'exact-cancel', cancelled: true },
    { event: 'generation-resumed', disposition: 'started', aborted: false, text: 'COMPAT_RESPONSE' },
    { event: 'session-restored', copySha256: binding.session?.sha256 ?? '2'.repeat(64), messagesSha256: '3'.repeat(64),
      dialogueNormalization: 'ordered-user-assistant-text-v1', expectedDialogueSha256: binding.session?.dialogueSha256 ?? '4'.repeat(64),
      sdkDialogueSha256: binding.session?.dialogueSha256 ?? '4'.repeat(64), cliDialogueSha256: binding.session?.dialogueSha256 ?? '4'.repeat(64), webDialogueSha256: binding.session?.dialogueSha256 ?? '4'.repeat(64),
      beforeSession: binding.session?.sessionId ?? 'saved', sessionId: binding.session?.sessionId ?? 'saved', beforeLeaf: binding.session?.leafId ?? 'abc', leafId: binding.session?.leafId ?? 'abc' },
    { event: 'web-void-tainted', dispatchOk: true, prepareOk: false, settled: true },
  ] };
}
function attachment(t: any, f: any, change?: () => Promise<void>, malformed = false) {
  t.mock.method(cp, 'spawn', () => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(async () => {
      f.state.container.State = { Running: false, Status: 'exited', ExitCode: 0, StartedAt: '2026-10-26T00:00:00Z', FinishedAt: '2026-10-26T00:00:01Z' };
      if (change) await change();
      const binding = JSON.parse(Buffer.from(f.state.container.Config.Cmd[0], 'base64').toString());
      child.stdout.end(malformed ? '{}' : JSON.stringify(output(binding))); child.stderr.end(); child.emit('close', 0);
    }); return child;
  });
}
test('protocol double: image-inherited labels cannot mask exact ownership; verified evidence requires post-run verification and cleanup', async t => {
  const f = await fixture(t); f.state.inheritedLabels = true; attachment(t, f);
  const verify = t.mock.method(f.installer, 'verify');
  const result = await f.verifier.verify(f.request);
  assert.equal(result.status, 'compatible'); assert.equal(result.runnable, false); assert.equal(result.updates, false);
  assert.equal(result.webDispatchEligibility, 'permanently-tainted-after-void-send');
  assert.equal(verify.mock.calls.length, 2); assert.equal(f.state.container, undefined);
  assert.equal((await readdir(f.options.root)).includes('.writer'), false);
});
for (const mutation of ['receipt', 'tree', 'source', 'malformed']) test(`protocol double: ${mutation} during execution cannot publish success`, async t => {
  const f = await fixture(t);
  attachment(t, f, mutation === 'malformed' ? undefined : async () => {
    const p = mutation === 'receipt' ? path.join(f.candidate, 'receipt.json') : mutation === 'tree' ? path.join(f.candidate, 'tree/package-lock.json') : path.join(f.options.sources.root, 'compatibility-probe.mjs');
    await chmod(p, 0o600); await writeFile(p, 'changed');
  }, mutation === 'malformed');
  await assert.rejects(f.verifier.verify(f.request), { code: ['receipt', 'tree'].includes(mutation) ? 'content-invalid' : mutation === 'source' ? 'source-changed' : 'probe-invalid' });
  assert.equal(f.state.container, undefined);
  for (const e of await readdir(f.options.root)) if (e.startsWith('v-')) assert.equal((await readdir(path.join(f.options.root, e))).includes('evidence.json'), false);
});

test('timeout before start acknowledgement retains exact identity and lock without delete/replay', async t => {
  const f = await fixture(t);
  const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let killed = 0;
  child.kill = () => { killed++; child.emit('close', null); };
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  t.mock.method(cp, 'spawn', () => { t.mock.timers.enable({ apis: ['setTimeout'] }); queueMicrotask(started); return child; });
  const result = f.verifier.verify(f.request);
  await ready;
  t.mock.timers.tick(90000); await assert.rejects(result, { code: 'docker-outcome-unknown' }); assert.equal(killed, 1);
  t.mock.timers.reset(); await retainedUnknown(f);
});

async function retainedUnknown(f: any) {
  assert.equal(f.state.container?.Id, 'b'.repeat(64));
  const files = await readdir(f.options.root); assert.ok(files.includes('.writer'));
  const directory = path.join(f.options.root, files.find(n => n.startsWith('v-'))!);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'container.json'), 'utf8')), { id: 'b'.repeat(64) });
  assert.equal((await readdir(directory)).includes('evidence.json'), false);
  assert.equal(f.state.calls.some((c: any) => c.method === 'DELETE'), false);
  await assert.rejects(f.verifier.verify(f.request), { code: 'reconciliation-required' });
  assert.equal(f.state.calls.filter((c: any) => c.method === 'POST').length, 1);
}

for (const fault of ['output persistence', 'first inspection']) test(`${fault} failure after start retains unknown even when later ownership would succeed`, async t => {
  const f = await fixture(t);
  attachment(t, f, async () => {
    if (fault === 'first inspection') f.state.failInspectOnce = true;
    else {
      const attempt = (await readdir(f.options.root)).find(n => n.startsWith('v-'))!;
      await mkdir(path.join(f.options.root, attempt, 'output.json'));
    }
  });
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' });
  await retainedUnknown(f);
  assert.equal(f.state.failInspectOnce, false);
});

test('saved session hash/format/ref are checked before create and changed copy after run cannot publish evidence', async t => {
  const f = await fixture(t), root = path.join(f.root, 'sessions'); await mkdir(root, { mode: 0o700 });
  const verifier = await f.mod.CandidateCompatibility.create({ ...f.options, root: path.join(f.root, 'with-session'), sessions: { root, hostRoot: root } });
  const good = JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: '/old', timestamp: '2026-10-26' }) + '\n' +
    JSON.stringify({ type: 'message', id: 'leaf', parentId: null, timestamp: '2026-10-26', message: { role: 'user', content: 'dialogue', timestamp: 1 } }) + '\n';
  const file = path.join(root, 'copy.jsonl'); await writeFile(file, good, { mode: 0o600 });
  const request = { ...f.request, session: { reference: 'copy.jsonl', sha256: hash(good), sessionId: 'saved', leafId: 'leaf' } };
  await assert.rejects(verifier.verify({ ...request, session: { ...request.session, reference: '../copy.jsonl' } }), { code: 'request-invalid' });
  await assert.rejects(verifier.verify({ ...request, session: { ...request.session, sha256: '0'.repeat(64) } }), { code: 'session-changed' });
  await writeFile(file, '{}'); await assert.rejects(verifier.verify(request), { code: 'session-invalid' });
  assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 0);
  await writeFile(file, good);
  attachment(t, f, async () => { await writeFile(file, good.replace('dialogue', 'mutated')); });
  await assert.rejects(verifier.verify(request), { code: 'session-changed' });
  assert.equal(f.state.container, undefined);
});

test('administrator-fixed identities are portable; request cannot override daemon or image', async t => {
  const pins = { image: 'sha256:' + '9'.repeat(64), daemon: 'another-administrator-daemon' };
  const f = await fixture(t, pins); attachment(t, f);
  await assert.rejects(f.verifier.verify({ ...f.request, image: TEST_IMAGE } as any), { code: 'request-invalid' });
  const result = await f.verifier.verify(f.request);
  assert.equal(result.binding.image, pins.image); assert.equal(result.binding.daemon, pins.daemon);
  assert.equal(f.state.calls.find(c => c.method === 'POST').body.Image, pins.image);
});

test('lost start/attach outcome retains known identity and lock instead of deleting or replaying', async t => {
  const f = await fixture(t);
  t.mock.method(cp, 'spawn', () => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(); child.stderr.end('connection lost'); child.emit('close', 1); }); return child;
  });
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' });
  assert.ok(f.state.container); assert.ok((await readdir(f.options.root)).includes('.writer'));
  assert.equal(f.state.calls.some(c => c.method === 'DELETE'), false);
  await assert.rejects(f.verifier.verify(f.request), { code: 'reconciliation-required' });
});

test('completed attempt is never replayed or overwritten by an identical verification request', async t => {
  const f = await fixture(t); attachment(t, f); const result = await f.verifier.verify(f.request);
  const dir = path.join(f.options.root, result.evidenceKey), files = await readdir(dir);
  const content = await readFile(path.join(dir, 'evidence.json'));
  await assert.rejects(f.verifier.verify(f.request), { code: 'evidence-exists' });
  assert.deepEqual(await readdir(dir), files); assert.deepEqual(await readFile(path.join(dir, 'evidence.json')), content);
  assert.equal((await readdir(f.options.root)).includes('.writer'), false);
  assert.equal(f.state.calls.filter(c => c.method === 'POST').length, 1);
});

test('ownership and attach exit zero without a positive executed terminal state remain unknown', async t => {
  const f = await fixture(t);
  attachment(t, f, async () => { f.state.container.State = { Running: false, Status: 'created', ExitCode: 0, StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }; });
  await assert.rejects(f.verifier.verify(f.request), { code: 'docker-outcome-unknown' });
  await retainedUnknown(f);
});

test('output cannot omit independent restore hashes or substitute an agreeing but incorrect supplied-session baseline', () => {
  const binding = { release: { version: '1.4.0' }, node: 'v24.21.0', session: { sha256: '2'.repeat(64), sessionId: 'saved', leafId: 'abc', dialogueSha256: '4'.repeat(64) } };
  const valid = output(binding); assert.equal(parseProbe(Buffer.from(JSON.stringify(valid)), binding).status, 'compatible');
  for (const field of ['expectedDialogueSha256', 'sdkDialogueSha256', 'cliDialogueSha256', 'webDialogueSha256', 'dialogueNormalization']) {
    const bad: any = structuredClone(valid); delete bad.observations[6][field];
    assert.throws(() => parseProbe(Buffer.from(JSON.stringify(bad)), binding), /probe-invalid/);
  }
  const bad: any = structuredClone(valid);
  for (const field of ['expectedDialogueSha256', 'sdkDialogueSha256', 'cliDialogueSha256', 'webDialogueSha256']) bad.observations[6][field] = '9'.repeat(64);
  assert.throws(() => parseProbe(Buffer.from(JSON.stringify(bad)), binding), /probe-invalid/);
});

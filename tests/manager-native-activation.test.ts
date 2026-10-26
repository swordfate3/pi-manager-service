import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { initializeHub } from '../hub/config.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { hash, treeHash } from '../manager/updates/candidate-storage.ts';
import { webInventory } from '../manager/updates/compatibility-inputs.ts';
import { RuntimeClient } from '../manager/backends/runtime-client.ts';
import { ExecutionOutcomeUnknownError } from '../manager/errors.ts';
import { artifact } from '../integration-tests/candidate-install/fixtures.ts';
import type { TaskRecord } from '../manager/contracts.ts';

// These are real owned IPC children and an absent candidate store: rejection
// tests only. Positive compatibility/activation requires the opt-in real Pi test.
async function fixture(t: any, controlled = false) {
  const mod = await import('../manager/updates/native-activation.ts').catch(() => null);
  assert.ok(mod?.NativeInstallation, 'one installation owner must coordinate all native consumer generations');
  const root = await mkdtemp('/tmp/nai-');
  let installation: any;
  t.after(async () => {
    if (controlled) { t.diagnostic(`FS-only controlled evidence retained: ${root}`); return; }
    try { await installation?.close(); }
    catch (error) { throw Error(`Owned test cleanup uncertain; retained ${root}`, { cause: error }); }
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'projects', 'one'); await mkdir(workspace, { recursive: true });
  const cli = path.join(root, 'cli.mjs');
  await writeFile(cli, `#!${process.execPath}\n` + await readFile(new URL('./fixtures/native-runtime-child.mjs', import.meta.url), 'utf8'), { mode: 0o700 });
  await chmod(cli, 0o700);
  const webRoot = path.join(root, 'web'); await mkdir(path.join(webRoot, 'extensions'), { recursive: true });
  await mkdir(path.join(webRoot, 'dist'));
  await writeFile(path.join(webRoot, 'package.json'), JSON.stringify({ name: '@kkkiio/pi-web-ui', version: '1.0.0', peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.1.0' } }));
  await writeFile(path.join(webRoot, 'extensions/mirror-server.ts'), '// rejection fixture, never used as compatible Web');
  await writeFile(path.join(webRoot, 'dist/index.html'), 'inert');
  const outputs = [{ path: 'index.html', sha256: hash('inert') }];
  await writeFile(path.join(webRoot, 'dist/build-manifest.json'), JSON.stringify({ schemaVersion: 1, source: { count: 0, files: [], sha256: hash('[]') }, outputs: { count: 1, files: outputs, sha256: hash(JSON.stringify(outputs)) } }));
  async function privateProfile(dir: string) {
    await chmod(dir, 0o700);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await privateProfile(file); else await chmod(file, 0o600);
    }
  }
  await privateProfile(webRoot);
  const hub = path.join(root, 'hub'); await mkdir(hub, { mode: 0o700 });
  const hubConfigFile = path.join(hub, 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const installer = await CandidateInstaller.create({ root: path.join(root, 'candidates'), preparedRoot: path.join(root, 'unused'), hostPreparedRoot: path.join(root, 'unused'),
    hostWorkerPath: '/unused/worker', hostGuardSource: '/unused/guard', socketPath: '/unused/socket', daemonId: 'test', image: 'sha256:' + '1'.repeat(64), network: 'none' });
  const options = { root: path.join(root, 'installation'), installationId: 'shared', policyHash: 'a'.repeat(64), trustedLocal: true as const, installer,
    native: { piExecutable: cli, stateRoot: path.join(root, 'state'), agentRoot: path.join(root, 'agents'), workspaceRoots: { projects: path.dirname(workspace) },
      runtimeControl: true, stopTimeoutMs: controlled ? 1 : 1000,
      web: { extensionPath: path.join(webRoot, 'extensions/mirror-server.ts'), hubConfigFile, port: 19993 } },
    web: { root: webRoot, sha256: (await webInventory(webRoot)).sha256 } };
  installation = await mod.NativeInstallation.create(options);
  const request = { instanceId: 'one', workspace: { root: 'projects', path: 'one' } };
  async function task(): Promise<TaskRecord> {
    const review = await installation.review();
    return { id: '00000000-0000-4000-8000-000000000001', key: 'update-1', requester: 'agent', action: 'pi-update', target: 'shared',
      state: 'running', revision: 2, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      payload: { ...review, candidateId: 'c-' + 'c'.repeat(64), receiptHash: 'd'.repeat(64), releaseIdentity: 'e'.repeat(64), version: '1.4.0' } };
  }
  return { mod, root, installation, installer, options, workspace, request, task };
}

test('update receipt failure leaves every original consumer running with exact identity and saved bytes', async t => {
  const f = await fixture(t);
  const a = await f.installation.create(f.request);
  const b = await f.installation.create({ ...f.request, instanceId: 'two' });
  const before = await f.installation.snapshotRuntime('one');
  const bytes = await readFile(before.session_file!);
  await assert.rejects(f.installation.activate(await f.task()), /content-invalid/);
  assert.equal((await f.installation.inspect('one')).pid, a.pid);
  assert.equal((await f.installation.inspect('two')).pid, b.pid);
  assert.deepEqual(await readFile(before.session_file!), bytes);
  await f.installation.generate('one', 'still usable');
  await f.installation.generate('two', 'also usable');
  assert.equal((await f.installation.review()).expectedRevision, 0);
});

test('exact consumer inventory and approval state refuse stale/global-subset updates before stopping anyone', async t => {
  const f = await fixture(t);
  await f.installation.create(f.request);
  const task = await f.task();
  await f.installation.create({ ...f.request, instanceId: 'two' });
  await assert.rejects(f.installation.activate(task), /consumers|inventory/i);
  const next = await f.task();
  for (const changed of [{ ...next, state: 'queued' }, { ...next, target: 'other' },
    { ...next, payload: { ...(next.payload as object), expectedRevision: 1 } },
    { ...next, payload: { ...(next.payload as object), argv: ['forbidden'] } }]) {
    await assert.rejects(f.installation.activate(changed), /task|revision|request|payload/i);
  }
  assert.equal(f.installation.list().length, 2);
  await f.installation.generate('one', 'not stopped');
});

test('activation excludes create and stop synchronously; failed preflight releases only that known-safe reservation', async t => {
  const f = await fixture(t); await f.installation.create(f.request);
  const task = await f.task();
  const running = f.installation.activate(task); void running.catch(() => {});
  await assert.rejects(f.installation.create({ ...f.request, instanceId: 'two' }), /activation|installation.*busy/i);
  await assert.rejects(f.installation.stop('one'), /activation|installation.*busy/i);
  await assert.rejects(f.installation.activate(task), /activation|installation.*busy/i);
  await assert.rejects(running, /content-invalid/);
  await f.installation.create({ ...f.request, instanceId: 'two' });
  assert.equal(f.installation.list().length, 2);
  assert.equal((await f.installation.stop('two')).status, 'stopped');
});

test('in-flight creation and zero-consumer installations cannot pretend a complete activation set', async t => {
  const f = await fixture(t), empty = await f.task();
  await assert.rejects(f.installation.activate(empty), /consumers|inventory/i);
  const creating = f.installation.create(f.request); void creating.catch(() => {});
  await assert.rejects(f.installation.activate(empty), /busy|mutation/i);
  await creating;
  assert.equal(f.installation.list().length, 1);
  await assert.rejects(f.mod.NativeInstallation.create(f.options), /exist/i);
});

test('concurrent creation reserves capacity before startup yields', async t => {
  const f = await fixture(t);
  const creating = Array.from({ length: 8 }, (_, n) => f.installation.create({ ...f.request, instanceId: `owned-${n}` }));
  for (const pending of creating) void pending.catch(() => {});
  try { await assert.rejects(f.installation.create({ ...f.request, instanceId: 'ninth' }), /limit/i); }
  finally { await Promise.all(creating); }
  assert.equal(f.installation.list().length, 8);
});

test('idle observer waits for current settlement without blocking ordinary input or granting cutover authority', async t => {
  const { NativeInstallation } = await import('../manager/updates/native-activation.ts');
  assert.equal(typeof (NativeInstallation.prototype as any).waitForIdle, 'function', 'installation readiness must be observation-only');
  const f = await fixture(t); await f.installation.create(f.request);
  const task = { ...await f.task(), state: 'waiting_idle' };
  await writeFile(path.join(f.workspace, 'control.json'), JSON.stringify({ snapshot: { idle: false, busy: true } }));
  const controller = new AbortController(); let complete = false;
  const waiting = f.installation.waitForIdle(task, controller.signal).then(() => { complete = true; });
  void waiting.catch(() => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(complete, false);
    await f.installation.generate('one', 'readiness observation holds no input lease');
    await writeFile(path.join(f.workspace, 'control.json'), '{}');
    await waiting; assert.equal(complete, true);
    assert.equal((await f.installation.review()).expectedRevision, 0);
    await f.installation.generate('one', 'readiness is not approval');
  } finally { controller.abort(); await waiting.catch(() => {}); }
});

test('cancelled idle observer stops observing without stopping or fencing the owned process', async t => {
  const { NativeInstallation } = await import('../manager/updates/native-activation.ts');
  assert.equal(typeof (NativeInstallation.prototype as any).waitForIdle, 'function', 'cancelled observation needs a non-mutating path');
  const f = await fixture(t); const before = await f.installation.create(f.request);
  const task = { ...await f.task(), state: 'waiting_idle' };
  await writeFile(path.join(f.workspace, 'control.json'), JSON.stringify({ snapshot: { idle: false, busy: true } }));
  const controller = new AbortController(), reason = Error('observer cancelled');
  const waiting = f.installation.waitForIdle(task, controller.signal); void waiting.catch(() => {});
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal((await f.installation.inspect('one')).pid, before.pid);
  await f.installation.generate('one', 'still usable after observation');
});

// Controlled OS/IPC boundary only: no real child, socket, candidate or proof.
// NativeBackend ownership, registrar writes, captures, coordinator and journal
// remain real. Version-2 saved data deliberately prevents positive preflight.
function controlledRuntime(t: any, mode: 'ready' | 'unknown' | 'pending' = 'ready') {
  const children: any[] = [], clients = new Map<object, any>(), commands: string[] = [];
  const read = fsSync.readFileSync, write = fs.writeFile;
  const noIPC = () => { throw Error('FS-only harness forbids actual IPC'); };
  t.mock.method(net.Server.prototype, 'listen', noIPC);
  t.mock.method(net, 'createConnection', noIPC);
  t.mock.method(fsSync, 'readFileSync', (name: any, ...args: any[]) => {
    const child = children.find(c => String(name) === `/proc/${c.pid}/stat`);
    if (child) return `${child.pid} (controlled) S ${Array(18).fill('0').join(' ')} ${child.changed ? 2 : 1}`;
    return (read as any)(name, ...args);
  });
  t.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: any) => {
    // No verifier or candidate launch is permitted by this harness.
    assert.ok(_args.includes('--continue'), 'only administrator baseline launch is modeled');
    assert.match(_args[2], /^\/tmp\/nai-[A-Za-z0-9]+\/cli\.mjs$/, 'candidate and verifier launches are forbidden');
    const child: any = new EventEmitter();
    child.pid = 2147483000 + children.length; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.changed = false;
    child.snapshot = { run_id: options.env.PI_RUNTIME_RUN_ID, runtime_id: `controlled-${children.length}`, session_id: `saved-${children.length}`,
      leaf_id: 'leaf', session_file: path.join(options.env.PI_CODING_AGENT_SESSION_DIR, 'saved.jsonl'), cwd: options.cwd,
      version: '1.1.0', idle: true, busy: false, pending: false, provider: 'fixture', model: 'fixed', thinking: 'off' };
    fsSync.writeFileSync(child.snapshot.session_file, JSON.stringify({ type: 'session', version: 2, id: child.snapshot.session_id, cwd: options.cwd }) + '\n', { mode: 0o600 });
    child.stdin = new Writable({
      write(data, _encoding, done) {
        const request = JSON.parse(String(data));
        assert.equal(request.type, 'get_state', 'no synthetic generation acceptance');
        child.ready = () => child.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true,
          data: { isStreaming: false, isCompacting: false } }) + '\n');
        if (mode !== 'pending') child.ready(); done();
      },
      final(done) { if (mode !== 'unknown') { child.changed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); } done(); },
    });
    child.kill = () => { throw Error('controlled unknown must not signal any PID'); };
    children.push(child); return child;
  });
  t.mock.method(fs, 'writeFile', async (...args: any[]) => {
    const result = await (write as any)(...args);
    if (mode === 'unknown' && String(args[0]).endsWith('/identity.json')) {
      children.at(-1).changed = true;
      throw Object.assign(Error('audit persistence failed'), { code: 'EIO' });
    }
    return result;
  });
  t.mock.method(RuntimeClient.prototype, 'request', async function (this: RuntimeClient, request: any) {
    let child = clients.get(this);
    if (!child) { child = children.find(c => ![...clients.values()].includes(c)); assert.ok(child); clients.set(this, child); }
    commands.push(request.action);
    if (request.action === 'cancel') return { cancelled: true };
    assert.ok(['snapshot', 'prepare'].includes(request.action), 'no commit/admit or fabricated activation');
    return structuredClone(child.snapshot);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { children, commands };
}

async function inertCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const candidateId = 'c-' + 'c'.repeat(64), directory = path.join(f.installer.config.root, candidateId), tree = path.join(directory, 'tree');
  const release = artifact({ version: '1.4.0' }).release, cli = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const save = async (file: string, bytes: string, mode = 0o400) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode });
  };
  await save(path.join(tree, cli), 'throw Error("must not execute");', 0o500);
  await save(path.join(tree, 'package-lock.json'), '{}');
  await save(path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/package.json'), JSON.stringify({ name: release.packageName,
    version: release.version, engines: { node: release.nodeEngine }, bin: { pi: 'dist/bundle/cli.js' } }));
  for (const name of ['@earendil-works/pi-ai', 'ws']) await save(path.join(tree, 'node_modules', name, 'package.json'), '{}');
  async function freeze(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await freeze(path.join(dir, entry.name)); await chmod(dir, 0o500); }
  await freeze(tree);
  const receipt = { schema: 1, candidateId, image: f.installer.config.image, release, status: 'installed-unverified', runnable: false,
    activation: 'not-attempted', node: process.version, contentSha256: await treeHash(tree), lockSha256: hash('{}'),
    executables: [{ name: 'pi', relativePath: cli, sha256: hash('throw Error("must not execute");') }] };
  await save(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
  await save(path.join(directory, 'intent.json'), JSON.stringify({ release, image: f.installer.config.image, daemonId: f.installer.config.daemonId }));
  const task = await f.task();
  return { task: { ...task, payload: { ...(task.payload as object), candidateId, receiptHash: hash(JSON.stringify(receipt)), releaseIdentity: release.identity } }, tree };
}

test('FS-only owner retains backend-owned handle when initial create becomes unknown', async t => {
  const f = await fixture(t, true), os = controlledRuntime(t, 'unknown');
  await assert.rejects(f.installation.create(f.request), ExecutionOutcomeUnknownError);
  assert.equal(f.installation.list().length, 1);
  assert.equal(f.installation.list()[0].pid, os.children[0].pid);
  assert.equal((await f.installation.inspect('one')).status, 'ownership-lost');
  assert.equal((await f.installation.review()).consumers.length, 1);
  await assert.rejects(f.installation.stop('one'), ExecutionOutcomeUnknownError);
  await assert.rejects(f.installation.create({ ...f.request, instanceId: 'two' }), ExecutionOutcomeUnknownError);
  assert.equal(os.children.length, 1);
});

test('FS-only owner exposes pending owned handle before readiness returns', async t => {
  const f = await fixture(t, true), os = controlledRuntime(t, 'pending');
  const pending = f.installation.create(f.request); void pending.catch(() => {});
  try {
    for (let i = 0; !os.children[0]?.ready && i < 100; i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(os.children[0]?.ready);
    assert.equal(f.installation.list().length, 1);
    assert.equal((await f.installation.inspect('one')).status, 'starting');
  } finally { os.children[0]?.ready?.(); await pending; }
});

for (const fault of ['operation mkdir', 'task write', 'task sync', 'task close', 'operation sync'] as const)
  test(`FS-only persistence: ${fault} poisons owner before journal admission`, async t => {
    const f = await fixture(t, true), os = controlledRuntime(t); await f.installation.create(f.request);
    const task = await f.task(), dir = path.join(f.options.root, 'operations', task.id.replaceAll('-', ''));
    const open = fs.open, make = fs.mkdir; let hit = false;
    const fail = () => { hit = true; throw Object.assign(Error('injected persistence EIO'), { code: 'EIO' }); };
    t.mock.method(fs, 'mkdir', async (...args: any[]) => {
      const result = await (make as any)(...args); if (fault === 'operation mkdir' && String(args[0]) === dir) fail(); return result;
    });
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args), name = String(args[0]);
      const method = fault === 'task write' ? 'writeFile' : fault === 'task close' ? 'close' : 'sync';
      if ((name === path.join(dir, 'task.json') && fault.startsWith('task ')) || (name === dir && fault === 'operation sync')) {
        const call = handle[method].bind(handle) as (...values: any[]) => Promise<unknown>;
        t.mock.method(handle, method, async (...values: any[]) => { const result = await call(...values); if (!hit) fail(); return result; });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.installation.activate(task), ExecutionOutcomeUnknownError);
    assert.equal(hit, true); assert.equal(f.installation.list().length, 1);
    assert.equal(os.commands.includes('cancel'), false);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'outcome.json'), 'utf8')).status, 'unknown');
    await assert.rejects(f.installation.stop('one'), ExecutionOutcomeUnknownError);
    await assert.rejects(f.installation.activate({ ...task, id: '00000000-0000-4000-8000-000000000002' }), ExecutionOutcomeUnknownError);
    assert.equal(os.children.length, 1);
  });

for (const ids of [['web'], ['one', 'proof-one']]) test(`FS-only namespaces: ${ids.join('/')} remain valid without proof collisions`, async t => {
  const f = await fixture(t, true), os = controlledRuntime(t);
  for (const instanceId of ids) await f.installation.create({ ...f.request, instanceId });
  const { task } = await inertCandidate(f);
  await assert.rejects(f.installation.activate(task), /session-invalid/);
  const dir = path.join(f.options.root, 'operations', task.id.replaceAll('-', ''));
  assert.deepEqual(await readdir(path.join(dir, 'captures')), [...ids].sort());
  assert.ok((await readdir(path.join(dir, 'proofs'))).includes(ids[0]));
  assert.equal(f.installation.list().length, ids.length);
  assert.ok(os.commands.includes('cancel'), 'known incompatible data releases original lease');
  assert.equal((await f.installation.stop(ids[0])).status, 'stopped');
});

for (const fault of ['copied Web', 'peer link', 'candidate CLI'] as const) test(`FS-only selected inputs: ${fault} change refuses before a lease or launch`, async t => {
  const f = await fixture(t, true), os = controlledRuntime(t); await f.installation.create(f.request);
  const { task, tree } = await inertCandidate(f), link = fs.symlink;
  t.mock.method(fs, 'symlink', async (...args: Parameters<typeof fs.symlink>) => {
    if (String(args[1]).endsWith('/web/node_modules/@earendil-works/pi-ai')) {
      await link(fault === 'peer link' ? path.join(tree, 'node_modules/ws') : args[0], args[1], args[2]);
      if (fault !== 'peer link') {
        const file = fault === 'copied Web' ? path.join(path.dirname(String(args[1])), '../../dist/index.html') :
          path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
        await chmod(file, 0o600); await writeFile(file, 'changed selected bytes'); await chmod(file, fault === 'copied Web' ? 0o400 : 0o500);
      }
    } else await link(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.installation.activate(task), /selected-web-changed|content-invalid/);
  assert.equal(os.commands.includes('prepare'), false);
  assert.equal(os.children.length, 1);
});

test('FS-only capture fsync uncertainty retains the original lease and readable ownership', async t => {
  const f = await fixture(t, true), os = controlledRuntime(t); await f.installation.create(f.request);
  const { task } = await inertCandidate(f), open = fs.open; let hit = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (/restore-[a-f0-9]{32}\.jsonl$/.test(String(args[0]))) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); hit = true; throw Object.assign(Error('capture fsync EIO'), { code: 'EIO' }); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(f.installation.activate(task), ExecutionOutcomeUnknownError);
  assert.equal(hit, true); assert.ok(os.commands.includes('prepare')); assert.equal(os.commands.includes('cancel'), false);
  assert.equal(f.installation.list().length, 1); assert.equal((await f.installation.review()).consumers.length, 1);
  await assert.rejects(f.installation.generate('one', 'must stay fenced'), ExecutionOutcomeUnknownError);
  const dir = path.join(f.options.root, 'operations', task.id.replaceAll('-', ''));
  assert.equal(JSON.parse(await readFile(path.join(dir, 'outcome.json'), 'utf8')).status, 'unknown');
});

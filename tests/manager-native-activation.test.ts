import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { initializeHub } from '../hub/config.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { hash } from '../manager/updates/candidate-storage.ts';
import { webInventory } from '../manager/updates/compatibility-inputs.ts';
import type { TaskRecord } from '../manager/contracts.ts';

// These are real owned IPC children and an absent candidate store: rejection
// tests only. Positive compatibility/activation requires the opt-in real Pi test.
async function fixture(t: any) {
  const mod = await import('../manager/updates/native-activation.ts').catch(() => null);
  assert.ok(mod?.NativeInstallation, 'one installation owner must coordinate all native consumer generations');
  const root = await mkdtemp('/tmp/nai-');
  let installation: any;
  t.after(async () => {
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
      runtimeControl: true, web: { extensionPath: path.join(webRoot, 'extensions/mirror-server.ts'), hubConfigFile, port: 19993 } },
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

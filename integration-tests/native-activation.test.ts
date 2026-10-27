import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initializeHub } from '../hub/config.ts';
import { NativeInstallation } from '../manager/updates/native-activation.ts';
import { NativeBackend, type NativeIdentity } from '../manager/backends/native.ts';
import { ExecutionOutcomeUnknownError } from '../manager/errors.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { webInventory } from '../manager/updates/compatibility-inputs.ts';
import type { TaskRecord } from '../manager/contracts.ts';
import { listen } from '../manager/http.ts';
import { packedWeb } from './fixtures/packed-web.ts';

// Executor-private coordinator acceptance. The gateway/approval adapters are a
// later integration, so public updates stays false even if this test passes.
// R1 fault modes require separately authorized genuine candidate proofs, not
// a substitute positive verifier or FS fixture. Results belong in validation.
const preparedFault = process.env.PI_MANAGER_TEST_PREPARED_JOURNAL_FAULT;
test(preparedFault ? `native installation retains original leases after prepared journal ${preparedFault} uncertainty`
  : 'native installation coordinates every official-candidate consumer and publishes before admission', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT || !process.env.PI_MANAGER_TEST_CANDIDATE_ROOT || !process.env.PI_MANAGER_TEST_RECEIPT_SHA256,
  timeout: 300_000,
}, async t => {
  assert.ok(preparedFault === undefined || ['write', 'file-sync', 'directory-sync'].includes(preparedFault));
  const candidateRoot = process.env.PI_MANAGER_TEST_CANDIDATE_ROOT!;
  assert.equal(candidateRoot, '/tmp/manager-candidate-official-SPwX0o/candidates');
  const candidateId = 'c-e302720684b002296b28295be46b483bf2ec8a1fa9e0d08850056e66e92abe2e';
  const receiptHash = process.env.PI_MANAGER_TEST_RECEIPT_SHA256!;
  assert.equal(receiptHash, 'f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3');
  const installer = await CandidateInstaller.open(JSON.parse(await readFile(path.join(candidateRoot, 'policy.json'), 'utf8')));
  const receipt = await installer.verify(candidateId, receiptHash);
  assert.equal(receipt.release.version, '1.4.0');
  const root = await mkdtemp('/tmp/nai-live-');
  const baseline = path.join(root, 'baseline'); await mkdir(baseline, { mode: 0o700 });
  const peers = await realpath(path.resolve('node_modules'));
  const initialWeb = await packedWeb(baseline, process.env.PI_MANAGER_TEST_WEB_ROOT!, peers);
  const pack = path.join(root, 'pack'); await mkdir(pack, { mode: 0o700 });
  const run = promisify(execFile);
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', pack], {
    cwd: process.env.PI_MANAGER_TEST_WEB_ROOT!, timeout: 15000,
    env: { PATH: process.env.PATH, HOME: pack, NPM_CONFIG_CACHE: path.join(pack, 'cache'), NPM_CONFIG_USERCONFIG: path.join(pack, 'npmrc') },
  });
  const [{ filename }] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  await run('tar', ['-xzf', path.join(pack, filename), '-C', pack]);
  const webRoot = path.join(pack, 'package');
  async function privateProfile(dir: string) {
    await chmod(dir, 0o700);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); if (e.isDirectory()) await privateProfile(p); else { assert.ok(e.isFile()); await chmod(p, 0o600); }
    }
  }
  await privateProfile(webRoot);
  const provider = path.join(root, 'provider.mjs'); await copyFile(path.resolve('integration-tests/fixtures/native-selected-provider.mjs'), provider);
  const projects = path.join(root, 'projects');
  // Regression inventory: all these IDs were always valid; captures/proofs must
  // not collide with staged Web or with each other.
  const consumerIds = ['web', 'one', 'proof-one'];
  for (const name of consumerIds) await mkdir(path.join(projects, name), { recursive: true, mode: 0o700 });
  const hubDir = path.join(root, 'hub'); await mkdir(hubDir, { mode: 0o700 });
  const hubConfigFile = path.join(hubDir, 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const reserve = await listen(async (_req, res) => { res.end(); }, 0), port = reserve.port; await reserve.close();
  const installation = await NativeInstallation.create({ root: path.join(root, 'installation'), installationId: 'shared', policyHash: 'a'.repeat(64),
    installer, trustedLocal: true, web: { root: webRoot, sha256: (await webInventory(webRoot)).sha256 },
    native: { piExecutable: path.join(peers, '.bin/pi'), stateRoot: path.join(root, 'state'), agentRoot: path.join(root, 'agent'),
      workspaceRoots: { projects }, runtimeControl: true,
      provider: { extensionPath: provider, name: 'native-selected-fixture', model: 'fixed' },
      web: { extensionPath: path.join(initialWeb, 'extensions/mirror-server.ts'), hubConfigFile, port },
      startupTimeoutMs: 15000, stopTimeoutMs: 2000, generationTimeoutMs: 20000 } });
  let faultAttempted = false, faultAssertionsComplete = false;
  const originalOwners: { backend: NativeBackend; identity: NativeIdentity }[] = [];
  if (preparedFault) {
    const create = NativeBackend.prototype.create;
    t.mock.method(NativeBackend.prototype, 'create', async function (this: NativeBackend, ...args: Parameters<typeof create>) {
      const identity = await create.apply(this, args);
      if (identity.stateDir.startsWith(path.join(root, 'state') + path.sep)) originalOwners.push({ backend: this, identity });
      return identity;
    });
  }
  t.after(async () => {
    // No broad cleanup, no adoption or retry after unknown. Preserve exact
    // operation/capture/audit/proof evidence even on a successful acceptance.
    if (faultAttempted) {
      t.diagnostic(`prepared journal fault evidence retained: ${root}`);
      // Never ask the poisoned coordinator to reconcile or cancel. Only after
      // all assertions, terminate the exact known disposable fixture handles
      // once. If assertions/stop fail, retain resources; no adoption or retry.
      if (faultAssertionsComplete) for (const owned of originalOwners) {
        assert.equal((await owned.backend.stop(owned.identity.instanceId)).status, 'stopped');
      }
      return;
    }
    try { await installation.close(); }
    catch (error) { throw Error(`Activation cleanup uncertain; retained ${root}`, { cause: error }); }
    t.diagnostic(`private activation evidence retained: ${root}`);
  });
  const original = [];
  for (const name of consumerIds) {
    const identity = await installation.create({ instanceId: name, workspace: { root: 'projects', path: name } });
    assert.equal((await installation.generate(name, `source ${name} 中文🙂`)).text, 'SELECTED_OK 中文🙂');
    const snapshot = await installation.snapshotRuntime(name);
    assert.equal(snapshot.version, '1.1.0');
    original.push({ identity, snapshot, bytes: await readFile(snapshot.session_file!) });
  }
  const task: TaskRecord = { id: '00000000-0000-4000-8000-000000000091', key: 'official-native', requester: 'agent', target: 'shared', action: 'pi-update',
    state: 'running', revision: 2, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    payload: { ...await installation.review(), candidateId, receiptHash, releaseIdentity: receipt.release.identity, version: '1.4.0' } };
  if (preparedFault) {
    const operation = task.id.replaceAll('-', '');
    const journal = path.join(root, 'installation/journal'), dir = path.join(journal, operation);
    const prepared = path.join(dir, '01-prepared.json');
    let written = false, injected = false;
    const open = fs.open;
    const fault = () => { injected = true; throw Error('injected prepared journal persistence uncertainty'); };
    t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await open(...args), file = String(args[0]);
      if (file === prepared) {
        const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
        handle.writeFile = async (...values: Parameters<typeof write>) => {
          await write(...values); written = true;
          if (preparedFault === 'write' && !injected) fault();
        };
        handle.sync = async () => { await sync(); if (preparedFault === 'file-sync' && !injected) fault(); };
      } else if (file === dir) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); if (written && preparedFault === 'directory-sync' && !injected) fault(); };
      }
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { fs.open = open; syncBuiltinESMExports(); });
    assert.equal(originalOwners.length, consumerIds.length);
    const mutations: string[] = [];
    for (const method of ['cancelRuntime', 'commitRuntime', 'stop'] as const) {
      const originalMethod = NativeBackend.prototype[method];
      t.mock.method(NativeBackend.prototype, method, function (this: NativeBackend, ...args: any[]) {
        if (originalOwners.some(o => o.backend === this && o.identity.instanceId === args[0])) mutations.push(method);
        return (originalMethod as Function).apply(this, args);
      });
    }
    faultAttempted = true;
    await assert.rejects(installation.activate(task), ExecutionOutcomeUnknownError);
    assert.equal(injected, true, 'must reach the real prepared journal event after genuine proofs');
    assert.deepEqual(mutations, [], 'unknown must be latched BEFORE any original cancel/commit/stop');
    assert.deepEqual(installation.list(), original.map(o => o.identity));
    for (const old of original) {
      assert.equal((await installation.inspect(old.identity.instanceId))?.pid, old.identity.pid);
      assert.deepEqual(await readFile(old.snapshot.session_file!), old.bytes);
    }
    assert.ok((await readFile(path.join(journal, '.writer'))).length);
    assert.equal(JSON.parse(await readFile(prepared, 'utf8')).stage, 'prepared');
    assert.equal(JSON.parse(await readFile(path.join(journal, 'selection.json'), 'utf8')).revision, 0);
    assert.equal(JSON.parse(await readFile(path.join(root, 'installation/operations', operation, 'outcome.json'), 'utf8')).status, 'unknown');
    await assert.rejects(installation.generate('one', 'must stay fenced'), ExecutionOutcomeUnknownError);
    await assert.rejects(installation.create({ instanceId: 'later', workspace: { root: 'projects', path: 'one' } }), ExecutionOutcomeUnknownError);
    await assert.rejects(installation.stop('one'), ExecutionOutcomeUnknownError);
    await assert.rejects(installation.activate(task), ExecutionOutcomeUnknownError);
    await assert.rejects(installation.close(), ExecutionOutcomeUnknownError);
    assert.deepEqual(mutations, []);
    faultAssertionsComplete = true;
    return;
  }
  const result = await installation.activate(task);
  assert.equal(result.status, 'updated'); assert.equal(result.revision, 1);
  const review = await installation.review(); assert.equal(review.expectedRevision, 1); assert.equal(review.consumers.length, consumerIds.length);
  for (const old of original) {
    const next = await installation.inspect(old.identity.instanceId), snapshot = await installation.snapshotRuntime(old.identity.instanceId);
    assert.ok(next); assert.notEqual(next.pid, old.identity.pid); assert.equal(next.generation, 1);
    assert.equal(snapshot.version, '1.4.0'); assert.notEqual(snapshot.run_id, old.snapshot.run_id);
    assert.equal(snapshot.session_id, old.snapshot.session_id); assert.equal(snapshot.leaf_id, old.snapshot.leaf_id);
    assert.deepEqual(await readFile(snapshot.session_file!), old.bytes);
    assert.throws(() => process.kill(old.identity.pid, 0), { code: 'ESRCH' });
    assert.equal((await installation.generate(old.identity.instanceId, 'after full activation')).text, 'SELECTED_OK 中文🙂');
  }
  // Authored actual regression, NOT FS-double acceptance: selected package
  // copies belong to this new test root. Never mutate the shared candidate.
  const selectedWeb = path.join(root, 'installation/operations', task.id.replaceAll('-', ''), 'web');
  const selectedFile = path.join(selectedWeb, 'dist/index.html'), originalWebBytes = await readFile(selectedFile);
  const later = { instanceId: 'later', workspace: { root: 'projects', path: 'one' } };
  await chmod(selectedFile, 0o600); await writeFile(selectedFile, 'changed selected Web'); await chmod(selectedFile, 0o400);
  try {
    await assert.rejects(installation.create(later), /selected-web-changed/);
    assert.equal(installation.list().length, consumerIds.length);
    assert.equal(await installation.inspect('later'), null);
  } finally { await chmod(selectedFile, 0o600); await writeFile(selectedFile, originalWebBytes); await chmod(selectedFile, 0o400); }
  const peer = path.join(selectedWeb, 'node_modules/@earendil-works/pi-ai'), originalPeer = await readlink(peer);
  await unlink(peer); await symlink(path.join(selectedWeb, 'dist'), peer);
  try {
    await assert.rejects(installation.create(later), /selected-web-changed/);
    assert.equal(installation.list().length, consumerIds.length);
    assert.equal(await installation.inspect('later'), null);
  } finally { await unlink(peer); await symlink(originalPeer, peer); }
  const added = await installation.create(later);
  assert.equal(added.instanceId, 'later');
  // Pi allocates a session pathname at startup but persists it only after a
  // conversation message. Exercise the new consumer before asking the private
  // persisted-session snapshot seam to validate that file; never create it in
  // the test or weaken NativeBackend's file/ownership validation.
  assert.equal((await installation.generate('later', 'new consumer after activation')).text, 'SELECTED_OK 中文🙂');
  assert.equal((await installation.snapshotRuntime('later')).version, '1.4.0');
  await assert.rejects(installation.activate(task), /revision/i);
  await installer.verify(candidateId, receiptHash);
  t.diagnostic(JSON.stringify({ scope: 'private-native-coordinator', affectedConsumers: consumerIds.length, hostNode: process.version, abi: process.versions.modules,
    officialCandidate: candidateId, version: '1.4.0', publicUpdates: false }));
});

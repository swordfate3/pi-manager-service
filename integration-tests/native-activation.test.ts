import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initializeHub } from '../hub/config.ts';
import { NativeInstallation } from '../manager/updates/native-activation.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { webInventory } from '../manager/updates/compatibility-inputs.ts';
import type { TaskRecord } from '../manager/contracts.ts';
import { listen } from '../manager/http.ts';
import { packedWeb } from './fixtures/packed-web.ts';

// Executor-private coordinator acceptance. The gateway/approval adapters are a
// later integration, so public updates stays false even if this test passes.
test('native installation coordinates every official-candidate consumer and publishes before admission', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT || !process.env.PI_MANAGER_TEST_CANDIDATE_ROOT || !process.env.PI_MANAGER_TEST_RECEIPT_SHA256,
  timeout: 180_000,
}, async t => {
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
  for (const name of ['one', 'two']) await mkdir(path.join(projects, name), { recursive: true, mode: 0o700 });
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
  t.after(async () => {
    // No broad cleanup, no adoption or retry after unknown. Preserve exact
    // operation/capture/audit/proof evidence even on a successful acceptance.
    try { await installation.close(); }
    catch (error) { throw Error(`Activation cleanup uncertain; retained ${root}`, { cause: error }); }
    t.diagnostic(`private activation evidence retained: ${root}`);
  });
  const original = [];
  for (const name of ['one', 'two']) {
    const identity = await installation.create({ instanceId: name, workspace: { root: 'projects', path: name } });
    assert.equal((await installation.generate(name, `source ${name} 中文🙂`)).text, 'SELECTED_OK 中文🙂');
    const snapshot = await installation.snapshotRuntime(name);
    assert.equal(snapshot.version, '1.1.0');
    original.push({ identity, snapshot, bytes: await readFile(snapshot.session_file!) });
  }
  const task: TaskRecord = { id: '00000000-0000-4000-8000-000000000091', key: 'official-native', requester: 'agent', target: 'shared', action: 'pi-update',
    state: 'running', revision: 2, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    payload: { ...await installation.review(), candidateId, receiptHash, releaseIdentity: receipt.release.identity, version: '1.4.0' } };
  const result = await installation.activate(task);
  assert.equal(result.status, 'updated'); assert.equal(result.revision, 1);
  const review = await installation.review(); assert.equal(review.expectedRevision, 1); assert.equal(review.consumers.length, 2);
  for (const old of original) {
    const next = await installation.inspect(old.identity.instanceId), snapshot = await installation.snapshotRuntime(old.identity.instanceId);
    assert.ok(next); assert.notEqual(next.pid, old.identity.pid); assert.equal(next.generation, 1);
    assert.equal(snapshot.version, '1.4.0'); assert.notEqual(snapshot.run_id, old.snapshot.run_id);
    assert.equal(snapshot.session_id, old.snapshot.session_id); assert.equal(snapshot.leaf_id, old.snapshot.leaf_id);
    assert.deepEqual(await readFile(snapshot.session_file!), old.bytes);
    assert.throws(() => process.kill(old.identity.pid, 0), { code: 'ESRCH' });
    assert.equal((await installation.generate(old.identity.instanceId, 'after full activation')).text, 'SELECTED_OK 中文🙂');
  }
  await assert.rejects(installation.activate(task), /revision/i);
  await installer.verify(candidateId, receiptHash);
  t.diagnostic(JSON.stringify({ scope: 'private-native-coordinator', affectedConsumers: 2, hostNode: process.version, abi: process.versions.modules,
    officialCandidate: candidateId, version: '1.4.0', publicUpdates: false }));
});

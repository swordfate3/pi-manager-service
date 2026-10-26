import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { NativeBackend, type NativeIdentity, type NativeRuntimeSnapshot } from '../manager/backends/native.ts';
import { CandidateInstaller } from '../manager/updates/candidate.ts';
import { checkNodeEngine } from '../manager/updates/engine.ts';
import { snapshotDialogue } from '../manager/updates/compatibility-inputs.ts';
import { initializeHub } from '../hub/config.ts';
import { listen } from '../manager/http.ts';
import { waitFor } from '../tests/helpers/native-harness.ts';
import { packedWeb } from './fixtures/packed-web.ts';
import { NativeStopEvidence } from './fixtures/native-stop-evidence.ts';

// Private seam acceptance, NOT a public updater or independent administrator
// approval. No Docker calls: the existing verified candidate is read-only input.
// Neither shared node_modules nor any existing Pi/HOME/session is written.
test('actual host-native Pi preserves exact dialogue through 1.1 -> official 1.4 -> 1.1', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT || !process.env.PI_MANAGER_TEST_CANDIDATE_ROOT || !process.env.PI_MANAGER_TEST_RECEIPT_SHA256,
  timeout: 90_000,
}, async t => {
  const candidates = process.env.PI_MANAGER_TEST_CANDIDATE_ROOT!;
  assert.match(candidates, /^\/tmp\/manager-candidate-official-[A-Za-z0-9]+\/candidates$/);
  assert.equal(await realpath(candidates), candidates);
  const receiptHash = process.env.PI_MANAGER_TEST_RECEIPT_SHA256!;
  assert.equal(receiptHash, 'f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3');
  const candidateId = 'c-e302720684b002296b28295be46b483bf2ec8a1fa9e0d08850056e66e92abe2e';
  const config = JSON.parse(await readFile(path.join(candidates, 'policy.json'), 'utf8'));
  assert.equal(config.root, candidates);
  const installer = await CandidateInstaller.open(config);
  const receipt = await installer.verify(candidateId, receiptHash);
  assert.equal(receipt.release.version, '1.4.0');
  checkNodeEngine(receipt.release.nodeEngine, process.versions.node);
  const candidateTree = path.join(candidates, candidateId, 'tree');
  const candidatePeers = path.join(candidateTree, 'node_modules');
  const candidateCli = path.join(candidatePeers, '@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const root = await mkdtemp('/tmp/nvr-');
  const backends: NativeBackend[] = [];
  const cleanup = new NativeStopEvidence(root, backends);
  t.after(() => cleanup.cleanup());
  const workspace = path.join(root, 'projects', 'one'); await mkdir(workspace, { recursive: true });
  const hub = path.join(root, 'hub'); await mkdir(hub, { mode: 0o700 });
  const hubConfigFile = path.join(hub, 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const reserve = await listen(async (_req, res) => { res.end(); }, 0), port = reserve.port; await reserve.close();
  const oldPeers = await realpath(path.resolve('node_modules'));
  async function profile(label: string, peers: string, executable: string) {
    const dir = path.join(root, label); await mkdir(dir, { mode: 0o700 });
    const web = await packedWeb(dir, process.env.PI_MANAGER_TEST_WEB_ROOT!, peers);
    await symlink(peers, path.join(dir, 'node_modules'));
    const extensionPath = path.join(dir, 'provider.ts');
    await copyFile(path.resolve('integration-tests/fixtures/native-update-provider.ts'), extensionPath);
    const backend = new NativeBackend({ piExecutable: executable, workspaceRoots: { projects: path.dirname(workspace) },
      stateRoot: path.join(root, 'state'), agentRoot: path.join(root, 'agent'), runtimeControl: true,
      provider: { extensionPath, name: 'native-update-fixture', model: 'fixed' },
      web: { extensionPath: path.join(web, 'extensions/mirror-server.ts'), hubConfigFile, port },
      startupTimeoutMs: 15_000, generationTimeoutMs: 20_000, stopTimeoutMs: 3000 });
    backends.push(backend); return backend;
  }
  const old = await profile('old', oldPeers, path.join(oldPeers, '.bin/pi'));
  const next = await profile('candidate', candidatePeers, candidateCli);
  const request = { instanceId: 'managed', workspace: { root: 'projects', path: 'one' } };
  const original = await old.create(request);
  assert.equal((await old.generate('managed', 'original user 中文🙂')).text, 'NATIVE_VERSION_OK 中文🙂');
  assert.equal((await old.snapshotRuntime('managed')).version, '1.1.0');
  async function dialogue(sessionId: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    const frames: any[] = []; ws.on('message', b => frames.push(JSON.parse(b.toString())));
    try {
      await once(ws, 'open'); await waitFor(async () => frames.some(f => f.event === 'state_sync'));
      ws.send(JSON.stringify({ type: 'req', id: 'history', method: 'get_messages', params: {
        sessionId, from: -8640000000000000, to: 8640000000000000,
      } }));
      await waitFor(async () => frames.some(f => f.type === 'res' && f.id === 'history'));
      const reply = frames.find(f => f.type === 'res' && f.id === 'history');
      assert.equal(reply.ok, true); assert.equal(reply.result.history.truncatedEntries, 0);
      assert.equal(reply.result.history.nextBefore, null, 'tiny test history must be complete');
      return reply.result.entries.filter((e: any) => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role))
        .map((e: any) => ({ role: e.message.role, text: typeof e.message.content === 'string' ? e.message.content :
          e.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') }));
    } finally { ws.terminate(); }
  }
  const captures = path.join(root, 'captures'); await mkdir(captures, { mode: 0o700 });
  async function cutover(from: NativeBackend, to: NativeBackend, previous: NativeIdentity, operation: string, version: string) {
    const before = await from.snapshotRuntime('managed');
    await from.prepareRuntime('managed', operation, before);
    const capture = await from.captureRuntime('managed', operation, captures);
    const bytes = await readFile(before.session_file!);
    const expected = snapshotDialogue(bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.descriptor().sha256);
    // Do not stop before exact full-state acknowledgement. This test manually
    // exercises the private seam; the product still needs its durable coordinator.
    await from.commitRuntime('managed', operation, capture);
    await cleanup.stop(from, 'managed');
    const successor = await to.resumeForActivation(request, previous, { operationId: operation, snapshot: before });
    const restored = await to.snapshotRuntime('managed');
    assert.equal(restored.version, version); assert.equal(restored.session_id, before.session_id);
    assert.equal(restored.leaf_id, before.leaf_id); assert.equal(restored.session_file, before.session_file);
    assert.notEqual(restored.run_id, before.run_id);
    assert.deepEqual(await readFile(before.session_file!), bytes, 'restore must not migrate/rewrite saved bytes');
    assert.deepEqual(await dialogue(restored.session_id), expected, 'full Web dialogue must match independent saved-data parser');
    await assert.rejects(to.generate('managed', 'before private admission'), /fenced/);
    await to.prepareRuntime('managed', operation, restored);
    await to.admitRuntime('managed', operation, restored);
    return { successor, restored, bytes };
  }
  const upgraded = await cutover(old, next, original, 'a'.repeat(32), '1.4.0');
  assert.equal(upgraded.successor.generation, 1);
  assert.equal((await next.generate('managed', 'after upgrade')).text, 'NATIVE_VERSION_OK 中文🙂');
  const rollback = await cutover(next, old, upgraded.successor, 'b'.repeat(32), '1.1.0');
  assert.equal(rollback.successor.generation, 2);
  assert.equal(rollback.restored.session_id, upgraded.restored.session_id);
  assert.equal((await old.generate('managed', 'after compatible rollback')).text, 'NATIVE_VERSION_OK 中文🙂');
  await installer.verify(candidateId, receiptHash);
  t.diagnostic(JSON.stringify({ scope: 'private-native-seams-only', officialCandidate: candidateId, receiptHash,
    host: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, executable: process.execPath },
    versions: ['1.1.0', '1.4.0', '1.1.0'], originalSession: upgraded.restored.session_id, publicUpdates: false }));
});

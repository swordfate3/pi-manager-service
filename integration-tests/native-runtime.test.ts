import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { NativeBackend } from '../manager/backends/native.ts';
import { initializeHub } from '../hub/config.ts';
import { listen } from '../manager/http.ts';
import { packedWeb } from './fixtures/packed-web.ts';
import { waitFor } from '../tests/helpers/native-harness.ts';
import { WebSocket } from 'ws';

// Must exercise the actual NativeBackend spawn path, shipped preload and packed Web,
// not only the lower-level manually spawned RPC test fixture.
test('owned native Pi and installed Web grant a private exact lease without losing saved dialogue', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const root = await mkdtemp('/tmp/nrc-'); let backend: NativeBackend | undefined;
  t.after(async () => {
    try { for (const instance of backend?.list() ?? []) await backend!.stop(instance.instanceId); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const web = await packedWeb(root, process.env.PI_MANAGER_TEST_WEB_ROOT!);
  await mkdir(path.join(root, 'hub'), { mode: 0o700 });
  const hubConfigFile = path.join(root, 'hub', 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const reserve = await listen(async (_req, response) => { response.end(); }, 0);
  const port = reserve.port; await reserve.close();
  const workspace = path.join(root, 'projects', 'one'); await mkdir(workspace, { recursive: true });
  backend = new NativeBackend({ piExecutable: path.resolve('node_modules/.bin/pi'), workspaceRoots: { projects: path.dirname(workspace) },
    stateRoot: path.join(root, 'state'), agentRoot: path.join(root, 'agent'), runtimeControl: true,
    provider: { extensionPath: path.resolve('integration-tests/fixtures/native-provider.ts'), name: 'native-fixture', model: 'deterministic' },
    web: { extensionPath: path.join(web, 'extensions', 'mirror-server.ts'), hubConfigFile, port },
    startupTimeoutMs: 15_000, stopTimeoutMs: 3000 });
  const identity = await backend.create({ instanceId: 'managed', workspace: { root: 'projects', path: 'one' } });
  await waitFor(async () => { try { await access(path.join(identity.stateDir, 'run', 'control.sock')); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }, 10_000);
  const first = await backend.generate('managed', 'saved dialogue before private fence');
  assert.equal(first.settled, true); assert.match(first.text, /NATIVE_PI_GENERATION_OK/);
  const snapshot = await backend.snapshotRuntime('managed').catch(async error => {
    const sessions = path.join(identity.stateDir, 'sessions');
    const files = await Promise.all((await readdir(sessions)).map(async name => {
      const s = await lstat(path.join(sessions, name)); return { mode: (s.mode & 0o777).toString(8), links: s.nlink, owned: s.uid === process.getuid?.(), file: s.isFile() };
    }));
    throw Error(`Private snapshot failed; session-root mode=${((await lstat(sessions)).mode & 0o777).toString(8)}, entries=${JSON.stringify(files)}`, { cause: error });
  });
  assert.equal(snapshot.idle, true); assert.equal(snapshot.busy, false); assert.ok(snapshot.session_file);
  const operation = 'b'.repeat(32);
  const prepared = await backend.prepareRuntime('managed', operation, snapshot);
  assert.equal(prepared.session_id, snapshot.session_id);
  assert.equal(prepared.leaf_id, snapshot.leaf_id);
  await assert.rejects(backend.generate('managed', 'must not be delivered'), /fenced/);
  await backend.cancelRuntime('managed', operation);
  assert.equal((await backend.generate('managed', 'second dialogue after private fence')).settled, true);
  const after = await backend.snapshotRuntime('managed');
  assert.equal(after.session_id, snapshot.session_id); assert.notEqual(after.leaf_id, snapshot.leaf_id);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  t.after(() => ws.terminate());
  const messages: any[] = []; ws.on('message', value => messages.push(JSON.parse(value.toString())));
  await once(ws, 'open');
  await waitFor(async () => messages.some(m => m.event === 'state_sync'));
  ws.send(JSON.stringify({ type: 'req', id: 'owned-web', method: 'prompt', params: { message: 'web dialogue after native input' } }));
  await waitFor(async () => messages.some(m => m.type === 'res' && m.id === 'owned-web'));
  assert.equal(messages.find(m => m.type === 'res' && m.id === 'owned-web').ok, true);
  await waitFor(async () => {
    const state = await backend!.snapshotRuntime('managed');
    return state.idle && !state.busy && state.leaf_id !== after.leaf_id;
  });
  const webState = await backend.snapshotRuntime('managed');
  assert.equal((await backend.prepareRuntime('managed', operation, webState)).session_id, after.session_id);
  await backend.cancelRuntime('managed', operation);
  const captures = path.join(root, 'captures'); await mkdir(captures, { mode: 0o700 });
  const finalState = await backend.snapshotRuntime('managed');
  await backend.prepareRuntime('managed', operation, finalState);
  const captured = await backend.captureRuntime('managed', operation, captures);
  assert.equal(captured.descriptor().sessionId, snapshot.session_id);
  assert.deepEqual(await backend.commitRuntime('managed', operation, captured), finalState);
  await assert.rejects(backend.generate('managed', 'cannot reopen after verified native commit'), /fenced/);
  await assert.rejects(backend.cancelRuntime('managed', operation));
});

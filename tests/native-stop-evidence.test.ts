import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { NativeBackend } from '../manager/backends/native.ts';
import { ExecutionOutcomeUnknownError } from '../manager/errors.ts';
import { initializeHub, readHubConfig } from '../hub/config.ts';
import { NativeStopEvidence } from '../integration-tests/fixtures/native-stop-evidence.ts';
import { assertDead } from './helpers/native-harness.ts';

for (const boundary of ['cutover', 'teardown'] as const) test(`${boundary} revocation failure after real child exit retains root even with empty owned map`, async t => {
  const root = await mkdtemp('/tmp/native-stop-evidence-');
  const workspace = path.join(root, 'work'); await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, 'scenario.json'), '"normal"');
  const executable = path.join(root, 'child.mjs');
  await writeFile(executable, `#!${process.execPath}\n${await readFile(new URL('./fixtures/native-child.mjs', import.meta.url), 'utf8')}`, { mode: 0o700 });
  const hubConfigFile = path.join(root, 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const backend = new NativeBackend({ piExecutable: executable, workspaceRoots: { test: root }, stateRoot: path.join(root, 'children'),
    agentRoot: path.join(root, 'agents'), web: { extensionPath: executable, hubConfigFile, port: 18765 }, stopTimeoutMs: 300 });
  const cleanup = new NativeStopEvidence(root, [backend]);
  const identity = await backend.create({ instanceId: 'disposable', workspace: { root: 'test', path: 'work' } });
  // Genuine private-FS revocation fault; child/process/stop behavior are not mocked.
  await mkdir(path.join(readHubConfig(hubConfigFile).stateDir, '.writer.lock'), { mode: 0o700 });
  const stop = t.mock.method(backend, 'stop');
  let original: unknown;
  if (boundary === 'cutover') {
    await assert.rejects(cleanup.stop(backend, 'disposable'), e => { original = e; return e instanceof ExecutionOutcomeUnknownError; });
    assertDead(identity.pid); assert.deepEqual(backend.list(), []);
  }
  await assert.rejects(cleanup.cleanup(), (e: any) => {
    assert.match(e.message, /evidence retained/); assert.ok(e.message.includes(root));
    assert.ok(e.cause instanceof ExecutionOutcomeUnknownError);
    if (original) assert.equal(e.cause, original); else original = e.cause;
    return true;
  });
  assertDead(identity.pid); assert.deepEqual(backend.list(), []);
  await access(root); await access(path.join(identity.stateDir, 'identity.json'));
  await assert.rejects(cleanup.cleanup(), (e: any) => e.cause === original);
  await assert.rejects(cleanup.stop(backend, 'disposable'), e => e === original);
  assert.equal(stop.mock.calls.length, 1, 'uncertain stop is never automatically retried');
  // Explicit regression-fixture disposal only after all retention/death assertions.
  await rm(root, { recursive: true, force: true });
});

test('fully acknowledged stops allow private test-root cleanup', async () => {
  const root = await mkdtemp('/tmp/native-stop-clean-');
  const cleanup = new NativeStopEvidence(root, []);
  await cleanup.cleanup();
  await assert.rejects(access(root), { code: 'ENOENT' });
});

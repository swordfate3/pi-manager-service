import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NativeBackend } from "../manager/backends/native.ts";
import { initializeHub } from "../hub/config.ts";
import { harness, observation } from "./helpers/native-harness.ts";
import { executorConfig } from "../manager/config.ts";
import { RuntimeClient, type RuntimeCommand } from '../manager/backends/runtime-client.ts';

test("optional managed native runtime loads only the shipped guard and private per-generation credentials", async t => {
  const cleanups: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any);
  await mkdir(path.join(f.parent, "hub"), { mode: 0o700 });
  const hubConfigFile = path.join(f.parent, "hub", "hub.json"); initializeHub(hubConfigFile, { port: 0 });
  const config = { ...f.config, runtimeControl: true, web: { extensionPath: path.resolve("integration-tests/fixtures/native-provider.ts"), hubConfigFile, port: 19991 } };
  const backend = new NativeBackend(config);
  t.after(async () => { try { for (const i of backend.list()) await backend.stop(i.instanceId); } finally { for (const cleanup of cleanups) await cleanup(); } });
  const identity = await backend.create(f.request);
  const seen = await observation(f.workspace);
  assert.equal(seen.runtimeTransport, "pi-rpc-v1:stdin-stdout-jsonl");
  assert.equal(seen.env.PI_RUNTIME_RPC_WEB_INPUT, "correlated-text-v1");
  assert.match(seen.env.PI_RUNTIME_RUN_ID, /^[a-f0-9]{32}$/);
  assert.match(seen.env.PI_RUNTIME_CHILD_TOKEN, /^[a-f0-9]{64}$/);
  assert.ok(seen.env.PI_RUNTIME_EXTENSION_SOCKET.startsWith(path.join(identity.stateDir, "run") + path.sep));
  assert.equal(seen.env.NODE_OPTIONS, undefined);
  const serialized = JSON.stringify(identity);
  assert.equal(serialized.includes(seen.env.PI_RUNTIME_CHILD_TOKEN), false);
  assert.equal(serialized.includes(seen.env.PI_RUNTIME_RUN_ID), false);
  const inspected = await backend.inspect(identity.instanceId);
  assert.equal(JSON.stringify(inspected).includes(seen.env.PI_RUNTIME_CHILD_TOKEN), false);
});

async function runtimeFixture(t: any) {
  const cleanups: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any);
  const source = await readFile(new URL('./fixtures/native-runtime-child.mjs', import.meta.url), 'utf8');
  await writeFile(f.config.piExecutable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(f.config.piExecutable, 0o700);
  await mkdir(path.join(f.parent, 'hub'), { mode: 0o700 });
  const hubConfigFile = path.join(f.parent, 'hub', 'hub.json'); initializeHub(hubConfigFile, { port: 0 });
  const backend = new NativeBackend({ ...f.config, runtimeControl: true,
    web: { extensionPath: path.resolve('integration-tests/fixtures/native-provider.ts'), hubConfigFile, port: 19992 } });
  t.after(async () => { try { for (const i of backend.list()) await backend.stop(i.instanceId); } finally { for (const cleanup of cleanups) await cleanup(); } });
  await backend.create(f.request);
  return { ...f, backend, control: (value: unknown) => writeFile(path.join(f.workspace, 'control.json'), JSON.stringify(value)) };
}

test('native update lease blocks parent input synchronously through prepare and requires exact cancellation', async t => {
  const f = await runtimeFixture(t); const backend = f.backend as any, id = f.request.instanceId;
  const state = await backend.snapshotRuntime(id);
  assert.equal(state.version, '1.4.0'); assert.equal(state.cwd, f.workspace);
  await f.control({ delayPrepare: true });
  const operation = 'b'.repeat(32);
  const prepared = backend.prepareRuntime(id, operation, state);
  await assert.rejects(backend.generate(id, 'must-not-cross-preparation'), /barrier|lease|fenced/i);
  const held = await prepared;
  assert.equal(held.session_id, 'fixture-session');
  await assert.rejects(access(path.join(f.workspace, 'prompt-delivered')));
  await assert.rejects(backend.cancelRuntime(id, 'c'.repeat(32)), /lease|operation/i);
  await assert.rejects(backend.generate(id, 'still-blocked'), /barrier|lease|fenced/i);
  await backend.cancelRuntime(id, operation);
  await backend.generate(id, 'allowed-after-cancel');
  assert.equal(await readFile(path.join(f.workspace, 'prompt-delivered'), 'utf8'), 'allowed-after-cancel');
});

test('native runtime validates generation, workspace, saved-session scope and closed snapshot schema', async t => {
  const f = await runtimeFixture(t); const backend = f.backend as any, id = f.request.instanceId;
  for (const snapshot of [{ run_id: 'd'.repeat(32) }, { cwd: f.parent }, { session_file: '/tmp/not-this-session.jsonl' },
    { idle: 'true' }, { version: 'latest' }, { injected: true }]) {
    await f.control({ snapshot });
    await assert.rejects(backend.snapshotRuntime(id), /runtime|snapshot|session/i);
  }
  await f.control({});
  const state = await backend.snapshotRuntime(id);
  await chmod(state.session_file, 0o664);
  assert.equal((await backend.snapshotRuntime(id)).session_id, 'fixture-session', 'A private 0700 ancestor protects ordinary Pi umask permissions');
  const sessions = path.dirname(state.session_file);
  await chmod(sessions, 0o750);
  await assert.rejects(backend.snapshotRuntime(id), /session/i);
  await chmod(sessions, 0o700);
  await assert.rejects(backend.prepareRuntime(id, 'e'.repeat(32), { ...state, run_id: 'f'.repeat(32) }), /runtime|snapshot|generation/i);
  await assert.rejects(access(path.join(f.workspace, 'prepare-observed')));
  await backend.stop(id);
  await assert.rejects(backend.snapshotRuntime(id), /owned|ready/i);
});

test('lost prepare or cancel replies preserve the parent fence instead of claiming safe input', async t => {
  for (const action of ['prepare', 'cancel']) {
    const f = await runtimeFixture(t); const backend = f.backend as any, id = f.request.instanceId;
    const state = await backend.snapshotRuntime(id), operation = 'a'.repeat(32);
    if (action === 'prepare') {
      await f.control({ losePrepareReply: true });
      await assert.rejects(backend.prepareRuntime(id, operation, state), /unknown/i);
    } else {
      await backend.prepareRuntime(id, operation, state);
      await f.control({ loseCancelReply: true });
      await assert.rejects(backend.cancelRuntime(id, operation), /unknown/i);
    }
    await assert.rejects(backend.generate(id, 'unsafe-after-uncertainty'), /barrier|lease|fenced/i);
    await assert.rejects(backend.prepareRuntime(id, 'b'.repeat(32), state), /barrier|lease|uncertain/i);
    await assert.rejects(access(path.join(f.workspace, 'prompt-delivered')));
  }
});

test('an old generation cannot finish prepare or cancel against a replacement with the same instance ID', async t => {
  for (const action of ['prepare', 'cancel'] as const) {
    const f = await runtimeFixture(t), id = f.request.instanceId;
    const oldIdentity = f.backend.list()[0], state = await f.backend.snapshotRuntime(id), operation = 'd'.repeat(32);
    if (action === 'cancel') await f.backend.prepareRuntime(id, operation, state);
    const original = RuntimeClient.prototype.request;
    let received!: () => void, release!: () => void;
    const replyReceived = new Promise<void>(resolve => { received = resolve; });
    const continueReply = new Promise<void>(resolve => { release = resolve; });
    // Keep the real IPC and reply; hold its delivery to the backend at the
    // dependency boundary so lifecycle replacement happens deterministically.
    const mock = t.mock.method(RuntimeClient.prototype, 'request', async function (this: RuntimeClient, value: RuntimeCommand) {
      const result = await original.call(this, value);
      if (value.action === action) { received(); await continueReply; }
      return result;
    });
    const pending = action === 'prepare' ? f.backend.prepareRuntime(id, operation, state) : f.backend.cancelRuntime(id, operation);
    void pending.catch(() => {});
    try {
      await replyReceived;
      await f.backend.stop(id);
      await f.backend.resume(f.request, oldIdentity);
      release();
      await assert.rejects(pending, /unknown|generation/i, 'Old generation evidence must not validate against a replacement');
      assert.notEqual((await f.backend.snapshotRuntime(id)).run_id, state.run_id);
      await f.backend.generate(id, 'replacement remains independently usable');
    } finally { release(); await pending.catch(() => {}); mock.mock.restore(); }
  }
});

test("runtime control is opt-in and requires an explicit Web profile; config cannot choose preload code", async t => {
  const f = await harness(t);
  await f.backend.create(f.request);
  const seen = await observation(f.workspace);
  assert.equal(seen.runtimeTransport, null); assert.equal(seen.env.PI_RUNTIME_CHILD_TOKEN, undefined);
  assert.throws(() => new NativeBackend({ ...f.config, runtimeControl: true }), /runtime.*Web/i);
  const config = { stateRoot: path.join(f.parent, "tasks"), submitSocket: path.join(f.parent, "submit", "rpc.sock"), adminSocket: path.join(f.parent, "admin", "rpc.sock"),
    trustedLocalNative: true, native: { ...f.config, runtimeControl: { guardPath: "/tmp/arbitrary.mjs" } },
    principals: [{ id: "agent", role: "submitter", tokenHash: "a".repeat(64) }], workspaces: {} };
  assert.throws(() => executorConfig(config));
});

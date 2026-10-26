import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from 'node:net';
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

// Keep the actual socket/endpoint checks. Hold only delivery of its connected
// event, at the last asynchronous dependency before RuntimeClient writes bytes.
function pauseConnected(t: any, nth: number) {
  let reached!: () => void, release!: () => void;
  const connected = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const original = net.createConnection;
  const mock = t.mock.method(net, 'createConnection', (...args: any[]) => {
    const peer = (original as any)(...args) as net.Socket;
    if (--nth === 0) {
      const on = peer.on;
      peer.on = function (event: string, listener: (...args: any[]) => void) {
        return on.call(this, event, event === 'connect' ? () => { reached(); void resume.then(() => listener()); } : listener);
      };
    }
    return peer;
  });
  return { connected, release, restore: () => mock.mock.restore() };
}

for (const action of ['commit', 'admit'] as const) {
  for (const mode of action === 'commit' ? ['copy-change', 'deadline', 'replacement'] : ['deadline', 'replacement']) {
    test(`native ${action} checks ${mode} after connect and before credential dispatch`, { timeout: 10_000 }, async t => {
      const f = await runtimeFixture(t), id = f.request.instanceId, operation = 'a'.repeat(32);
      let previous = f.backend.list()[0], state = await f.backend.snapshotRuntime(id);
      if (action === 'admit') {
        await f.backend.stop(id);
        previous = await f.backend.resumeForActivation(f.request, previous, { operationId: operation, snapshot: state });
        state = await f.backend.snapshotRuntime(id);
      }
      let now = performance.now();
      const clock = t.mock.method(performance, 'now', () => now);
      await f.backend.prepareRuntime(id, operation, state);
      const root = path.join(f.parent, 'captures'); await mkdir(root, { mode: 0o700 });
      const capture = action === 'commit' ? await f.backend.captureRuntime(id, operation, root) : undefined;
      const paused = pauseConnected(t, action === 'commit' ? 2 : 1);
      const pending = action === 'commit' ? f.backend.commitRuntime(id, operation, capture!) : f.backend.admitRuntime(id, operation, state);
      void pending.catch(() => {});
      try {
        await paused.connected;
        if (mode === 'copy-change') {
          const copy = path.join(root, capture!.descriptor().reference);
          await chmod(copy, 0o600); await writeFile(copy, 'tampered capture copy\n');
        } else if (mode === 'deadline') now += 150_001;
        else {
          await f.backend.stop(id);
          await f.backend.resume(f.request, previous);
        }
        paused.release();
        await assert.rejects(pending, error => !/unknown/i.test(String(error)), 'No bytes dispatched is a definite refusal, not an unknown outcome');
        await assert.rejects(access(path.join(f.workspace, `${action}-observed`)), 'The child must receive zero final requests');
        if (capture) await access(path.join(root, capture.descriptor().reference));
        if (mode !== 'replacement') await assert.rejects(f.backend.generate(id, 'parent gate remains held'), /fenced/i);
        else await f.backend.generate(id, 'replacement did not inherit old authority');
      } finally { paused.release(); await pending.catch(() => {}); paused.restore(); clock.mock.restore(); }
    });
  }
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

test('native preparation binds the complete original snapshot, including provider, model and thinking', async t => {
  for (const snapshot of [{ provider: 'other' }, { model: 'other' }, { thinking: 'low' }]) {
    const f = await runtimeFixture(t), id = f.request.instanceId;
    const state = await f.backend.snapshotRuntime(id);
    await f.control({ snapshot });
    await assert.rejects(f.backend.prepareRuntime(id, 'a'.repeat(32), state), /unknown|changed/i);
    await assert.rejects(f.backend.generate(id, 'cannot-cross-drift'), /fenced/i);
  }
});

test('native final commit requires its own original lease and captured saved data, and cannot reopen input', async t => {
  const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'e'.repeat(32);
  assert.equal(typeof backend.captureRuntime, 'function', 'Native backend must bind capture to its original lease');
  assert.equal(typeof backend.commitRuntime, 'function', 'Native backend must verify a private final commit');
  const root = path.join(f.parent, 'captures'); await mkdir(root, { mode: 0o700 });
  const state = await backend.snapshotRuntime(id);
  await assert.rejects(backend.captureRuntime(id, operation, root));
  await backend.prepareRuntime(id, operation, state);
  const captured = await backend.captureRuntime(id, operation, root);
  assert.equal(captured.descriptor().sessionId, 'fixture-session');
  const committed = await backend.commitRuntime(id, operation, captured);
  assert.deepEqual(committed, state);
  assert.equal(await readFile(path.join(f.workspace, 'commit-observed'), 'utf8'), operation);
  await assert.rejects(backend.cancelRuntime(id, operation));
  await assert.rejects(backend.commitRuntime(id, operation, captured));
  await assert.rejects(backend.generate(id, 'not-after-commit'), /fenced/i);
});

test('native final commit refuses changed live bytes before IPC and lost acknowledgement stays unknown', async t => {
  for (const mode of ['changed-session', 'lost-reply']) {
    const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'f'.repeat(32);
    assert.equal(typeof backend.captureRuntime, 'function', 'Original lease capture must exist');
    const root = path.join(f.parent, 'captures'); await mkdir(root, { mode: 0o700 });
    const state = await backend.snapshotRuntime(id);
    await backend.prepareRuntime(id, operation, state);
    const captured = await backend.captureRuntime(id, operation, root);
    if (mode === 'changed-session') {
      await writeFile(state.session_file, '{"type":"session","id":"changed"}\n');
      await assert.rejects(backend.commitRuntime(id, operation, captured));
      await assert.rejects(access(path.join(f.workspace, 'commit-observed')));
    } else {
      await f.control({ loseCommitReply: true });
      await assert.rejects(backend.commitRuntime(id, operation, captured), /unknown/i);
      assert.equal(await readFile(path.join(f.workspace, 'commit-observed'), 'utf8'), operation);
      await assert.rejects(backend.cancelRuntime(id, operation));
      await assert.rejects(backend.commitRuntime(id, operation, captured));
    }
    await assert.rejects(backend.generate(id, 'must-stay-held'), /fenced/i);
  }
});

test('native capture cannot renew the monotonic deadline reserved before preparation awaits', async t => {
  const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'c'.repeat(32);
  const state = await backend.snapshotRuntime(id), root = path.join(f.parent, 'captures');
  await mkdir(root, { mode: 0o700 });
  let now = performance.now();
  const clock = t.mock.method(performance, 'now', () => now);
  try {
    await backend.prepareRuntime(id, operation, state);
    now += 149_900;
    const capture = await backend.captureRuntime(id, operation, root);
    assert.ok(capture.descriptor().expiresAt <= now + 100, 'Capturing cannot mint a new 150-second lease');
    now += 101;
    await assert.rejects(backend.commitRuntime(id, operation, capture), /expired|lease/i);
    await assert.rejects(access(path.join(f.workspace, 'commit-observed')));
    await assert.rejects(backend.generate(id, 'deadline-cannot-reopen-input'), /fenced/i);
  } finally { clock.mock.restore(); }
});

test('post-dispatch native commit cannot complete against a replacement of the original owned child', async t => {
  const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'd'.repeat(32);
  const previous = f.backend.list()[0], state = await backend.snapshotRuntime(id), root = path.join(f.parent, 'captures');
  await mkdir(root, { mode: 0o700 });
  await backend.prepareRuntime(id, operation, state);
  const capture = await backend.captureRuntime(id, operation, root);
  const original = RuntimeClient.prototype.request;
  let received!: () => void, release!: () => void;
  const replyReceived = new Promise<void>(resolve => { received = resolve; });
  const continueReply = new Promise<void>(resolve => { release = resolve; });
  const held = t.mock.method(RuntimeClient.prototype, 'request', async function (this: RuntimeClient, ...args: Parameters<RuntimeClient['request']>) {
    const [value] = args;
    const result = await original.apply(this, args);
    if (value.action === 'commit') { received(); await continueReply; }
    return result;
  });
  const pending = backend.commitRuntime(id, operation, capture); void pending.catch(() => {});
  try {
    await replyReceived;
    await assert.rejects(backend.cancelRuntime(id, operation), /unavailable|lease/i);
    await backend.stop(id); await backend.resume(f.request, previous);
    release(); await assert.rejects(pending, /unknown/i);
    assert.notEqual((await backend.snapshotRuntime(id)).run_id, state.run_id);
    await backend.generate(id, 'replacement must not inherit old commit authority');
  } finally { release(); await pending.catch(() => {}); held.mock.restore(); }
});

test('native exact saved-data successor stays input-closed through cancel until original prepared admission', async t => {
  const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'b'.repeat(32);
  assert.equal(typeof backend.resumeForActivation, 'function', 'Native successor must restore an explicit saved file behind bootstrap input');
  const previous = backend.list()[0], original = await backend.snapshotRuntime(id);
  await assert.rejects(backend.resumeForActivation(f.request, previous, { operationId: operation, snapshot: original }));
  await backend.stop(id);
  const identity = await backend.resumeForActivation(f.request, previous, { operationId: operation, snapshot: original });
  assert.equal(identity.generation, previous.generation + 1);
  const state = await backend.snapshotRuntime(id);
  assert.equal(state.session_file, original.session_file); assert.equal(state.session_id, original.session_id);
  assert.notEqual(state.run_id, original.run_id);
  await assert.rejects(backend.generate(id, 'no-startup-gap'), /fenced/i);
  await assert.rejects(backend.prepareRuntime(id, 'c'.repeat(32), state));
  await backend.prepareRuntime(id, operation, state);
  await backend.cancelRuntime(id, operation);
  await assert.rejects(backend.generate(id, 'cancel-is-not-admission'), /fenced/i);
  await backend.prepareRuntime(id, operation, state);
  assert.deepEqual(await backend.admitRuntime(id, operation, state), state);
  await backend.generate(id, 'after-exact-admission');
  assert.equal(await readFile(path.join(f.workspace, 'prompt-delivered'), 'utf8'), 'after-exact-admission');
  await assert.rejects(backend.admitRuntime(id, operation, state));
});

test('native successor refuses caller-selected session escape and retains parent gate on lost admission acknowledgement', async t => {
  const f = await runtimeFixture(t), backend = f.backend as any, id = f.request.instanceId, operation = 'a'.repeat(32);
  assert.equal(typeof backend.resumeForActivation, 'function', 'Native successor API must exist');
  const previous = backend.list()[0], original = await backend.snapshotRuntime(id);
  await backend.stop(id);
  for (const snapshot of [{ ...original, session_file: '/tmp/outside.jsonl' }, { ...original, cwd: f.parent }, { ...original, busy: true }]) {
    await assert.rejects(backend.resumeForActivation(f.request, previous, { operationId: operation, snapshot }));
    assert.equal(backend.list().length, 0);
  }
  await backend.resumeForActivation(f.request, previous, { operationId: operation, snapshot: original });
  const state = await backend.snapshotRuntime(id);
  await backend.prepareRuntime(id, operation, state);
  await f.control({ loseAdmitReply: true });
  await assert.rejects(backend.admitRuntime(id, operation, state), /unknown/i);
  assert.equal(await readFile(path.join(f.workspace, 'admit-observed'), 'utf8'), operation);
  await assert.rejects(backend.admitRuntime(id, operation, state));
  await assert.rejects(backend.cancelRuntime(id, operation));
  await assert.rejects(backend.generate(id, 'cannot-assume-admitted'), /fenced/i);
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

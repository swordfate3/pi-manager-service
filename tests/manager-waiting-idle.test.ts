import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { ExecutorConfig } from '../manager/config.ts';
import type { TaskRecord } from '../manager/contracts.ts';
import type { TaskBackendAdapter } from '../manager/executor/adapter.ts';
import { TaskEngine } from '../manager/executor/engine.ts';
import { ExecutionOutcomeUnknownError } from '../manager/errors.ts';
import { TaskStore } from '../manager/task-store.ts';

const submit = 'test-agent-000000000000000000000000000', admin = 'test-admin-000000000000000000000000000';
function deferred() {
  let resolve!: () => void, reject!: (error?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function fixture(t: any) {
  const root = await mkdtemp('/tmp/manager-idle-');
  const config: ExecutorConfig = { stateRoot: path.join(root, 'tasks'), submitSocket: path.join(root, 'submit.sock'), adminSocket: path.join(root, 'admin.sock'),
    workspaces: {}, native: null, trustedLocalNative: false, principals: [
      { id: 'agent', role: 'submitter', tokenHash: createHash('sha256').update(submit).digest('hex') },
      { id: 'administrator', role: 'admin', tokenHash: createHash('sha256').update(admin).digest('hex') },
    ] };
  const store = await TaskStore.open(config.stateRoot);
  const task = await store.submit({ key: 'idle-test', requester: 'agent', action: 'stop', target: 'managed', payload: {} });
  await store.close();
  const released = deferred(), entered = deferred(), effect = path.join(root, 'executed');
  const policy = { revision: 1 };
  // External runtime readiness is controlled. The task queue, approval, storage,
  // cancellation and execution-state changes under test are production code.
  const adapter: TaskBackendAdapter & { waitForIdle: (task: TaskRecord, signal: AbortSignal) => Promise<void> } = {
    policy, actions: ['stop'], validate: async () => {}, resources: () => [], close: async () => {},
    waitForIdle: async () => { entered.resolve(); await released.promise; },
    execute: async current => { await writeFile(effect, current.state, { flag: 'wx' }); return { status: 'stopped' }; },
  };
  let engine = await TaskEngine.open(config, adapter);
  t.after(async () => { try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const query = () => engine.dispatch('submit', submit, { op: 'get', taskId: task.id }) as Promise<TaskRecord>;
  const approve = async () => {
    const review: any = await engine.dispatch('admin', admin, { op: 'review', taskId: task.id });
    return engine.dispatch('admin', admin, { op: 'approve', ...review.binding }) as Promise<TaskRecord>;
  };
  const execute = async () => {
    const queued = await approve();
    return engine.dispatch('admin', admin, { op: 'execute', taskId: task.id, revision: queued.revision }) as Promise<TaskRecord>;
  };
  const settled = async () => {
    const until = performance.now() + 3000;
    for (;;) {
      const current = await query();
      if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(current.state)) return current;
      if (performance.now() >= until) throw Error('Task did not settle');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { root, config, task, policy, adapter, released, entered, effect, query, approve, execute, settled,
    engine: () => engine, reopen: async () => { engine = await TaskEngine.open(config, adapter); } };
}

// Removing the durable waiting transition would execute the action while the
// external consumer is still busy and make the live/reopened state assertions fail.
test('approved work remains one durable waiting_idle task until the runtime settles', async t => {
  const f = await fixture(t);
  const waiting = await f.execute();
  assert.equal(waiting.state, 'waiting_idle'); assert.equal(waiting.revision, 3);
  await f.entered.promise;
  assert.equal((await f.query()).state, 'waiting_idle');
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
  await assert.rejects(f.engine().dispatch('admin', admin, { op: 'execute', taskId: waiting.id, revision: waiting.revision }), { status: 409 });
  await assert.rejects(f.engine().dispatch('submit', submit, { op: 'approve', taskId: waiting.id }), { status: 403 });
  f.released.resolve();
  const done = await f.settled(); assert.equal(done.state, 'succeeded'); assert.equal(done.revision, 5);
  assert.equal(await readFile(f.effect, 'utf8'), 'running');
  await f.engine().close(); await f.reopen();
  assert.equal((await f.query()).state, 'succeeded');
  assert.equal((await f.engine().dispatch('submit', submit, { op: 'list' }) as any[]).length, 1);
});

test('executor close cancels waiting work and late readiness cannot run it', { timeout: 8000 }, async t => {
  const f = await fixture(t); await f.execute(); await f.entered.promise;
  await f.engine().close();
  f.released.resolve();
  await f.reopen();
  const cancelled = await f.query();
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.result, { status: 'executor-stopping' });
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
});

for (const unknown of [false, true]) {
  test(`readiness ${unknown ? 'uncertainty' : 'failure'} is durable without executing the action`, async t => {
    const f = await fixture(t); await f.execute(); await f.entered.promise;
    f.released.reject(unknown ? new ExecutionOutcomeUnknownError() : Error('private readiness detail must not leak'));
    const done = await f.settled(); assert.equal(done.state, unknown ? 'unknown' : 'failed');
    assert.deepEqual(done.result, { status: unknown ? 'execution-outcome-unknown' : 'execution-failed' });
    await assert.rejects(access(f.effect), { code: 'ENOENT' });
  });
}

test('undefined readiness rejection while unaborted is a durable failure, not executor shutdown', async t => {
  const f = await fixture(t);
  let observationSignal: AbortSignal | undefined;
  f.adapter.waitForIdle = async (_task, signal) => {
    observationSignal = signal; f.entered.resolve(); await f.released.promise;
  };
  await f.execute(); await f.entered.promise;
  assert.ok(observationSignal); assert.equal(observationSignal.aborted, false);
  assert.equal(observationSignal.reason, undefined);
  f.released.reject(undefined);
  const failed = await f.settled();
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.result, { status: 'execution-failed' });
  assert.equal(observationSignal.aborted, false, 'Classify before close can abort the signal');
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
  await f.engine().close(); await f.reopen();
  const reopened = await f.query();
  assert.equal(reopened.state, 'failed'); assert.deepEqual(reopened.result, { status: 'execution-failed' });
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
});

test('readiness revalidation rejection persists failure without backend execution', async t => {
  const f = await fixture(t); await f.execute(); await f.entered.promise;
  f.adapter.validate = async () => { throw Error('private validation detail must not escape'); };
  f.released.resolve();
  const failed = await f.settled();
  assert.equal(failed.state, 'failed'); assert.deepEqual(failed.result, { status: 'execution-failed' });
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
  await f.engine().close(); await f.reopen();
  assert.equal((await f.query()).state, 'failed');
});

for (const boundary of ['validation', 'running-persistence'] as const) {
  test(`shutdown during ${boundary} cancels before backend execution and stays cancelled after reopen`, { timeout: 8000 }, async t => {
    const f = await fixture(t), reached = deferred(), resume = deferred();
    await f.execute(); await f.entered.promise;
    if (boundary === 'validation') {
      f.adapter.validate = async () => { reached.resolve(); await resume.promise; };
    } else {
      const original = TaskStore.prototype.transition;
      t.mock.method(TaskStore.prototype, 'transition', async function (this: TaskStore, ...args: Parameters<TaskStore['transition']>) {
        const persisted = await original.apply(this, args);
        if (args[0] === f.task.id && args[1] === 'waiting_idle' && args[2] === 'running') {
          reached.resolve(); await resume.promise;
        }
        return persisted;
      });
    }
    try {
      f.released.resolve(); await reached.promise;
      assert.equal((await f.query()).state, boundary === 'validation' ? 'waiting_idle' : 'running');
      const closing = f.engine().close();
      resume.resolve(); await closing;
      await f.reopen();
      const cancelled = await f.query();
      assert.equal(cancelled.state, 'cancelled'); assert.deepEqual(cancelled.result, { status: 'executor-stopping' });
      await assert.rejects(access(f.effect), { code: 'ENOENT' });
    } finally { resume.resolve(); }
  });
}

test('policy drift during waiting refuses the now-ready action', async t => {
  const f = await fixture(t); await f.execute(); await f.entered.promise;
  f.policy.revision = 2; f.released.resolve();
  assert.equal((await f.settled()).state, 'failed');
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
});

test('readiness cannot mutate stored identity or the terminal compare-and-set', async t => {
  const f = await fixture(t);
  f.adapter.waitForIdle = async mutable => { (mutable as any).id = 'not-the-task'; (mutable as any).revision = 999; };
  await f.execute();
  const done = await f.settled();
  assert.equal(done.id, f.task.id); assert.equal(done.state, 'succeeded'); assert.equal(done.revision, 5);
  assert.equal(await readFile(f.effect, 'utf8'), 'running');
});

test('waiting support does not expose unimplemented updates or trust request-provided readiness', async t => {
  const f = await fixture(t);
  assert.equal((await f.engine().dispatch('submit', submit, { op: 'capabilities' }) as any).updates, false);
  await assert.rejects(f.engine().dispatch('submit', submit, { op: 'submit', request: {
    key: 'update', target: 'managed', action: 'update', version: '1.4.0', waitForIdle: false,
  } }), { status: 503 });
  await assert.rejects(f.engine().dispatch('submit', submit, { op: 'submit', request: {
    key: 'skip-wait', target: 'managed', action: 'stop', waitForIdle: false,
  } }), { status: 400 });
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
});

test('reopening a stranded waiting task marks it unknown and does not resume or approve it', async t => {
  const f = await fixture(t); await f.engine().close();
  const store = await TaskStore.open(f.config.stateRoot);
  const queued = await store.transition(f.task.id, 'pending_approval', 'queued', { expectedRevision: 1 });
  const waiting = await store.transition(f.task.id, 'queued', 'waiting_idle', { expectedRevision: queued.revision });
  await store.close(); await f.reopen();
  const current = await f.query(); assert.equal(current.state, 'unknown'); assert.equal(current.revision, waiting.revision + 1);
  await assert.rejects(f.engine().dispatch('admin', admin, { op: 'execute', taskId: current.id, revision: current.revision }), { status: 409 });
  await assert.rejects(f.approve(), { status: 409 });
  await assert.rejects(access(f.effect), { code: 'ENOENT' });
});

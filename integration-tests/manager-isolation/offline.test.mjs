import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStore } from '../../manager/task-store.ts';

// Dynamic imports make the initial RED an assertion about the missing fixture,
// rather than an unhandled module-loader error. No Docker or subprocesses here.
async function subject(name) {
  const module = await import(`./${name}.mjs`).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
  assert.ok(module, `${name} fixture utilities must exist`);
  return module;
}
const image = `sha256:${'a'.repeat(64)}`;
const request = { key: 'one', requester: 'agent', target: 'control', action: 'marker', payload: {} };

test('default/invalid runner invocations cannot touch Docker, even when its invoker is available', async () => {
  const { main } = await subject('run');
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Docker must not be reached'); };
  await main([], forbidden);
  await assert.rejects(main(['--image', image], forbidden));
  await assert.rejects(main(['--allow-temporary-docker', '--image', 'node:24'], forbidden));
  assert.equal(calls, 0);
});

test('emitted container logging options avoid local-driver compression with a single file', async () => {
  const { main } = await subject('run');
  let createArgs;
  // Intercept only the external command boundary; run the actual argument builder
  // and error cleanup. No Docker command or container creation is performed.
  const intercept = (command, args) => {
    assert.equal(command, 'docker');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { status: 0, stdout: JSON.stringify({ id: image, volumes: null }) };
    }
    if (['container', 'volume'].includes(args[0]) && args[1] === 'ls') return { status: 0, stdout: '' };
    if (args[0] === 'container' && args[1] === 'create') {
      createArgs = args;
      return { status: 1, stderr: 'offline interception before container creation' };
    }
    throw new Error(`Unexpected offline command: ${args.join(' ')}`);
  };
  await assert.rejects(main(['--image', image, '--allow-temporary-docker'], intercept), /offline interception/);
  assert.ok(createArgs, 'Actual runner must emit its create command');
  assert.ok(createArgs.includes('--log-driver=local'));
  const options = Object.fromEntries(createArgs.filter(arg => arg.startsWith('--log-opt='))
    .map(arg => arg.slice('--log-opt='.length).split('=')));
  assert.equal(options['max-size'], '1m');
  assert.equal(options['max-file'], '1');
  assert.equal(options.compress, 'false', 'Single-file local logging must explicitly disable default compression');
});

test('Docker opt-in rejects incomplete, ambiguous and unsafe options before any access', async () => {
  const { parseArgs } = await subject('guards');
  assert.equal(parseArgs([]), null);
  for (const args of [ ['--image', image], ['--allow-temporary-docker'],
    ['--image', 'node:24', '--allow-temporary-docker'],
    ['--image', image, '--allow-temporary-docker', '--wat'],
    ['--image', image, '--image', image, '--allow-temporary-docker'],
    ['--image', image, '--allow-temporary-docker', '--unsafe-fixture-admin-access'] ]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(['--image', image, '--allow-temporary-docker']), { image, mutation: false });
  assert.equal(parseArgs(['--image', image, '--allow-temporary-docker',
    '--unsafe-fixture-admin-access', '--acknowledge-negative-control']).mutation, true);
});

test('ownership guard refuses wrong IDs, wrong run labels and unlabeled resources', async () => {
  const { assertOwned, LABEL } = await subject('guards');
  const id = 'b'.repeat(64), run = 'a'.repeat(32);
  const item = { Id: id, Config: { Labels: { [LABEL]: run } } };
  assert.doesNotThrow(() => assertOwned('container', id, item, run));
  for (const altered of [{ ...item, Id: 'c'.repeat(64) }, { Id: id, Config: {} },
    { ...item, Config: { Labels: { [LABEL]: 'other' } } }]) {
    assert.throws(() => assertOwned('container', id, altered, run));
  }
  const name = `manager-isolation-${run}-private`;
  assert.doesNotThrow(() => assertOwned('volume', name, { Name: name, Labels: { [LABEL]: run } }, run));
  assert.throws(() => assertOwned('volume', 'existing', { Name: 'existing', Labels: { [LABEL]: run } }, run));
});

test('spawn errors, timeout signals and output overflow cannot masquerade as status-zero success', async () => {
  const { checkedResult } = await subject('guards');
  assert.equal(checkedResult({ status: 0, stdout: 'ok', stderr: '' }), 'ok');
  for (const result of [ { status: 0, error: new Error('EPERM') },
    { status: null, signal: 'SIGTERM' }, { status: 1, stderr: 'failed' },
    { status: 0, stdout: 'x'.repeat(262145) } ]) assert.throws(() => checkedResult(result));
});

test('role specifications keep UIDs, private mounts and capability domains separate', async () => {
  const guards = await subject('guards');
  assert.equal(typeof guards.roleSpec, 'function', 'role boundary builder must exist');
  const { roleSpec } = guards;
  const executor = roleSpec('executor'), entry = roleSpec('entry');
  const agent = roleSpec('agent'), frontend = roleSpec('frontend'), admin = roleSpec('admin');
  assert.equal(new Set([executor.uid, entry.uid, agent.uid, frontend.uid, admin.uid]).size, 5);
  for (const role of [executor, entry, agent, frontend, admin]) assert.ok(role.uid > 0);
  assert.deepEqual(agent.volumes, ['public', 'agent-work']);
  assert.deepEqual(frontend.volumes, ['public', 'frontend-work']);
  assert.deepEqual(entry.volumes, ['public', 'exec']);
  assert.deepEqual(admin.volumes, ['admin']);
  assert.deepEqual(executor.volumes, ['private', 'control', 'exec', 'admin']);
  for (const role of [agent, frontend]) {
    assert.ok(!role.groups.includes(admin.uid));
    assert.ok(!role.groups.includes(entry.uid));
  }
  assert.throws(() => roleSpec('production'));
  const mutated = roleSpec('agent', true);
  assert.ok(mutated.volumes.includes('admin'));
  assert.ok(mutated.groups.includes(admin.uid));
  assert.deepEqual(roleSpec('frontend', true), frontend);
  assert.deepEqual(roleSpec('entry', true), entry);
});

test('actual entry-server access plan requires exec/read positive controls, not a fake workspace', async () => {
  const { boundaryPlan } = await subject('access');
  const entry = boundaryPlan(21002);
  assert.equal(entry.workspace, false);
  assert.deepEqual(entry.allowedSockets, ['/exec/executor.sock']);
  assert.ok(entry.readableFiles.includes('/fixture/role.mjs'));
  assert.ok(entry.deniedSockets.includes('/admin/approval.sock'));
  assert.ok(entry.deniedSockets.includes('/var/run/docker.sock'));
  assert.ok(entry.deniedSockets.includes('/run/docker.sock'));
  assert.ok(!entry.deniedSockets.includes('/exec/executor.sock'));
  assert.deepEqual(entry.privateFiles, ['/private/store/tasks.json', '/private/policy.json', '/private/admin-secret']);
  assert.deepEqual(entry.immutableCode, ['/executor/executor.mjs', '/fixture/role.mjs']);
  for (const uid of [21003, 21004]) {
    const client = boundaryPlan(uid);
    assert.equal(client.workspace, true);
    assert.deepEqual(client.allowedSockets, []);
    assert.ok(client.deniedSockets.includes('/exec/executor.sock'));
    assert.ok(client.deniedSockets.includes('/admin/approval.sock'));
  }
  assert.throws(() => boundaryPlan(0));
  assert.throws(() => boundaryPlan(21001));
});

test('direct executor channel independently rejects approval and invalid dispatch before exact approved execution', async () => {
  const { routeExecutor, ProbeExecutor, approvalFor } = await subject('protocol');
  assert.equal(typeof routeExecutor, 'function', 'Executor socket needs its own authoritative handler');
  const root = await mkdtemp(path.join(tmpdir(), 'manager-isolation-direct-'));
  let store, executor;
  try {
    store = await TaskStore.open(path.join(root, 'store'));
    const marker = path.join(root, 'marker');
    executor = new ProbeExecutor(store, marker, 0);
    // Direct executor requests deliberately never call routeEntry.
    const direct = (op, body) => routeExecutor({ op, body }, executor);
    const task = await direct('submit', request);
    assert.equal((await direct('query', { taskId: task.id })).state, 'pending_approval');
    await assert.rejects(direct('approve', approvalFor(task)), /Execution channel cannot approve/);
    await assert.rejects(direct('dispatch', { taskId: task.id, revision: 1 }), /Unapproved or stale/);
    assert.equal((await store.get(task.id)).state, 'pending_approval');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const queued = await executor.approve(approvalFor(task));
    for (const ref of [{ taskId: task.id, revision: 1 },
      { taskId: task.id, revision: queued.revision, payload: {} },
      { taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: queued.revision }]) {
      await assert.rejects(direct('dispatch', ref));
    }
    await assert.rejects(routeExecutor({ op: 'query', body: { taskId: task.id }, extra: true }, executor));
    await assert.rejects(direct('query', { taskId: task.id, extra: true }));
    assert.equal((await store.get(task.id)).state, 'queued');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal((await direct('dispatch', { taskId: task.id, revision: queued.revision })).state, 'running');
    await executor.idle();
    assert.equal(await readFile(marker, 'utf8'), 'marker\n');
  } finally {
    if (executor) await executor.idle();
    if (store) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('entry routing cannot forward self-approval or mutable dispatch payloads', async () => {
  const protocol = await subject('protocol');
  assert.equal(typeof protocol.routeEntry, 'function', 'restricted entry router must exist');
  const { routeEntry } = protocol;
  let calls = 0;
  const downstream = async message => { calls++; return message; };
  for (const message of [{ op: 'approve', body: {} }, { op: 'marker', body: {} },
    { op: 'dispatch', body: { taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1, payload: {} } },
    { op: 'query', body: { taskId: 'x', extra: true } }, { op: 'query', body: {}, extra: true }]) {
    await assert.rejects(routeEntry(message, downstream));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await routeEntry({ op: 'submit', body: request }, downstream), { op: 'submit', body: request });
  assert.equal(calls, 1);
});

test('policy binds the exact immutable request, policy digest, task and revision', async () => {
  const { approvalFor, verifyApproval, frozenRef, validateRequest, POLICY } = await subject('protocol');
  const task = { ...request, id: 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12), revision: 1, state: 'pending_approval' };
  const approval = approvalFor(task);
  assert.doesNotThrow(() => verifyApproval(task, approval));
  for (const changed of [{ ...task, payload: { command: 'bad' } }, { ...task, key: 'other' },
    { ...task, requester: 'frontend' }, { ...task, revision: 2 }, { ...task, id: 'wrong' }]) {
    assert.throws(() => verifyApproval(changed, approval));
  }
  assert.throws(() => verifyApproval(task, approval, { ...POLICY, version: 2 }));
  assert.throws(() => verifyApproval(task, { ...approval, command: 'bad' }));
  const ref = frozenRef({ taskId: task.id, revision: 1 });
  assert.equal(Object.isFrozen(ref), true);
  for (const altered of [{ ...ref, payload: {} }, { ...ref, revision: 0 }, { taskId: '../../x', revision: 1 }]) {
    assert.throws(() => frozenRef(altered));
  }
  assert.doesNotThrow(() => validateRequest(request));
  for (const altered of [{ ...request, action: 'shell' }, { ...request, target: '/tmp' },
    { ...request, payload: { path: '/private/x' } }, { ...request, extra: true }]) {
    assert.throws(() => validateRequest(altered));
  }
});

test('real TaskStore: no unapproved/stale/extra dispatch, exact approval once, reopen no replay', async () => {
  const { ProbeExecutor, approvalFor } = await subject('protocol');
  const root = await mkdtemp(path.join(tmpdir(), 'manager-isolation-offline-'));
  let store;
  try {
    store = await TaskStore.open(path.join(root, 'store'));
    const marker = path.join(root, 'marker');
    let executor = new ProbeExecutor(store, marker, 0);
    const task = await executor.submit(request);
    const pending = { taskId: task.id, revision: task.revision };
    await assert.rejects(executor.dispatch(pending));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(executor.approve({ ...approvalFor(task), requestHash: 'wrong' }));
    const queued = await executor.approve(approvalFor(task));
    await assert.rejects(executor.approve(approvalFor(task)));
    await assert.rejects(executor.dispatch(pending));
    await assert.rejects(executor.dispatch({ taskId: task.id, revision: queued.revision, payload: {} }));
    await assert.rejects(executor.dispatch({ taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: queued.revision }));
    const ref = { taskId: task.id, revision: queued.revision };
    const results = await Promise.allSettled([executor.dispatch(ref), executor.dispatch(ref)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await executor.idle();
    assert.equal((await store.get(task.id)).state, 'succeeded');
    assert.equal(await readFile(marker, 'utf8'), 'marker\n');
    await store.close();
    store = await TaskStore.open(path.join(root, 'store'));
    executor = new ProbeExecutor(store, marker, 0);
    assert.equal((await store.get(task.id)).state, 'succeeded');
    await assert.rejects(executor.dispatch(ref));
    assert.equal(await readFile(marker, 'utf8'), 'marker\n');
  } finally {
    if (store) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

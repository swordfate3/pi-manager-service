// Opt-in HOST controller for this temporary experiment. Never shipped as a backend.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LABEL, MAX_OUTPUT, assertOwned, checkedResult, parseArgs, roleSpec } from './guards.mjs';
import { approvalFor } from './protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanEnv = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin'];
const node = '/usr/local/bin/node';
const volumeKinds = ['private', 'control', 'exec', 'admin', 'public', 'frontend-work', 'agent-work'];
const inspectFormat = '{"Id":{{json .Id}},"Config":{"Labels":{{json .Config.Labels}},"User":{{json .Config.User}}},"State":{{json .State}}}';

export async function main(args, invoke = spawnSync) {
  const options = parseArgs(args);
  if (!options) {
    console.log('NOT RUN: opt in with node integration-tests/manager-isolation/run.mjs --image <full local sha256 ID> --allow-temporary-docker');
    return;
  }
  const run = randomBytes(16).toString('hex');
  const prefix = `manager-isolation-${run}`;
  const containers = [], volumes = [];
  let staging, baseline, interrupted = false, cleanup = false;
  let deadline = Date.now() + 120_000;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const docker = (...argv) => {
    if ((!cleanup && interrupted) || Date.now() >= deadline) throw new Error('Probe interrupted or time budget exhausted');
    return checkedResult(invoke('docker', argv, {
      encoding: 'utf8', timeout: Math.min(15_000, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT,
      // Do not pass host credentials, proxy variables, Node options or Docker contexts.
      env: { PATH: process.env.PATH },
    }));
  };
  const emit = (label, data = {}) => console.log(JSON.stringify({ label, ...data }));
  const inspect = id => JSON.parse(docker('container', 'inspect', '--format', inspectFormat, id));
  const owned = item => { const info = inspect(item.id); assertOwned('container', item.id, info, run); return info; };
  const journal = async () => {
    if (staging) await writeFile(path.join(staging, 'ownership.json'), JSON.stringify({ run, containers, volumes }, null, 2), { mode: 0o600 });
  };
  const matchingContainers = name => docker('container', 'ls', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}').split('\n').filter(Boolean);
  const snapshot = () => {
    const ids = docker('container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}').split('\n').filter(Boolean);
    if (!ids.length) return [];
    // Only identities/start times: never inspect existing container environments.
    return docker('container', 'inspect', '--format', '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}}}', ...ids)
      .split('\n').map(line => JSON.parse(line)).sort((a, b) => a.id.localeCompare(b.id));
  };
  const mount = (source, target, readonly = false, type = 'volume') => [
    '--mount', `type=${type},src=${source},dst=${target}${readonly ? ',readonly' : ''}${type === 'volume' ? ',volume-nocopy' : ''}`,
  ];
  const start = async (role, suffix = role, command) => {
    const init = role === 'init', preflight = role === 'preflight';
    const spec = init ? { uid: 0, groups: [], volumes: volumeKinds }
      : preflight ? { uid: 21003, groups: [], volumes: [] } : roleSpec(role, options.mutation);
    const name = `${prefix}-${suffix}`;
    assert.deepEqual(matchingContainers(name), [], 'Random container name already exists');
    const item = { name, id: null, role };
    containers.push(item); await journal(); // Includes an uncertain create in failure cleanup.
    const argv = ['container', 'create', '--name', name, '--label', `${LABEL}=${run}`,
      '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--pids-limit=64', '--memory=128m', '--cpus=0.5', '--log-driver=local', '--log-opt=max-size=1m',
      '--log-opt=max-file=1', '--log-opt=compress=false', '--restart=no', '--no-healthcheck', '--stop-timeout=10',
      '--user', `${spec.uid}:${spec.uid}`, '--entrypoint=/usr/bin/env', '--workdir=/fixture'];
    for (const group of spec.groups) argv.push('--group-add', String(group));
    if (init) for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) argv.push('--cap-add', cap);
    if (!preflight) argv.push(...mount(path.join(staging, 'fixture'), '/fixture', true, 'bind'));
    if (role === 'executor') argv.push(...mount(path.join(staging, 'executor'), '/executor', true, 'bind'));
    for (const kind of spec.volumes) {
      const volume = volumes.find(volume => volume.kind === kind);
      assertOwned('volume', volume.id, JSON.parse(docker('volume', 'inspect', '--format', '{{json .}}', volume.id)), run);
      const target = init ? `/init/${kind}` : kind.endsWith('-work') ? '/workspace' : `/${kind}`;
      const readonly = !init && ((kind === 'public' && role !== 'entry') ||
        (kind === 'exec' && role !== 'executor') || (kind === 'admin' && role !== 'executor'));
      argv.push(...mount(volume.id, target, readonly));
    }
    argv.push(options.image, ...cleanEnv, node, ...(command ?? (role === 'executor'
      ? ['/executor/executor.mjs'] : ['/fixture/role.mjs', init ? 'init' : role === 'entry' ? 'entry' : 'hold'])));
    item.id = docker(...argv);
    owned(item); await journal();
    emit('created', { role, id: item.id, run });
    docker('container', 'start', item.id);
    return item;
  };
  const completed = item => {
    owned(item);
    const code = docker('container', 'wait', item.id);
    assert.equal(code, '0', `${item.role} failed: ${docker('container', 'logs', '--tail', '20', item.id)}`);
  };
  const ready = async item => {
    for (let i = 0; i < 30; i++) {
      const info = owned(item);
      const logs = docker('container', 'logs', '--tail', '20', item.id);
      if (info.State.Running && logs.includes('READY ')) return;
      if (!info.State.Running) throw new Error(`${item.role} exited before readiness: ${logs}`);
      await delay(100);
    }
    throw new Error(`${item.role} readiness timeout`);
  };
  const stop = item => {
    owned(item);
    docker('container', 'stop', '--time', item.role === 'executor' ? '10' : '1', item.id);
    assert.equal(owned(item).State.ExitCode, 0, `${item.role} did not stop cleanly`);
  };
  const client = (item, mode, ...args) => {
    owned(item);
    return JSON.parse(docker('container', 'exec', item.id, '/usr/bin/env', ...cleanEnv, node, '/fixture/role.mjs', mode, ...args));
  };
  const call = (item, op, body) => client(item, 'rpc', item.role === 'admin' ? '/admin/approval.sock'
    : item.role === 'entry' ? '/exec/executor.sock' : '/public/entry.sock', JSON.stringify({ op, body }));
  const ok = (result, label) => { assert.equal(result.ok, true, `${label}: ${result.error}`); emit(`PASS ${label}`); return result.value; };
  const denied = (result, label, expected) => {
    assert.equal(result.ok, false, label); assert.equal(typeof result.error, 'string');
    if (expected) assert.match(result.error, expected);
    emit(`PASS ${label}`);
  };
  let failure;
  try {
    emit('run', { run, image: options.image, mutation: options.mutation });
    baseline = snapshot();
    // Missing Config.Volumes is supported; nonempty volumes would create unintended mounts.
    const imageInfo = JSON.parse(docker('image', 'inspect', '--format',
      '{"id":{{json .Id}},"volumes":{{json (index .Config "Volumes")}}}', options.image));
    assert.equal(imageInfo.id, options.image, 'Pinned local image does not match');
    assert.equal(Object.keys(imageInfo.volumes ?? {}).length, 0, 'Image declares implicit volumes');
    staging = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
    await chmod(staging, 0o755);
    await journal(); emit('journal', { path: path.join(staging, 'ownership.json') });
    const preflight = await start('preflight', 'preflight', ['--input-type=module', '-e',
      'if(process.versions.node.split(".")[0]!=="24"||process.getuid()!==21003||Object.keys(process.env).some(k=>k!=="PATH"))throw Error("Unsupported image/environment");console.log(process.version)']);
    completed(preflight);
    emit('PASS pinned Node 24 and clean image environment');
    for (const directory of ['fixture', 'executor']) await mkdir(path.join(staging, directory), { mode: 0o755 });
    const copies = [
      ...['role.mjs', 'rpc.mjs', 'protocol.mjs', 'access.mjs'].map(name => [path.join(here, name), 'fixture', name]),
      [path.join(here, 'executor.mjs'), 'executor', 'executor.mjs'],
      ...['task-store.ts', 'contracts.ts'].map(name => [path.resolve(here, '../../manager', name), 'executor', name]),
    ];
    for (const [source, directory, name] of copies) {
      const target = path.join(staging, directory, name);
      await copyFile(source, target); await chmod(target, 0o644);
    }
    for (const kind of volumeKinds) {
      const id = `${prefix}-${kind}`;
      assert.equal(docker('volume', 'ls', '--filter', `name=^${id}$`, '--format', '{{.Name}}'), '', 'Random volume already exists');
      volumes.push({ id, kind }); await journal();
      assert.equal(docker('volume', 'create', '--label', `${LABEL}=${run}`, id), id);
      assertOwned('volume', id, JSON.parse(docker('volume', 'inspect', '--format', '{{json .}}', id)), run);
    }
    const init = await start('init'); completed(init);
    let executor = await start('executor'); await ready(executor);
    const entry = await start('entry'); await ready(entry);
    const agent = await start('agent'); await ready(agent);
    const frontend = await start('frontend'); await ready(frontend);
    const admin = await start('admin'); await ready(admin);
    // Establish channel and file existence through healthy owners BEFORE testing denial.
    ok(call(admin, 'evidence', {}), 'admin socket reachable');
    for (const actor of [entry, agent, frontend]) emit(`PASS ${actor.role} filesystem/socket boundaries`, { checks: client(actor, 'boundaries') });
    const request = { key: 'agent-one', requester: 'agent', action: 'marker', target: 'control', payload: {} };
    const task = ok(call(agent, 'submit', request), 'Agent submit');
    assert.equal(ok(call(agent, 'query', { taskId: task.id }), 'Agent query').state, 'pending_approval');
    assert.equal(ok(call(entry, 'query', { taskId: task.id }), 'actual entry direct executor query').state, 'pending_approval');
    denied(call(entry, 'approve', approvalFor(task)), 'actual entry cannot approve over exec socket', /Execution channel cannot approve/);
    denied(call(entry, 'dispatch', { taskId: task.id, revision: task.revision }),
      'actual entry direct unapproved dispatch rejected', /Unapproved or stale reference/);
    const other = ok(call(frontend, 'submit', { ...request, key: 'frontend-one', requester: 'frontend' }), 'frontend submit');
    assert.equal(ok(call(frontend, 'query', { taskId: other.id }), 'frontend query').state, 'pending_approval');
    for (const actor of [agent, frontend]) {
      denied(call(actor, 'approve', approvalFor(task)), `${actor.role} cannot self-approve`);
      denied(call(actor, 'dispatch', { taskId: task.id, revision: task.revision }), `${actor.role} cannot bypass approval`);
    }
    for (const change of [{ revision: task.revision + 1 }, { requestHash: 'wrong' }, { policyHash: 'wrong' }]) {
      denied(call(admin, 'approve', { ...approvalFor(task), ...change }), 'administrator approval binding rejects mismatch');
    }
    assert.equal(ok(call(admin, 'evidence', {}), 'no unapproved marker').marker, '');
    const queued = ok(call(admin, 'approve', approvalFor(task)), 'independent administrator exact approval');
    const ref = { taskId: task.id, revision: queued.revision };
    for (const body of [{ ...ref, revision: task.revision }, { ...ref, payload: { command: 'bad' } },
      { ...ref, taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]) {
      denied(call(frontend, 'dispatch', body), 'stale/extra/wrong dispatch reference rejected');
      denied(call(entry, 'dispatch', body), 'actual entry direct stale/extra/wrong dispatch rejected', /Unapproved or stale reference|Invalid or extra fields/);
    }
    assert.equal(ok(call(entry, 'query', { taskId: task.id }), 'direct rejected requests preserve queued task').state, 'queued');
    assert.equal(ok(call(admin, 'evidence', {}), 'no marker after direct entry bypass attempts').marker, '');
    const executorStarted = owned(executor).State.StartedAt;
    assert.equal(ok(call(agent, 'dispatch', ref), 'approved dispatch accepted').state, 'running');
    denied(call(frontend, 'dispatch', ref), 'duplicate dispatch rejected');
    stop(entry); stop(agent);
    const survived = owned(executor);
    assert.equal(survived.State.Running, true); assert.equal(survived.State.StartedAt, executorStarted);
    assert.equal(ok(call(admin, 'query', { taskId: other.id }), 'pending task survives disconnect').state, 'pending_approval');
    let terminal;
    for (let i = 0; i < 40; i++) {
      const result = call(admin, 'query', { taskId: task.id });
      assert.equal(result.ok, true, result.error);
      terminal = result.value;
      if (terminal.state === 'succeeded') break;
      assert.equal(terminal.state, 'running');
      await delay(200);
    }
    assert.equal(terminal.state, 'succeeded', 'Disconnected action did not finish');
    assert.equal(ok(call(admin, 'evidence', {}), 'single marker after disconnect').marker, 'marker\n');
    stop(executor);
    executor = await start('executor', 'executor-reopened'); await ready(executor);
    const reopenedEntry = await start('entry', 'entry-reopened'); await ready(reopenedEntry);
    assert.deepEqual(ok(call(frontend, 'query', { taskId: task.id }), 'reopen exact persisted terminal task'), terminal);
    denied(call(frontend, 'dispatch', ref), 'terminal dispatch cannot replay after reopen');
    denied(call(admin, 'approve', approvalFor(terminal)), 'terminal task cannot be approved again');
    assert.equal(ok(call(admin, 'evidence', {}), 'no marker replay after reopen').marker, 'marker\n');
    stop(executor);
    if (options.mutation) throw new Error('Negative control unexpectedly survived boundary assertions');
  } catch (error) {
    failure = error; emit('FAIL', { error: error.message });
  } finally {
    cleanup = true; deadline = Date.now() + 60_000;
    const cleanupErrors = [];
    // Exact candidates only. Re-inspect labels immediately before each stop/remove.
    for (const item of [...containers].reverse()) {
      try {
        if (!item.id) {
          const ids = matchingContainers(item.name);
          assert.ok(ids.length <= 1, 'Ambiguous container creation');
          item.id = ids[0];
        }
        if (!item.id) continue;
        if (owned(item).State.Running) { docker('container', 'stop', '--time', '10', item.id); owned(item); }
        docker('container', 'rm', item.id);
        assert.deepEqual(matchingContainers(item.name), [], 'Removed container remains');
      } catch (error) { cleanupErrors.push({ resource: item.id ?? item.name, error: error.message }); }
    }
    for (const item of [...volumes].reverse()) {
      try {
        const exists = docker('volume', 'ls', '--filter', `name=^${item.id}$`, '--format', '{{.Name}}');
        if (!exists) continue;
        assert.equal(exists, item.id);
        assertOwned('volume', item.id, JSON.parse(docker('volume', 'inspect', '--format', '{{json .}}', item.id)), run);
        docker('volume', 'rm', item.id);
        assert.equal(docker('volume', 'ls', '--filter', `name=^${item.id}$`, '--format', '{{.Name}}'), '');
      } catch (error) { cleanupErrors.push({ resource: item.id, error: error.message }); }
    }
    try {
      assert.equal(docker('container', 'ls', '-a', '--filter', `label=${LABEL}=${run}`, '--format', '{{.ID}}'), '', 'Run container residue');
      assert.equal(docker('volume', 'ls', '--filter', `label=${LABEL}=${run}`, '--format', '{{.Name}}'), '', 'Run volume residue');
      if (baseline) {
        const after = snapshot();
        emit('existing container comparison', { before: baseline, after });
        assert.deepEqual(after, baseline, 'Existing container identities/start times changed; cause is not inferred');
      }
    } catch (error) { cleanupErrors.push({ resource: 'postflight', error: error.message }); }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    if (cleanupErrors.length) {
      await journal();
      emit('CLEANUP INCOMPLETE; preserve journal and inspect exact IDs/labels before removal', { run, staging, cleanupErrors });
      failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors.map(item => new Error(`${item.resource}: ${item.error}`))], 'Probe/cleanup failed');
    } else {
      if (staging) await rm(staging, { recursive: true });
      emit('PASS cleanup; only this run resources and staged copies removed');
    }
  }
  if (failure) throw failure;
  emit('PASS temporary container isolation probe (not a production executor)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.stack);
    if (error instanceof AggregateError) for (const cause of error.errors) console.error(cause.message);
    process.exitCode = 1;
  });
}

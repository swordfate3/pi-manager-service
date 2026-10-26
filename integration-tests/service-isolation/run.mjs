#!/usr/bin/env node
// Actual packaged public/admin/executor/chat entries. No replacement service or approval engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyManifest } from '../../scripts/manager-dist.mjs';
import { IMAGE, SOCKET, LABEL, MAX_OUTPUT, parseArgs, assertRoleOwned, assertBackendOwned, assertTemporaryRoot, checkedResult } from './guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), project = path.resolve(here, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const NODE = '/usr/local/bin/node', ENV = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin'];

async function freePort() {
  const s = createServer(); await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const port = s.address().port; await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); return port;
}

async function main(args) {
  const options = parseArgs(args);
  // Stale build is an explicit failure, never an isolation finding or a reason to rebuild here.
  const manifest = await verifyManifest(project);
  const run = randomBytes(16).toString('hex');
  const root = mkdtempSync(`/tmp/msi-${run}-`); assertTemporaryRoot(root, run);
  chmodSync(root, 0o755); writeFileSync(path.join(root, 'run-owner'), run, { mode: 0o444 });
  const hostUid = process.getuid(), hostGid = process.getgid();
  const roles = [], checks = [], removed = [], cleanupErrors = [];
  let baseline = [], backendRecords = [], failed;
  const evidence = { run, root, image: IMAGE, daemonId: options.daemonId, checks, removed, cleanupErrors,
    artifact: { sourceSha256: manifest.source.sha256, outputsSha256: manifest.outputs.sha256,
      manifestSha256: hash(readFileSync(path.join(project, 'dist/build-manifest.json'))),
      gitHead: checkedResult(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_OUTPUT })), files: {} } };
  let deadline = Date.now() + 240_000;
  const journal = () => writeJson(path.join(root, 'ownership.json'), { run, root, roles, backendRecords, removed, cleanupErrors });
  const emit = (label, details) => { checks.push({ label, ...(details === undefined ? {} : { details }) }); console.log(`PASS ${label}`); writeJson(path.join(root, 'evidence.json'), evidence); };
  const docker = (args, input) => {
    assert.ok(Date.now() < deadline, 'Acceptance/cleanup deadline exceeded');
    return checkedResult(spawnSync('docker', ['--host', `unix://${SOCKET}`, ...args], { encoding: 'utf8', input,
      timeout: Math.min(25_000, deadline - Date.now()), maxBuffer: MAX_OUTPUT,
      env: { PATH: '/usr/bin:/bin', DOCKER_CONFIG: path.join(root, 'docker-cli') } }));
  };
  const inspect = id => JSON.parse(docker(['container', 'inspect', '--format', '{{json .}}', id]));
  const snapshot = () => {
    const ids = docker(['container', 'ls', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort();
    // Never inspect preexisting credentials/config/mounts/logs, only these lifecycle fields.
    return ids.map(id => JSON.parse(docker(['container', 'inspect', '--format',
      '{"Id":{{json .Id}},"StartedAt":{{json .State.StartedAt}},"Running":{{json .State.Running}},"RestartCount":{{json .RestartCount}}}', id])));
  };
  const owned = item => { const info = inspect(item.id); assertRoleOwned(item, info, run, baseline.map(x => x.Id)); return info; };
  const exactExists = (kind, name) => docker(kind === 'container'
    ? ['container', 'ls', '-aq', '--no-trunc', '--filter', `name=^/${name}$`]
    : ['volume', 'ls', '-q', '--filter', `name=^${name}$`]).split('\n').filter(Boolean);
  const mount = (source, readonly = false, target = source) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
  const dirs = names => names.map(name => path.join(root, name));
  const start = (role, uid, { groups = [], mounts = [], hostNetwork = false, helper = false, command } = {}) => {
    const name = `msi-${run}-${role}`;
    assert.deepEqual(exactExists('container', name), [], 'Random role name already exists');
    const item = { name, role, id: null }; roles.push(item); journal();
    const args = ['container', 'create', '--name', name, '--label', `${LABEL}=${run}`, '--pull=never',
      '--network', hostNetwork ? 'host' : 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--pids-limit=96', '--memory=384m', '--memory-swap=384m', '--cpus=0.5', '--log-driver=local',
      '--log-opt=max-size=1m', '--log-opt=max-file=1', '--log-opt=compress=false', '--restart=no', '--no-healthcheck', '--stop-timeout=10',
      '--user', `${uid}:${uid}`, '--entrypoint=/usr/bin/env', '--workdir', path.join(root, 'code')];
    if (helper) {
      for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) args.push('--cap-add', cap);
      // Without membership (or CAP_FSETID), chmod silently clears a foreign group's setgid bit.
      for (const group of [22002, 22003]) args.push('--group-add', String(group));
      args.push(...mount(root));
    } else args.push(...mount(path.join(root, 'code'), true));
    for (const group of groups) args.push('--group-add', String(group));
    for (const m of mounts) args.push(...mount(m.source, m.readonly ?? false));
    args.push(IMAGE, ...ENV, NODE, ...command);
    item.id = docker(args); owned(item); journal();
    docker(['container', 'start', item.id]); return item;
  };
  const completed = item => {
    owned(item); assert.equal(docker(['container', 'wait', item.id]), '0', `${item.role}: ${docker(['container', 'logs', '--tail', '10', item.id])}`);
  };
  const ready = async item => {
    for (let i = 0; i < 80; i++) {
      const info = owned(item), logs = docker(['container', 'logs', '--tail', '20', item.id]);
      if (info.State.Running && logs.split('\n').some(line => { try { return JSON.parse(line).ready === true; } catch { return false; } })) return;
      assert.equal(info.State.Running, true, `${item.role} failed startup: ${logs}`); await delay(100);
    }
    throw new Error(`${item.role} readiness deadline`);
  };
  const probe = (item, mode, data) => {
    owned(item);
    return JSON.parse(docker(['container', 'exec', '-i', item.id, '/usr/bin/env', ...ENV, NODE,
      path.join(root, 'code/probe.mjs'), mode], JSON.stringify(data)));
  };
  let publicRole, adminRole, executor, agent, adminSession, publicOrigin, adminOrigin;
  const http = (item, origin, route, credential, body, extra = {}) => probe(item, 'http', {
    url: origin + route, credential, ...(body === undefined ? {} : { method: 'POST', body }),
    headers: { Origin: origin, ...extra },
  });
  const status = (response, expected) => { assert.equal(response.status, expected, JSON.stringify(response.body)); return response.body; };
  const taskDone = async (id, token) => {
    for (let i = 0; i < 60; i++) {
      const task = status(http(publicRole, publicOrigin, `/api/manager/tasks/${id}`, token), 200);
      if (task.state === 'succeeded') return task;
      assert.ok(['running', 'queued'].includes(task.state), `Unexpected task state: ${task.state}`); await delay(100);
    }
    throw new Error('Task completion deadline');
  };
  const approve = async (task, token) => {
    const review = status(http(adminRole, adminOrigin, `/api/manager/tasks/${task.id}/review`, adminSession), 200);
    status(http(adminRole, adminOrigin, '/api/manager/approve', adminSession, review.binding), 200);
    return taskDone(task.id, token);
  };

  console.log(`EVIDENCE ${path.join(root, 'evidence.json')}`);
  try {
    baseline = snapshot(); evidence.before = baseline; writeJson(path.join(root, 'before.json'), baseline);
    assert.equal(docker(['info', '--format', '{{.ID}}']), options.daemonId);
    const imageInfo = JSON.parse(docker(['image', 'inspect', '--format', '{"id":{{json .Id}},"volumes":{{json (index .Config "Volumes")}}}', IMAGE]));
    assert.equal(imageInfo.id, IMAGE); assert.equal(Object.keys(imageInfo.volumes ?? {}).length, 0);
    const socketInfo = statSync(SOCKET); assert.ok(socketInfo.isSocket());
    const socketGid = socketInfo.gid;
    mkdirSync(path.join(root, 'code/dist/manager'), { recursive: true, mode: 0o755 });
    for (const role of ['public', 'admin', 'executor', 'chat']) {
      const key = `dist/manager/pi-manager-${role}.mjs`, output = path.join(root, 'code', key);
      copyFileSync(path.join(project, key), output); chmodSync(output, 0o444);
      const digest = hash(readFileSync(output));
      assert.equal(manifest.outputs.files.find(f => f.path === key.slice(5))?.sha256, digest);
      evidence.artifact.files[key] = digest;
    }
    assert.ok(json(path.join(project, 'package.json')).dependencies.ws, 'ws must be declared');
    cpSync(path.join(project, 'node_modules/ws'), path.join(root, 'code/node_modules/ws'), { recursive: true, dereference: false, errorOnExist: true });
    const inventory = directory => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name), st = lstatSync(file); assert.equal(st.isSymbolicLink(), false, 'ws must be a regular explicit copy');
        if (st.isDirectory()) inventory(file);
        else { assert.ok(st.isFile()); chmodSync(file, 0o444); evidence.artifact.files[path.relative(path.join(root, 'code'), file)] = hash(readFileSync(file)); }
      }
    };
    inventory(path.join(root, 'code/node_modules/ws'));
    evidence.artifact.wsVersion = json(path.join(root, 'code/node_modules/ws/package.json')).version;
    for (const name of ['probe.mjs', 'provision.mjs', 'guards.mjs']) { copyFileSync(path.join(here, name), path.join(root, 'code', name)); chmodSync(path.join(root, 'code', name), 0o444); }
    for (const name of ['executor', 'public', 'admin', 'chat']) mkdirSync(path.join(root, `${name}-config`), { mode: 0o700 });
    const ports = await Promise.all([freePort(), freePort(), freePort()]); assert.equal(new Set(ports).size, 3);
    publicOrigin = `http://127.0.0.1:${ports[0]}`; adminOrigin = `http://127.0.0.1:${ports[1]}`;
    const chatOrigin = `http://127.0.0.1:${ports[2]}`;
    const requester = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex'), administrator = randomBytes(32).toString('hex');
    const marker = `const fs=require('node:fs');if(process.getuid()!==1000||Object.keys(process.env).some(k=>!['PATH','HOME'].includes(k)))throw Error('bad child authority');const p='/home/node/service-isolation-marker';const old=fs.existsSync(p);if(old&&fs.readFileSync(p,'utf8')!==${JSON.stringify(run)})throw Error('foreign home');if(!old)fs.writeFileSync(p,${JSON.stringify(run)});fs.writeFileSync('/workspace/restored',old?'retained':'new');fs.writeFileSync('/workspace/started',${JSON.stringify(run)});setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));`;
    const config = { stateRoot: path.join(root, 'executor-state'), submitSocket: path.join(root, 'submit/rpc.sock'), adminSocket: path.join(root, 'admin-socket/rpc.sock'), socketMode: 0o660,
      principals: [{ id: 'requester', role: 'submitter', tokenHash: hash(requester) }, { id: 'other', role: 'submitter', tokenHash: hash(other) }, { id: 'operator', role: 'admin', tokenHash: hash(administrator) }],
      trustedLocalNative: false, native: null, workspaces: { project: { label: 'Disposable project', root: 'test', path: 'project' } },
      docker: { socketPath: SOCKET, daemonId: options.daemonId, image: IMAGE, pathCoordinates: 'host', stateRoot: path.join(root, 'docker-state'),
        workspaceRoots: { test: path.join(root, 'work') }, timeoutMs: 15000,
        entrypoint: ['/usr/bin/env'], command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/node', NODE, '-e', marker] } };
    writeJson(path.join(root, 'executor-config/config.json'), config);
    writeJson(path.join(root, 'public-config/config.json'), { socketPath: config.submitSocket, origin: publicOrigin, chatOrigin, port: ports[0] });
    writeJson(path.join(root, 'admin-config/config.json'), { socketPath: config.adminSocket, origin: adminOrigin, chatOrigin, port: ports[1] });
    writeFileSync(path.join(root, 'admin-config/credential'), administrator, { mode: 0o600 });
    writeJson(path.join(root, 'chat-config/config.json'), { port: ports[2], host: '127.0.0.1', stateDir: path.join(root, 'chat-state'), runtimeDir: path.join(root, 'chat-runtime') });
    const init = start('init', 0, { helper: true, command: [path.join(root, 'code/provision.mjs'), 'init', root, run] }); completed(init);
    emit('pinned local image, fresh actual bundles, explicit ws and same host path coordinates', evidence.artifact);
    const entry = role => [path.join(root, `code/dist/manager/pi-manager-${role}.mjs`), '--config', path.join(root, `${role}-config/config.json`)];
    const mounts = (names, readonly = false) => dirs(names).map(source => ({ source, readonly }));
    executor = start('executor', 21001, { groups: [22001, 22002, 22003, socketGid], mounts: [...mounts(['executor-config'], true),
      ...mounts(['executor-state', 'docker-state', 'submit', 'admin-socket']), ...mounts(['work'], true), { source: SOCKET }], command: entry('executor') }); await ready(executor);
    publicRole = start('public', 21002, { groups: [22002], hostNetwork: true, mounts: mounts(['public-config', 'submit'], true), command: entry('public') }); await ready(publicRole);
    adminRole = start('admin', 21003, { groups: [22003], hostNetwork: true, mounts: mounts(['admin-config', 'admin-socket'], true), command: entry('admin') }); await ready(adminRole);
    const chat = start('chat', 21005, { hostNetwork: true, mounts: [...mounts(['chat-config'], true), ...mounts(['chat-state', 'chat-runtime'])], command: entry('chat') }); await ready(chat);
    agent = start('agent', 21004, { groups: [22002], hostNetwork: true, mounts: [...mounts(['submit'], true), ...mounts(['agent-work'])], command: [path.join(root, 'code/probe.mjs'), 'hold'] }); await ready(agent);
    for (const item of [executor, publicRole, adminRole, chat, agent]) {
      const info = owned(item); assert.notEqual(info.Config.User.split(':')[0], '0'); assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.HostConfig.Privileged, false); assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
      assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true')); assert.ok(info.HostConfig.Memory > 0 && info.HostConfig.NanoCpus > 0 && info.HostConfig.PidsLimit > 0);
      if (item !== executor) assert.ok(!info.Mounts.some(m => [SOCKET, config.stateRoot, path.join(root, 'executor-config')].includes(m.Source)));
    }
    emit('four actual services plus Agent run in distinct nonroot bounded containers');
    const ownerEvidence = probe(executor, 'owner-evidence', { root });
    evidence.socketOwners = ownerEvidence;
    assert.deepEqual(ownerEvidence.submit, { uid: 21001, gid: 22002, mode: 0o660 });
    assert.deepEqual(ownerEvidence.admin, { uid: 21001, gid: 22003, mode: 0o660 });
    assert.equal(ownerEvidence.dockerSocket, true); emit('actual owner evidence and distinct 0660 submit/admin socket groups', ownerEvidence);
    const page = status(http(publicRole, publicOrigin, '/'), 200);
    assert.match(page, /Pi Manager/); assert.match(page, /zero Pi instances/); assert.match(page, /data-admin="false"/);
    assert.deepEqual(status(http(publicRole, publicOrigin, '/api/manager/resources', requester), 200), []);
    emit('actual public page is available with zero Pi instances');
    const create = { key: 'http-create', action: 'create', target: `child-${run}`, workspace: 'project' };
    const task = status(http(publicRole, publicOrigin, '/api/manager/tasks', requester, create), 202);
    assert.equal(task.state, 'pending_approval'); assert.equal(task.requester, 'requester');
    assert.equal(status(http(publicRole, publicOrigin, `/api/manager/tasks/${task.id}`, requester), 200).id, task.id);
    status(http(publicRole, publicOrigin, `/api/manager/tasks/${task.id}`, other), 404);
    assert.deepEqual(status(http(publicRole, publicOrigin, '/api/manager/tasks', other), 200), []);
    emit('HTTP submit/query is principal-bound and pending independent approval');
    const mcp = (credential, method, params) => status(http(agent, publicOrigin, '/mcp', credential,
      { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }, { Accept: 'application/json, text/event-stream' }), 200);
    const tools = mcp(requester, 'tools/list').result.tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['manager_get_task', 'manager_list_tasks', 'manager_submit_task']);
    const mcpTask = mcp(requester, 'tools/call', { name: 'manager_submit_task', arguments: create });
    assert.notEqual(mcpTask.result.isError, true); assert.equal(JSON.parse(mcpTask.result.content[0].text).id, task.id);
    assert.equal(JSON.parse(mcp(requester, 'tools/call', { name: 'manager_get_task', arguments: { taskId: task.id } }).result.content[0].text).id, task.id);
    assert.equal(mcp(other, 'tools/call', { name: 'manager_get_task', arguments: { taskId: task.id } }).result.isError, true);
    const deniedTool = mcp(requester, 'tools/call', { name: 'manager_approve_task', arguments: { taskId: task.id } });
    assert.ok(deniedTool.error || deniedTool.result?.isError);
    emit('actual MCP submit/query/idempotency, cross-principal denial and absent approval tool');
    for (const field of ['argv', 'mounts', 'executable', 'requester', 'role', 'approved']) {
      status(http(publicRole, publicOrigin, '/api/manager/tasks', requester, { ...create, [field]: field === 'approved' ? true : 'forged' }), 400);
    }
    status(http(publicRole, publicOrigin, '/api/manager/approve', requester, { taskId: task.id }), 403);
    status(http(publicRole, publicOrigin, '/api/manager/execute', requester, { taskId: task.id, revision: task.revision }), 403);
    emit('public cannot approve/execute or choose argv, mounts, executable or principal');
    for (const body of [{ op: 'approve', taskId: task.id, revision: task.revision, requestHash: 'f'.repeat(64), policyHash: 'f'.repeat(64) },
      { op: 'execute', taskId: task.id, revision: task.revision, approved: true, role: 'admin' },
      { op: 'review', taskId: task.id, role: 'admin' }]) {
      status(probe(publicRole, 'rpc', { socket: config.submitSocket, credential: requester, body }), 403);
    }
    assert.equal(status(http(publicRole, publicOrigin, `/api/manager/tasks/${task.id}`, requester), 200).state, 'pending_approval');
    assert.equal(Object.keys(probe(executor, 'journal', { root }).tasks).length, 0);
    emit('direct actual submit-socket forged approval/role bypass denied inside executor; no backend mutation');
    for (const [item, uid] of [[publicRole, 21002], [agent, 21004]]) {
      const result = probe(item, 'boundaries', { root, uid, credential: requester, ...(item === agent ? { workspace: path.join(root, 'agent-work') } : {}) });
      assert.equal(result.denied.length, 9); emit(`${item.role} actual filesystem/socket denials with positive controls`, result);
    }
    status(http(publicRole, adminOrigin, '/api/manager/login', undefined, { credential: requester }), 403);
    const login = probe(adminRole, 'login', { url: adminOrigin + '/api/manager/login', credentialFile: path.join(root, 'admin-config/credential') });
    adminSession = status(login, 200).sessionToken; assert.match(adminSession, /^[a-f0-9]{64}$/); assert.equal(login.headers['set-cookie'], undefined);
    status(http(adminRole, adminOrigin, '/api/manager/tasks', undefined, undefined, { Cookie: `session=${adminSession}` }), 401);
    const review = status(http(adminRole, adminOrigin, `/api/manager/tasks/${task.id}/review`, adminSession), 200);
    for (const change of [{ revision: review.binding.revision + 1 }, { requestHash: '0'.repeat(64) }, { policyHash: '0'.repeat(64) }]) {
      status(http(adminRole, adminOrigin, '/api/manager/approve', adminSession, { ...review.binding, ...change }), 409);
    }
    const self = status(http(adminRole, adminOrigin, '/api/manager/tasks', adminSession, { ...create, key: 'self', target: `self-${run}` }), 202);
    const selfReview = status(http(adminRole, adminOrigin, `/api/manager/tasks/${self.id}/review`, adminSession), 200);
    status(http(adminRole, adminOrigin, '/api/manager/approve', adminSession, selfReview.binding), 403);
    emit('private administrator bearer only, no ambient cookie, exact-binding and self-approval denial');
    await approve(task, requester);
    backendRecords = Object.values(probe(executor, 'journal', { root }).tasks); journal();
    assert.equal(backendRecords.length, 1); const record = backendRecords[0];
    let child = inspect(record.result.containerId); assertBackendOwned('container', child, record, run, baseline.map(x => x.Id));
    assert.equal(child.State.Running, true); assert.equal(child.Config.User, '1000:1000');
    assert.equal(child.HostConfig.NetworkMode, 'none'); assert.equal(child.HostConfig.ReadonlyRootfs, true);
    assert.equal(child.HostConfig.Privileged, false); assert.deepEqual(child.HostConfig.CapDrop, ['ALL']);
    assert.equal(child.Mounts.length, 2); assert.ok(!child.Mounts.some(m => m.Source === SOCKET));
    const childRead = file => docker(['container', 'exec', child.Id, '/usr/bin/env', ...ENV, NODE, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'))`]);
    for (let i = 0; i < 40; i++) {
      // Only successful reads count; command failures never turn into a skipped assertion.
      const readyMarker = docker(['container', 'exec', child.Id, '/usr/bin/env', ...ENV, NODE, '-e', "process.stdout.write(String(require('node:fs').existsSync('/workspace/started')))"]);
      if (readyMarker === 'true') break;
      assert.ok(i < 39, 'Child marker deadline'); await delay(100);
    }
    assert.equal(childRead('/workspace/started'), run); assert.equal(childRead('/workspace/restored'), 'new');
    evidence.backend = { containerId: child.Id, homeVolume: record.result.homeVolume, owner: record.requester, nonce: record.id };
    emit('exact private approval executes the actual Docker adapter and creates the marker child', evidence.backend);
    const stopped = status(http(publicRole, publicOrigin, '/api/manager/tasks', requester, { key: 'stop', action: 'stop', target: create.target }), 202);
    await approve(stopped, requester); assert.equal(inspect(child.Id).State.Running, false);
    const restarted = status(http(publicRole, publicOrigin, '/api/manager/tasks', requester, { key: 'start', action: 'start', target: create.target }), 202);
    await approve(restarted, requester); const after = inspect(child.Id);
    assert.equal(after.Id, child.Id); assert.equal(after.State.Running, true);
    for (let i = 0; i < 40 && childRead('/workspace/restored') !== 'retained'; i++) { assert.ok(i < 39, 'Restore marker deadline'); await delay(100); }
    assert.equal(childRead('/home/node/service-isolation-marker'), run); assert.equal(childRead('/workspace/restored'), 'retained');
    emit('approved stop/start restores the same exact container and retained home marker');
    const finalStop = status(http(publicRole, publicOrigin, '/api/manager/tasks', requester, { key: 'final-stop', action: 'stop', target: create.target }), 202);
    await approve(finalStop, requester); assert.equal(inspect(child.Id).State.Running, false);
    emit('final backend stop completed through private approval');
  } catch (error) { failed = error; evidence.failure = error.message; console.error(`FAIL ${error.message}`); }
  finally {
    deadline = Date.now() + 120_000;
    // Resolve only exact random create intents. Never broaden discovery or reclaim foreign resources.
    const resolve = item => {
      if (!item.id) { const ids = exactExists('container', item.name); assert.ok(ids.length <= 1, 'Ambiguous create'); item.id = ids[0] ?? null; journal(); }
      return item.id ? owned(item) : null;
    };
    for (const item of [...roles].reverse()) {
      try {
        const info = resolve(item); if (!info) continue;
        if (info.State.Running) { owned(item); docker(['container', 'stop', '--time', '10', item.id]); }
        assert.equal(owned(item).State.ExitCode, 0, `${item.role} unclean exit`);
      } catch (e) { cleanupErrors.push(`${item.role} stop: ${e.message}`); }
    }
    // A root helper touches only this run's temp mount, returns ownership, and retains all evidence.
    try {
      if (existsSync(path.join(root, 'code/provision.mjs'))) {
        const helper = start('collect', 0, { helper: true, command: [path.join(root, 'code/provision.mjs'), 'collect', root, run, String(hostUid), String(hostGid)] }); completed(helper);
      }
      const file = path.join(root, 'docker-state/tasks.json');
      if (existsSync(file)) backendRecords = Object.values(json(file).tasks);
      journal();
    } catch (e) { cleanupErrors.push(`collect evidence: ${e.message}`); }
    for (const record of backendRecords) {
      try {
        assert.equal(record.target, `child-${run}`); assert.match(record.id, /^[a-f0-9-]{36}$/);
        const name = `pi-manager-${record.id.replaceAll('-', '')}`;
        const ids = exactExists('container', name); assert.ok(ids.length <= 1, 'Ambiguous backend create');
        if (ids.length) {
          const info = inspect(ids[0]); assertBackendOwned('container', info, record, run, baseline.map(x => x.Id));
          if (info.State.Running) { assertBackendOwned('container', inspect(info.Id), record, run, baseline.map(x => x.Id)); docker(['container', 'stop', '--time', '10', info.Id]); }
          assertBackendOwned('container', inspect(info.Id), record, run, baseline.map(x => x.Id)); docker(['container', 'rm', info.Id]); removed.push({ kind: 'backend-container', id: info.Id }); journal();
        }
        const volume = `pi-manager-home-${record.id.replaceAll('-', '')}`;
        if (exactExists('volume', volume).length) {
          assertBackendOwned('volume', JSON.parse(docker(['volume', 'inspect', '--format', '{{json .}}', volume])), record, run, []);
          docker(['volume', 'rm', volume]); removed.push({ kind: 'backend-volume', id: volume }); journal();
        }
      } catch (e) { cleanupErrors.push(`backend cleanup: ${e.message}`); }
    }
    for (const item of [...roles].reverse()) {
      try {
        const info = resolve(item); if (!info) continue;
        assert.equal(info.State.Running, false, 'Still running: preserve evidence'); owned(item);
        docker(['container', 'rm', item.id]); removed.push({ kind: 'role-container', id: item.id }); item.removed = true; journal();
      } catch (e) { cleanupErrors.push(`${item.role} remove: ${e.message}`); }
    }
    try {
      evidence.after = snapshot(); assert.deepEqual(evidence.after, baseline, 'Preexisting container lifecycle snapshot changed');
      assert.equal(docker(['container', 'ls', '-aq', '--filter', `label=${LABEL}=${run}`]), '', 'Run container residue');
      for (const record of backendRecords) assert.deepEqual(exactExists('volume', `pi-manager-home-${record.id.replaceAll('-', '')}`), [], 'Backend volume residue');
      emit('all owned containers/volume removed; exact existing-container snapshot unchanged', { preexisting: baseline.length, removed: removed.length });
    } catch (e) { cleanupErrors.push(`final snapshot/residue: ${e.message}`); }
    evidence.success = !failed && cleanupErrors.length === 0; journal(); writeJson(path.join(root, 'evidence.json'), evidence);
    console.log(`RESULT ${JSON.stringify({ success: evidence.success, checks: checks.length, root, cleanupErrors })}`);
  }
  if (!evidence.success) throw new Error(`Acceptance failed; retained exact journal: ${path.join(root, 'ownership.json')}`);
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

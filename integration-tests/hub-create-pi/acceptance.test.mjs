import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { WebSocket } from 'ws';
import { DockerEngine } from '../../manager/backends/docker-engine.ts';
import { startChatService } from '../../manager/chat-service.ts';
import { startService } from '../../manager/service.ts';
import { startAdminService } from '../../manager/admin-service.ts';
import { listen } from '../../manager/http.ts';
import { gates, checkHelper, checkPi, checkHomeLabels, snapshot, TEST_LABEL, INSTANCE } from './safety.mjs';
import { PI_LOGS_SOURCE } from './eval-source.mjs';

const input = gates(process.env);
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, message, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(100); }
  throw new Error(`Timeout: ${message}`);
}
async function freePort() { const s = await listen(async (_req, res) => { res.end(); }, 0); const port = s.port; await s.close(); return port; }
const bind = (source, readOnly = true) => ({ Type: 'bind', Source: source, Target: source, ReadOnly: readOnly });

test('HTTP create/approve with real split-UID executor, proved Pi chat and persistent restart', {
  skip: !input && 'Requires PI_MANAGER_DOCKER_TEST=1 plus pinned image and clean Web root',
  timeout: 300_000,
}, async t => {
  assert.equal(process.getuid(), 1000, 'Run Chat/test driver as UID1000; do not silently substitute same-UID acceptance');
  assert.equal(process.getgid(), 1000, 'API IPC fixture requires host GID1000');
  const image = input.image, socket = await realpath(process.env.PI_MANAGER_DOCKER_TEST_SOCKET ?? '/var/run/docker.sock');
  assert.equal((await lstat(socket)).isSocket(), true);
  const dockerGid = (await lstat(socket)).gid;
  assert.notEqual(dockerGid, 21002, 'Enrollment GID must be distinct from Docker socket authority');
  const engine = new DockerEngine(socket, { timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024 });
  const root = await mkdtemp('/tmp/hcpi-');
  const nonce = randomBytes(16).toString('hex'), target = `hcpi-${nonce}`;
  const baseline = new Map(), helpers = [], baselineVolumes = new Set();
  const runtimeName = `hcpi-runtime-${nonce}`;
  const journal = { nonce, root, image, target, runtimeName, helpers, baseline: [], baselineVolumes: [], stages: [] };
  let chat, publicService, adminService, executor, ws, backendRecord;
  let prepareAttempted = false, runtimeAttempted = false, mainError;
  const save = async () => writeFile(path.join(root, 'evidence.json'), JSON.stringify(journal, null, 2), { mode: 0o600 });
  const stage = async name => { journal.stages.push(name); await save(); t.diagnostic(name); };
  const cli = async args => (await run('docker', ['--host', `unix://${socket}`, ...args], {
    env: { PATH: process.env.PATH, HOME: root, DOCKER_CONFIG: path.join(root, 'docker-client') },
    timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  const inspect = id => engine.call('GET', `/containers/${id}/json`, undefined, { allowMissing: true });
  const checked = async record => {
    const info = await inspect(record.id ?? record.name);
    // Recover a lost create reply only by exact pre-journaled name + label + pinned image.
    if (info && !record.id) { record.id = info.Id; await save(); }
    checkHelper(info, record, image, nonce, baseline); return info;
  };
  async function createHelper(role, options = {}) {
    const record = { role, name: `hcpi-${nonce}-${helpers.length}-${role}` };
    helpers.push(record); await save();
    assert.equal(await inspect(record.name), null, 'Helper name must not preexist');
    const definition = {
      Image: image, User: '1000:1000', Entrypoint: ['/usr/local/bin/node'], Cmd: [], WorkingDir: '/tmp',
      Labels: { [TEST_LABEL]: nonce },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
        RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
        ...options.HostConfig },
      ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'HostConfig')),
    };
    const result = await engine.call('POST', `/containers/create?name=${record.name}`, definition);
    record.id = result.Id; await save(); await checked(record);
    await engine.call('POST', `/containers/${record.id}/start`);
    return record;
  }
  async function completed(record) {
    await checked(record);
    const exit = await cli(['wait', record.id]);
    const output = await cli(['logs', record.id]);
    await writeFile(path.join(root, `${record.name}.log`), output, { mode: 0o600 });
    assert.equal(exit, '0', `${record.role} failed; ${output}`);
    return JSON.parse(output);
  }
  async function provision(operation) {
    return completed(await createHelper(operation, {
      User: '0:0', Cmd: [path.join(root, 'package/helpers/provision.mjs'), operation, root, nonce],
      // FOWNER permits chmod; FSETID separately preserves SGID for a foreign GID.
      // Keep the old set only for the intentional regression probe.
      HostConfig: { CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', ...(operation === 'prepare' ? ['FSETID'] : [])], Mounts: [bind(root, false)] },
    }));
  }
  async function execJson(record, code, args = []) {
    await checked(record);
    return JSON.parse(await cli(['exec', record.id, '/usr/local/bin/node', '--input-type=module', '-e', code, ...args]));
  }
  const ownPi = () => engine.call('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`${INSTANCE}=${target}`] }))}`);
  const home = path.join(root, 'Home'), projects = path.join(home, 'projects');
  const privateRoot = path.join(root, 'executor'), backendFile = path.join(privateRoot, 'docker/tasks.json');
  const chatRoot = path.join(root, 'chat'), chatFile = path.join(chatRoot, 'config.json');
  const brokerSocket = path.join(root, 'broker/enroll.sock');
  const submitSocket = path.join(root, 'submit/rpc.sock'), adminSocket = path.join(root, 'admin/rpc.sock');
  const pkg = path.join(root, 'package'), web = path.join(pkg, 'web'), provider = path.join(pkg, 'provider'), profile = path.join(pkg, 'profile');
  const credential = () => randomBytes(32).toString('hex');
  const requester = credential(), administrator = credential(), enrollment = credential();
  async function ipcSnapshot(label, includeSocket = false) {
    const directories = {};
    for (const name of ['submit', 'admin', 'broker']) {
      const s = await lstat(path.join(root, name));
      directories[name] = { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
    }
    const entry = { label, directories };
    if (includeSocket) {
      const s = await lstat(brokerSocket);
      entry.socket = { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
    }
    (journal.ipcSnapshots ??= []).push(entry); await save();
    // Save first: failures retain the pre-cleanup state, not restored mode0700.
    for (const name of ['submit', 'admin']) assert.deepEqual(directories[name], { uid: 21001, gid: 1000, mode: 0o2750 }, `${label}: ${name}`);
    assert.deepEqual(directories.broker, { uid: 1000, gid: 21002, mode: 0o2750 }, `${label}: broker parent`);
    if (includeSocket) assert.deepEqual(entry.socket, { uid: 1000, gid: 21002, mode: 0o660 }, `${label}: broker socket`);
  }
  try {
    await chmod(root, 0o755); await writeFile(path.join(root, 'run-owner'), nonce, { mode: 0o444 });
    const daemon = await engine.call('GET', '/info'); journal.daemonId = daemon.ID;
    for (const row of await engine.call('GET', '/containers/json?all=1')) baseline.set(row.Id, snapshot(await inspect(row.Id)));
    for (const v of (await engine.call('GET', '/volumes')).Volumes ?? []) baselineVolumes.add(v.Name);
    journal.baseline = [...baseline.values()]; journal.baselineVolumes = [...baselineVolumes]; await save();
    const imageInfo = await engine.call('GET', `/images/${encodeURIComponent(image)}/json`);
    assert.equal(imageInfo.Id, image);
    assert.equal(imageInfo.Config.Labels?.['cn.swordfate.pi-manager.profile-home'], 'uid1000-v1');
    assert.equal((imageInfo.Config.Env ?? []).some(v => v === 'PI_OFFLINE' || v.startsWith('PI_OFFLINE=')), false);
    assert.equal(imageInfo.Config.Volumes && Object.keys(imageInfo.Config.Volumes).length || 0, 0);
    for (const directory of [projects, path.join(projects, 'project'), path.join(projects, '.private'), pkg, provider, profile, path.join(pkg, 'helpers'), path.join(pkg, 'dist/manager'), privateRoot, chatRoot, path.join(root, 'broker'), path.join(root, 'submit'), path.join(root, 'admin')]) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    }
    await chmod(privateRoot, 0o700); await chmod(chatRoot, 0o700);
    await writeFile(path.join(projects, 'project/AGENTS.md'), 'PROJECT_CONTEXT_MUST_NOT_LOAD');
    for (const name of ['provision.mjs', 'runtime-digest.mjs']) await cp(path.join(here, name), path.join(pkg, 'helpers', name));
    await cp(path.join(here, 'profile-extension.mjs'), path.join(profile, 'index.mjs'));
    // UID1000 could write this source: EROFS must come from the actual RO bind.
    await writeFile(path.join(profile, 'models.json'), '{}\n', { mode: 0o644 });
    // Preserve dist/manager depth: bundled import.meta.url protects the package root.
    await cp(path.join(repository, 'dist/manager/pi-manager-executor.mjs'), path.join(pkg, 'dist/manager/executor.mjs'));
    journal.executorBundleHash = hash(await readFile(path.join(pkg, 'dist/manager/executor.mjs')));
    // Offline pack only: no install, lifecycle script, dependency resolution or repository mutation.
    const packed = await run('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root], {
      cwd: await realpath(input.webRoot), timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'), NPM_CONFIG_CACHE: path.join(root, 'npm-cache') },
    });
    const [{ filename }] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
    assert.equal(path.basename(filename), filename);
    // Extract under a dedicated directory; never overwrite the standalone package/helpers.
    const unpack = path.join(root, 'unpack'); await mkdir(unpack);
    await run('tar', ['-xzf', path.join(root, filename), '-C', unpack], { timeout: 15_000 });
    await cp(path.join(unpack, 'package'), web, { recursive: true });
    await cp(path.join(repository, 'integration-tests/fixtures/native-provider.ts'), path.join(provider, 'index.ts'));
    const pi = '/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent';
    for (const directory of [web, provider]) {
      await mkdir(path.join(directory, 'node_modules/@earendil-works'), { recursive: true });
      await symlink(pi, path.join(directory, 'node_modules/@earendil-works/pi-coding-agent'));
      await symlink(`${pi}/node_modules/@earendil-works/pi-ai`, path.join(directory, 'node_modules/@earendil-works/pi-ai'));
    }
    await cp(path.join(repository, 'node_modules/ws'), path.join(web, 'node_modules/ws'), { recursive: true, dereference: true });
    const chatConfig = { port: 0, stateDir: path.join(chatRoot, 'state'), runtimeDir: path.join(chatRoot, 'runtime'),
      provisioning: { socketPath: brokerSocket, exportDir: path.join(chatRoot, 'exports'), tokenHash: hash(enrollment), socketMode: 0o660 } };
    await writeFile(chatFile, JSON.stringify(chatConfig), { mode: 0o600 });
    await writeFile(path.join(privateRoot, 'authority.json'), JSON.stringify({ token: enrollment }), { mode: 0o600 });
    const config = {
      stateRoot: path.join(privateRoot, 'tasks'), submitSocket, adminSocket, socketMode: 0o660,
      principals: [{ id: 'requester', role: 'submitter', tokenHash: hash(requester) }, { id: 'administrator', role: 'admin', tokenHash: hash(administrator) }],
      trustedLocalNative: false, native: null, workspaces: {}, workspaceBrowser: { home, defaultRoot: 'projects' },
      docker: { socketPath: socket, daemonId: daemon.ID, image, pathCoordinates: 'host', stateRoot: path.join(privateRoot, 'docker'),
        workspaceRoots: { projects }, protectedRoots: [path.join(projects, '.private')], timeoutMs: 120_000, startupTimeoutMs: 30_000,
        web: { packageRoot: web, port: await freePort(), provider: { packageRoot: provider, name: 'native-fixture', model: 'deterministic' },
          enrollment: { socketPath: brokerSocket, authorityFile: path.join(privateRoot, 'authority.json'), registryHostDirectory: chatConfig.runtimeDir, exportHostDirectory: chatConfig.provisioning.exportDir } },
        runtimeProfile: { runtimeVolume: runtimeName, modelsFile: path.join(profile, 'models.json'), extensions: [{ packageRoot: profile, entry: 'index.mjs' }] },
      },
    };
    await writeFile(path.join(privateRoot, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    prepareAttempted = true;
    journal.setgidRegression = await provision('probe-setgid'); await save();
    assert.deepEqual(journal.setgidRegression.broker, { uid: 1000, gid: 21002, mode: 0o750 }, 'Old helper capability set must reproduce silent SGID clearing before Chat starts');
    journal.preparedIpc = await provision('prepare'); await save();
    await ipcSnapshot('after-prepare');
    // Direct-read negative probe uses the actual executor UID, without any Docker socket.
    const denied = await completed(await createHelper('private-probe', {
      User: '21001:21001', Cmd: ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; await assert.rejects(readFile(process.argv[1]),{code:'EACCES'}); console.log(JSON.stringify({uid:process.getuid(),privateRead:'EACCES'}));`, chatFile],
      HostConfig: { GroupAdd: ['21002'], Mounts: [bind(root)] },
    }));
    assert.deepEqual(denied, { uid: 21001, privateRead: 'EACCES' }); journal.privateProbe = denied;
    assert.equal(baselineVolumes.has(runtimeName), false);
    assert.equal(await engine.call('GET', `/volumes/${runtimeName}`, undefined, { allowMissing: true }), null);
    runtimeAttempted = true; await save();
    await engine.call('POST', '/volumes/create', { Name: runtimeName, Driver: 'local', Labels: { [TEST_LABEL]: nonce } });
    async function runtimeDigest(seed) {
      return completed(await createHelper(seed ? 'runtime-seed' : 'runtime-check', {
        Cmd: [path.join(pkg, 'helpers/runtime-digest.mjs')], HostConfig: { Mounts: [bind(pkg),
          { Type: 'volume', Source: runtimeName, Target: '/home/node/.local', ReadOnly: !seed, VolumeOptions: { NoCopy: !seed } }] },
      }));
    }
    const runtimeBefore = await runtimeDigest(true);
    assert.ok(runtimeBefore.files > 0, 'Prepared image must include a complete installed Pi runtime'); journal.runtimeBefore = runtimeBefore;
    await ipcSnapshot('before-chat-start');
    chat = await startChatService(chatFile);
    const chatOrigin = `http://127.0.0.1:${chat.port}`;
    await ipcSnapshot('after-chat-start', true);
    const brokerInfo = await lstat(brokerSocket);
    assert.equal(brokerInfo.uid, 1000); assert.equal(brokerInfo.gid, 21002); assert.equal(brokerInfo.mode & 0o777, 0o660);
    const publicPort = await freePort(), adminPort = await freePort();
    assert.notEqual(publicPort, adminPort);
    const publicOrigin = `http://127.0.0.1:${publicPort}`, adminOrigin = `http://127.0.0.1:${adminPort}`;
    async function startSplitExecutor() {
      const record = await createHelper('executor', {
        User: '21001:21001', Cmd: [path.join(pkg, 'dist/manager/executor.mjs'), '--config', path.join(privateRoot, 'config.json')],
        HostConfig: { GroupAdd: [...new Set(['21002', String(dockerGid)])], Mounts: [bind(privateRoot, false), bind(home), bind(pkg),
          bind(path.join(root, 'submit'), false), bind(path.join(root, 'admin'), false), bind(path.join(root, 'broker')), bind(socket, false)] },
      });
      executor = record;
      await until(async () => {
        const info = await checked(record);
        assert.equal(info.State.Running, true, `Executor exited: ${await cli(['logs', record.id])}`);
        return (await cli(['logs', record.id])).includes('"ready":true');
      }, 'executor ready');
      const identity = await execJson(record, `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; await assert.rejects(readFile(process.argv[1]),{code:'ENOENT'}); console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),privatePathAbsent:true}));`, [chatFile]);
      assert.equal(identity.uid, 21001); assert.equal(identity.gid, 21001); assert.ok(identity.groups.includes(21002));
      assert.ok(!identity.groups.includes(1000), 'Executor must not borrow Chat/Pi GID');
      journal.executorIdentity = identity; await save(); return record;
    }
    await startSplitExecutor();
    publicService = await startService({ socketPath: submitSocket, origin: publicOrigin, chatOrigin, port: publicPort });
    adminService = await startAdminService({ socketPath: adminSocket, origin: adminOrigin, chatOrigin, port: adminPort });
    async function http(origin, route, token, body) {
      const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, body: data };
    }
    const call = (route, body, token = requester) => http(publicOrigin, route, token, body);
    assert.equal((await http(publicOrigin, '/', '')).status, 200); assert.equal((await http(adminOrigin, '/', '')).status, 200);
    assert.equal((await call('/api/manager/workspace-browser', undefined, '')).status, 401);
    assert.deepEqual((await call('/api/manager/workspace-browser')).body, { defaultRoot: 'projects', roots: [{ id: 'projects', label: 'projects' }] });
    const browse = await call('/api/manager/workspaces/browse', { root: 'projects', path: '' });
    assert.equal(browse.status, 200); assert.deepEqual(browse.body.directories, [{ name: 'project', path: 'project' }]);
    for (const candidate of ['..', '/absolute', 'project//child', '.private']) {
      assert.equal((await call('/api/manager/workspaces/browse', { root: 'projects', path: candidate })).status, 400);
      assert.equal((await call('/api/manager/tasks', { key: `bad-${randomBytes(16).toString('hex')}`, action: 'create', target, workspace: { root: 'projects', path: candidate } })).status, 400);
    }
    assert.equal((await call('/api/manager/workspaces/browse', { root: 'projects', path: 'project' })).status, 200);
    const create = { key: `create-${nonce}`, action: 'create', target, workspace: { root: 'projects', path: 'project' } };
    const submitted = await call('/api/manager/tasks', create);
    assert.equal(submitted.status, 202); assert.equal(submitted.body.state, 'pending_approval');
    journal.createTaskId = submitted.body.id; await save();
    assert.equal((await call('/api/manager/tasks', create)).body.id, submitted.body.id);
    assert.equal((await call('/api/manager/approve', { taskId: submitted.body.id })).status, 403);
    assert.equal((await http(adminOrigin, '/api/manager/approve', requester, {})).status, 401);
    assert.equal((await http(adminOrigin, '/api/manager/login', '', { credential: requester })).status, 403);
    assert.equal((await ownPi()).length, 0);
    assert.equal((await readdir(path.join(chatRoot, 'state/grants'))).length, 0);
    const login = await http(adminOrigin, '/api/manager/login', '', { credential: administrator });
    assert.equal(login.status, 200); const adminToken = login.body.sessionToken; assert.ok(adminToken);
    async function approve(task) {
      const review = await http(adminOrigin, `/api/manager/tasks/${task.id}/review`, adminToken);
      assert.equal(review.status, 200); assert.equal(review.body.task.id, task.id);
      assert.equal(review.body.task.action, task.action); assert.equal(review.body.task.target, target);
      if (task.action === 'create') assert.deepEqual(review.body.task.payload, { workspace: create.workspace });
      const approved = await http(adminOrigin, '/api/manager/approve', adminToken, review.body.binding);
      assert.equal(approved.status, 200);
      return until(async () => {
        const result = await call(`/api/manager/tasks/${task.id}`); assert.equal(result.status, 200);
        assert.ok(!['failed', 'unknown', 'cancelled'].includes(result.body.state), `Task ${task.action}: ${JSON.stringify(result.body)}`);
        return result.body.state === 'succeeded' && result.body;
      }, `${task.action} task succeeded through broker readiness`, 50_000);
    }
    await stage('HTTP pending approval/idempotency/private-path denial verified');
    await approve(submitted.body);
    const records = await execJson(executor, `import {readFile} from 'node:fs/promises'; console.log(await readFile(process.argv[1],'utf8'));`, [backendFile]);
    assert.equal(Object.values(records.tasks).length, 1); backendRecord = Object.values(records.tasks)[0];
    journal.backendRecord = backendRecord; await save();
    const piInfo = await inspect(backendRecord.result.containerId);
    checkPi(piInfo, backendRecord, image, target, baseline); assert.equal((await ownPi()).length, 1);
    assert.equal(piInfo.Config.User, '1000:1000'); assert.equal(piInfo.HostConfig.ReadonlyRootfs, true);
    assert.equal(piInfo.HostConfig.Privileged, false); assert.deepEqual(piInfo.HostConfig.CapDrop, ['ALL']);
    assert.ok(piInfo.HostConfig.SecurityOpt.includes('no-new-privileges:true')); assert.equal(piInfo.HostConfig.NetworkMode, 'host');
    assert.equal((piInfo.Config.Env ?? []).some(v => v.startsWith('PI_OFFLINE=')), false);
    const expectedMounts = [
      ['/workspace', 'bind', path.join(projects, 'project'), true], ['/home/node', 'volume', backendRecord.result.homeVolume, true],
      ['/home/node/.local', 'volume', runtimeName, false], ['/opt/pi-web', 'bind', web, false], ['/opt/pi-provider', 'bind', provider, false],
      ['/opt/pi-profile/extensions/0', 'bind', profile, false], ['/home/node/.pi/manager-agent/models.json', 'bind', path.join(profile, 'models.json'), false],
      ['/run/pi-registry', 'bind', chatConfig.runtimeDir, false], ['/run/pi-web/credential.json', 'bind', path.join(chatRoot, 'exports', `registration-${backendRecord.id}.json`), false],
    ];
    assert.equal(piInfo.Mounts.length, expectedMounts.length);
    for (const [destination, type, source, writable] of expectedMounts) {
      const mount = piInfo.Mounts.find(m => m.Destination === destination); assert.ok(mount, destination);
      assert.equal(mount.Type, type); assert.equal(type === 'volume' ? mount.Name : mount.Source, source); assert.equal(mount.RW, writable);
    }
    const runtimeMount = piInfo.HostConfig.Mounts.find(m => m.Target === '/home/node/.local');
    assert.equal(runtimeMount.ReadOnly, true); assert.equal(runtimeMount.VolumeOptions.NoCopy, true);
    const exportFile = expectedMounts.at(-1)[2], exportInfo = await lstat(exportFile);
    assert.equal(exportInfo.uid, 1000); assert.equal(exportInfo.mode & 0o777, 0o600);
    const grant = JSON.parse(await readFile(exportFile, 'utf8'));
    const sessions = async () => (await (await fetch(`${chatOrigin}/api/sessions`, { signal: AbortSignal.timeout(5000) })).json()).sessions;
    const firstSessions = await sessions(); assert.equal(firstSessions.length, 1, 'succeeded must already mean registered/proved, not Running');
    const page = new URL(firstSessions[0].path, chatOrigin);
    assert.equal((await fetch(page)).status, 200);
    async function connect(page) {
      ws = new WebSocket(new URL('ws', page).href.replace(/^http/, 'ws'), { origin: chatOrigin, handshakeTimeout: 5000 });
      const frames = []; let error;
      ws.on('error', e => { error = e; }); ws.on('message', value => { try { frames.push(JSON.parse(value.toString())); } catch (e) { error = e; } });
      await until(() => { if (error) throw error; return ws.readyState === WebSocket.OPEN && frames.some(f => f.event === 'state_sync'); }, 'Hub WebSocket state_sync');
      return frames;
    }
    const frames = await connect(page), prompt = `Hub approval split-UID acceptance ${nonce}`;
    ws.send(JSON.stringify({ type: 'req', id: 'acceptance-prompt', method: 'prompt', params: { message: prompt } }));
    await until(() => JSON.stringify(frames).includes('NATIVE_PI_GENERATION_OK'), 'deterministic provider result over Hub WebSocket');
    async function piLogs() {
      const current = await inspect(piInfo.Id); checkPi(current, backendRecord, image, target, baseline);
      return JSON.parse(await cli(['exec', piInfo.Id, '/usr/local/bin/node', '--input-type=module', '-e', PI_LOGS_SOURCE]));
    }
    const logs = await piLogs();
    assert.ok(logs.provider.some(e => e.event === 'model_call' && e.projectContextLoaded === false));
    assert.ok(logs.profile.some(e => e.uid === 1000 && e.gid === 1000 && e.modelsReadOnly && e.online && e.writable.length === 3));
    await stage('Split UID21001 → GID21002 broker → UID1000 Pi: HTTP approval, exact mounts and deterministic WS result verified');
    async function action(name) {
      const result = await call('/api/manager/tasks', { key: `${name}-${randomBytes(16).toString('hex')}`, action: name, target });
      assert.equal(result.status, 202); assert.equal(result.body.state, 'pending_approval'); await approve(result.body);
    }
    await action('stop'); ws.terminate(); ws = undefined;
    assert.equal((await inspect(piInfo.Id)).State.Running, false);
    assert.equal((await engine.call('GET', `/volumes/${backendRecord.result.homeVolume}`)).Name, backendRecord.result.homeVolume);
    await until(async () => (await fetch(page)).status === 410, 'stopped chat route unavailable');
    await checked(executor); await engine.call('POST', `/containers/${executor.id}/stop?t=15`);
    const stoppedExecutor = await checked(executor); assert.equal(stoppedExecutor.State.ExitCode, 0, 'Executor must close cleanly before reopen');
    await startSplitExecutor();
    await action('start');
    const restored = await inspect(piInfo.Id); checkPi(restored, backendRecord, image, target, baseline);
    assert.equal(restored.State.Running, true); assert.equal((await ownPi()).length, 1);
    assert.equal(restored.Mounts.find(m => m.Destination === '/home/node').Name, backendRecord.result.homeVolume);
    assert.deepEqual(JSON.parse(await readFile(exportFile, 'utf8')), grant, 'Same grant/run/token after executor restart');
    assert.equal((await readdir(path.join(chatRoot, 'state/grants'))).length, 1);
    const restoredSessions = await sessions(); assert.equal(restoredSessions.length, 1);
    const history = await connect(new URL(restoredSessions[0].path, chatOrigin));
    await until(() => JSON.stringify(history).includes(prompt) && JSON.stringify(history).includes('NATIVE_PI_GENERATION_OK'), 'saved user and assistant turns after stop/start');
    assert.ok((await piLogs()).profile.length >= 2, 'Explicit profile extension loaded after restart');
    await action('stop'); ws.terminate(); ws = undefined;
    journal.runtimeAfter = await runtimeDigest(false); assert.deepEqual(journal.runtimeAfter, runtimeBefore, 'Shared runtime content/metadata must be unchanged');
    await stage('Approved stop/start after executor reopen restored exact container/home/grant and chat history; runtime unchanged');
  } catch (error) {
    mainError = error; journal.failure = String(error?.stack ?? error); await save();
  } finally {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (e) { errors.push(String(e?.stack ?? e)); } };
    ws?.terminate();
    await attempt(async () => { await adminService?.close(); });
    await attempt(async () => { await publicService?.close(); });
    // Stop exact journaled executor before reading/restoring its private state.
    for (const record of helpers.filter(h => h.role === 'executor')) await attempt(async () => {
      const info = await checked(record);
      if (info.State.Running) await engine.call('POST', `/containers/${info.Id}/stop?t=15`);
      await writeFile(path.join(root, `${record.name}.log`), await cli(['logs', info.Id]), { mode: 0o600 });
      assert.equal((await checked(record)).State.ExitCode, 0, 'Unclean executor close: retain journal for reconciliation');
    });
    await attempt(async () => { await chat?.close(); });
    if (prepareAttempted && !errors.length) await attempt(() => provision('collect'));
    if (!errors.length) await attempt(async () => {
      let stored;
      try { stored = JSON.parse(await readFile(backendFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const records = Object.values(stored?.tasks ?? {});
      // Missing/unknown journal cannot authorize deleting an observed Pi or its retained home.
      assert.ok(records.length <= 1);
      if ((await ownPi()).length) assert.equal(records.length, 1, 'Unjournaled Pi outcome');
      for (const record of records) {
        assert.equal(record.state, 'succeeded', 'Unknown operation: preserve Pi/home and evidence');
        const info = await inspect(record.result.containerId); assert.ok(info, 'Missing exact Pi identity: preserve home');
        checkPi(info, record, image, target, baseline);
        const volume = await engine.call('GET', `/volumes/${record.result.homeVolume}`);
        assert.equal(baselineVolumes.has(volume.Name), false); assert.equal(volume.Name, record.result.homeVolume);
        checkHomeLabels(volume.Labels, record, target);
        await writeFile(path.join(root, 'pi.log'), await cli(['logs', info.Id]), { mode: 0o600 });
        if (info.State.Running) await engine.call('POST', `/containers/${info.Id}/stop?t=10`);
        await engine.call('DELETE', `/containers/${info.Id}`);
        await engine.call('DELETE', `/volumes/${volume.Name}`);
        journal.removedPi = { id: info.Id, home: volume.Name };
      }
    });
    // Exact helper IDs only; never prune, sweep labels, use --volumes, or remove baseline resources.
    for (const record of helpers) await attempt(async () => {
      const info = await inspect(record.id ?? record.name); if (!info) return;
      await checked(record);
      if (info.State.Running) await engine.call('POST', `/containers/${info.Id}/stop?t=5`);
      await engine.call('DELETE', `/containers/${info.Id}`); record.removed = true;
    });
    if (runtimeAttempted && !errors.length) await attempt(async () => {
      const volume = await engine.call('GET', `/volumes/${runtimeName}`, undefined, { allowMissing: true });
      if (!volume) return;
      assert.equal(volume.Name, runtimeName); assert.equal(volume.Labels[TEST_LABEL], nonce); assert.equal(baselineVolumes.has(runtimeName), false);
      await engine.call('DELETE', `/volumes/${runtimeName}`); journal.removedRuntime = runtimeName;
    });
    journal.afterBaseline = [];
    for (const [id, expected] of baseline) await attempt(async () => {
      const info = snapshot(await inspect(id)); journal.afterBaseline.push(info);
      assert.deepEqual(info, expected, `Preexisting container changed: ${id}`);
    });
    journal.cleanupErrors = errors; journal.passed = !mainError && !errors.length;
    await chmod(root, 0o700); await save(); engine.close();
    t.diagnostic(`Evidence retained: ${root}/evidence.json${errors.length ? ' — unresolved resources retained; reconcile exact journal before deletion' : ' — all owned Docker resources removed'}`);
    if (mainError || errors.length) throw new AggregateError([...(mainError ? [mainError] : []), ...errors.map(e => new Error(e))], `Hub acceptance failed; evidence: ${root}/evidence.json`);
  }
});

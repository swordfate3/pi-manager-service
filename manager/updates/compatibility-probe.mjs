/** Runs ONLY in the fixed disposable container. Candidate code never executes in the executor. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { candidateTreeHash, digest, fileBytes, inventory, restoredDialogue, selectedModule, sessionIdentity, snapshotDialogue, webInventory } from './compatibility-inputs.ts';

let active, stage = 'mount-verification';
const observations = [];
const timer = setTimeout(() => { process.stderr.write(JSON.stringify({ refused: 'probe-deadline', stage }) + '\n'); process.exit(1); }, 75000);
const boundedRead = file => fileBytes(file, 1024 * 1024);
async function wait(check, label, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw Error('Deadline: ' + label);
}
function control(root, fields) {
  return new Promise((resolve, reject) => {
    const peer = net.createConnection(root + '/run/control.sock'); let data = '';
    peer.setTimeout(2000, () => peer.destroy(Error('Control deadline'))); peer.on('error', reject);
    peer.on('connect', () => peer.end(JSON.stringify({ token: 'a'.repeat(64), ...fields }) + '\n'));
    peer.on('data', b => { data += b; if (Buffer.byteLength(data) > 16384) peer.destroy(Error('Control overflow')); });
    peer.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
}
async function launch(binding, name, sessionFile) {
  const root = '/work/' + name;
  for (const sub of ['', '/run', '/home', '/agent', '/sessions', '/workspace', '/tmp', '/cache', '/config']) await mkdir(root + sub, { mode: 0o700 });
  await writeFile(root + '/agent/settings.json', JSON.stringify({ packages: [], extensions: [], autoCompact: false }), { mode: 0o600 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root + '/home', TMPDIR: root + '/tmp', XDG_CONFIG_HOME: root + '/config', XDG_CACHE_HOME: root + '/cache',
    LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: root + '/agent', PI_AGENT_DIR: root + '/agent', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_RUNTIME_RUN_ID: 'c'.repeat(32), PI_RUNTIME_CHILD_TOKEN: 'a'.repeat(64), PI_RUNTIME_EXTENSION_SOCKET: root + '/run/control.sock',
    PI_COMPAT_TRACE: root, PI_WEB_UI_HOST: '127.0.0.1', PI_WEB_UI_PORT: '18765', PI_WEB_UI_DISABLED: 'false', PI_WEB_UI_STATIC_DIR: '/work/web/dist' };
  // No correlated-Web opt-in: default permanent-taint behavior is the contract under test.
  const cli = '/candidate/' + binding.cli.relativePath;
  const args = ['--import', '/probe/pi_rpc_guard.mjs', cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--no-approve', '--no-tools', '--no-mcp', '--session-dir', root + '/sessions',
    '--extension', '/work/web/extensions/mirror-server.ts', '--extension', '/probe/compatibility-provider.mjs',
    '--provider', 'compatibility-offline', '--model', 'fixed', ...(sessionFile ? ['--session', sessionFile] : [])];
  const child = spawn('/usr/local/bin/node', args, { cwd: root + '/workspace', env, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = []; let partial = '', total = 0, stderr = '', failure;
  const closed = new Promise(r => { child.once('close', r); child.once('error', e => { failure = e; r(null); }); });
  child.stdin.on('error', e => { failure = e; });
  child.stderr.on('data', b => { total += b.length; if (total > 1024 * 1024) { failure = Error('Pi output overflow'); child.kill('SIGKILL'); } else stderr = (stderr + b).slice(-16384); });
  child.stdout.on('data', b => {
    total += b.length;
    if (total > 1024 * 1024) { failure = Error('Pi output overflow'); child.kill('SIGKILL'); return; }
    partial += b;
    let end;
    try { while ((end = partial.indexOf('\n')) >= 0) { const line = partial.slice(0, end); partial = partial.slice(end + 1); frames.push(JSON.parse(line)); } }
    catch (e) { failure = e; child.kill('SIGKILL'); }
  });
  let ws;
  const stop = async () => {
    ws?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 1500);
      try { await closed; } finally { clearTimeout(force); }
    }
  };
  active = { stop, diagnostic: () => ({ stderr: stderr.slice(-8000), rpc: JSON.stringify(frames.slice(-12)).slice(-12000) }) };
  const check = () => { if (failure || child.exitCode !== null || child.signalCode !== null) throw Error('Pi failed: ' + (failure?.message ?? stderr)); };
  const trace = async () => { try { return (await boundedRead(root + '/trace.jsonl')).toString().trim().split('\n').map(s => JSON.parse(s)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  await wait(async () => { check(); return (await trace()).some(e => e.event === 'ready'); }, 'RPC ready', 15000);
  const write = frame => { check(); child.stdin.write(JSON.stringify(frame) + '\n'); };
  const snapshot = async () => { const r = await control(root, { action: 'snapshot' }); assert.equal(r.ok, true); return r.result; };
  const prepare = s => control(root, { action: 'prepare', operation_id: 'b'.repeat(32), expected: { runtime_id: s.runtime_id, session_id: s.session_id, leaf_id: s.leaf_id } });
  write({ id: 'ready', type: 'get_state' });
  await wait(() => { check(); return frames.some(f => f.type === 'response' && f.id === 'ready' && f.success); }, 'get_state');
  const response = await fetch('http://127.0.0.1:18765/', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); let html = '';
  for await (const b of response.body) { html += Buffer.from(b); assert.ok(Buffer.byteLength(html) <= 1024 * 1024); }
  assert.ok(html.includes('<html')); const bodySha256 = digest(html);
  const messages = []; let webBytes = 0;
  ws = new WebSocket('ws://127.0.0.1:18765/ws');
  ws.addEventListener('message', e => {
    webBytes += Buffer.byteLength(String(e.data));
    try { if (webBytes > 2 * 1024 * 1024) throw Error('Web overflow'); messages.push(JSON.parse(String(e.data))); } catch (e) { failure = e; ws.close(); }
  });
  ws.addEventListener('error', () => { failure = Error('Web connect failed'); });
  await wait(() => { check(); return messages.find(m => m.event === 'state_sync'); }, 'Web state');
  let seq = 0;
  const web = async (method, params = {}) => {
    const id = 'web-' + ++seq; ws.send(JSON.stringify({ type: 'req', id, method, params }));
    return wait(() => { check(); return messages.find(m => m.type === 'res' && m.id === id); }, 'Web reply');
  };
  const cliHistory = async () => {
    const id = 'restore-messages'; write({ id, type: 'get_messages' });
    const reply = await wait(() => { check(); return frames.find(f => f.type === 'response' && f.id === id); }, 'CLI restored messages');
    assert.equal(reply.success, true); assert.ok(Array.isArray(reply.data?.messages));
    return reply.data.messages;
  };
  const history = async sessionId => {
    const entries = [], cursors = new Set(); let before;
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 4096, 'bounded Web history pages');
      const page = await web('get_messages', { sessionId, from: -8640000000000000, to: 8640000000000000, ...(before ? { before } : {}) });
      assert.equal(page.ok, true); assert.ok(Array.isArray(page.result?.entries));
      assert.equal(page.result.history?.truncatedEntries, 0, 'preview is not restore evidence');
      assert.equal(page.result.history.returned, page.result.entries.length);
      entries.unshift(...page.result.entries); assert.ok(entries.length <= 4096, 'bounded Web history entries');
      before = page.result.history.nextBefore;
      if (before === null) break;
      assert.equal(typeof before, 'string'); assert.ok(before && !cursors.has(before)); cursors.add(before);
    }
    return entries.filter(e => e.type === 'message').map(e => e.message);
  };
  const generation = async (id, text) => {
    const starts = frames.length; write({ id, type: 'prompt', message: text });
    await wait(() => { check(); return frames.slice(starts).some(f => f.type === 'agent_settled'); }, 'agent_settled');
    const rpc = frames.slice(starts), ack = rpc.find(f => f.type === 'response' && f.id === id), settled = rpc.find(f => f.type === 'agent_settled');
    assert.equal(ack?.success, true); assert.equal(ack?.data?.disposition, 'started'); assert.equal(settled.aborted, false);
    assert.ok(rpc.some(f => f.type === 'agent_start'));
    assert.ok(JSON.stringify(rpc).includes('COMPAT_RESPONSE'));
    return { disposition: ack.data.disposition, aborted: settled.aborted, text: 'COMPAT_RESPONSE' };
  };
  return { root, frames, trace, snapshot, prepare, write, generation, web, history, cliHistory, bodySha256, stop };
}

try {
  assert.equal(process.getuid(), 1000); assert.equal(process.argv.length, 3);
  const binding = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
  assert.equal('v' + process.versions.node, binding.node);
  assert.equal(await candidateTreeHash('/candidate'), binding.treeSha256);
  assert.equal(digest(await fileBytes('/candidate/package-lock.json', 8 * 1024 ** 2)), binding.lockSha256);
  assert.equal(digest(await fileBytes('/candidate/' + binding.cli.relativePath, 32 * 1024 ** 2)), binding.cli.sha256);
  assert.equal((await inventory('/probe', true)).sha256, binding.sourceSha256);
  const web = await webInventory('/web-input'); assert.equal(web.sha256, binding.webSha256); assert.equal(web.sourceSha256, binding.webSourceSha256); assert.equal(web.outputSha256, binding.webOutputSha256);
  if (binding.session) assert.deepEqual(sessionIdentity(await boundedRead('/saved.jsonl')), binding.session);
  for (const sub of ['home', 'tmp']) await mkdir('/work/' + sub, { mode: 0o700 });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/home', TMPDIR: '/work/tmp', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: '/work/home/agent', PI_AGENT_DIR: '/work/home/agent' });
  await cp('/web-input', '/work/web', { recursive: true, dereference: false });
  // Only a scratch copy gets peer wiring. No installation/dependency changes to any shared tree.
  const { chmod } = await import('node:fs/promises'); await chmod('/work/web', 0o700);
  await symlink('/candidate/node_modules', '/work/web/node_modules');
  stage = 'selected-sdk';
  const sdkPath = await selectedModule('/candidate', '@earendil-works/pi-coding-agent');
  const sdk = await import(pathToFileURL(sdkPath).href);
  assert.equal(sdk.VERSION, binding.release.version); assert.equal(sdk.CURRENT_SESSION_VERSION, 3);
  observations.push({ event: 'selected-sdk', module: sdkPath, version: sdk.VERSION, node: 'v' + process.versions.node });
  stage = 'web-generation-fence';
  const first = await launch(binding, 'first');
  assert.equal((await first.web('get_state')).ok, true); assert.equal((await first.snapshot()).version, binding.release.version);
  observations.push({ event: 'web-read', httpStatus: 200, readOk: true, bodySha256: first.bodySha256 });
  const pending = first.generation('generation', 'COMPAT_GENERATE');
  // Consume rejection immediately to avoid an unhandled promise if readiness fails.
  pending.catch(() => {});
  await wait(async () => (await first.trace()).some(e => e.event === 'model'), 'provider');
  const busy = await first.snapshot(); assert.equal(busy.idle, false); assert.equal((await first.prepare(busy)).ok, false);
  await writeFile(first.root + '/release', 'release', { mode: 0o600 });
  observations.push({ event: 'generation-settled', ...await pending });
  const idle = await first.snapshot(); assert.equal(idle.idle, true); assert.equal(idle.busy, false); assert.ok(idle.session_file);
  assert.equal((await first.prepare(idle)).ok, true);
  const denied = await first.web('prompt', { message: 'MUST_NOT_RUN' }); assert.equal(denied.ok, false);
  const mutation = await first.web('set_thinking_level', { level: 'low' }); assert.equal(mutation.ok, false);
  const wrong = await control(first.root, { action: 'cancel', operation_id: 'd'.repeat(32) }); assert.equal(wrong.ok, false);
  assert.equal((await first.web('prompt', { message: 'STILL_BLOCKED' })).ok, false);
  assert.equal((await first.trace()).filter(e => e.event === 'model').length, 1);
  observations.push({ event: 'barrier-rejected', promptOk: denied.ok, mutationOk: mutation.ok, wrongCancelOk: wrong.ok });
  const cancelled = await control(first.root, { action: 'cancel', operation_id: 'b'.repeat(32) }); assert.equal(cancelled.ok, true); assert.equal(cancelled.result.cancelled, true);
  observations.push({ event: 'exact-cancel', cancelled: cancelled.result.cancelled });
  observations.push({ event: 'generation-resumed', ...await first.generation('resumed', 'COMPAT_RESUME') });
  const savedState = await first.snapshot();
  assert.equal(savedState.session_id, idle.session_id); assert.notEqual(savedState.leaf_id, idle.leaf_id);
  assert.equal((await first.prepare(savedState)).ok, true);
  const sessionFile = '/work/restore.jsonl';
  assert.ok(savedState.session_file.startsWith(first.root + '/sessions/'));
  const bytes = await boundedRead(binding.session ? '/saved.jsonl' : savedState.session_file), saved = sessionIdentity(bytes);
  // Freeze an independently parsed expectation BEFORE calling candidate restore code.
  const expectedDialogue = snapshotDialogue(bytes);
  await writeFile(sessionFile, bytes, { mode: 0o600, flag: 'wx' });
  if (!binding.session) { assert.equal(saved.sessionId, savedState.session_id); assert.equal(saved.leafId, savedState.leaf_id); }
  // Only this disposable owned child is stopped. There is no live runtime stop capability.
  await first.stop(); active = undefined;
  stage = 'saved-dialogue-restore';
  const restoredSession = sdk.SessionManager.open(sessionFile, '/work/restore-sessions', '/work/restored/workspace');
  assert.equal(restoredSession.getSessionId(), saved.sessionId); assert.equal(restoredSession.getLeafId(), saved.leafId);
  assert.equal(digest(await boundedRead(sessionFile)), saved.sha256, 'SDK must not silently migrate/rewrite input');
  const context = restoredSession.buildSessionContext(), messagesSha256 = digest(JSON.stringify(context.messages));
  assert.equal(saved.dialogueSha256, digest(JSON.stringify(expectedDialogue)));
  const restored = await launch(binding, 'restored', sessionFile);
  const restoredState = await restored.snapshot();
  assert.equal(restoredState.session_id, saved.sessionId); assert.equal(restoredState.leaf_id, saved.leafId);
  assert.equal((await restored.trace()).filter(e => e.event === 'model').length, 0, 'saved prompts cannot replay');
  const after = sdk.SessionManager.open(sessionFile, '/work/restore-sessions', '/work/restored/workspace');
  assert.equal(digest(JSON.stringify(after.buildSessionContext().messages)), messagesSha256);
  const webHistory = await restored.history(saved.sessionId);
  assert.equal(digest(await boundedRead(sessionFile)), saved.sha256, 'CLI restore must preserve snapshot bytes');
  assert.equal((await restored.trace()).filter(e => e.event === 'model').length, 0, 'history reads cannot replay prompts');
  stage = 'web-void-taint';
  assert.equal((await restored.prepare(restoredState)).ok, true);
  assert.equal((await control(restored.root, { action: 'cancel', operation_id: 'b'.repeat(32) })).ok, true);
  const dispatched = await restored.web('prompt', { message: 'COMPAT_WEB' }); assert.equal(dispatched.ok, true);
  await wait(() => restored.frames.some(f => f.type === 'agent_settled'), 'Web settlement');
  const admission = await restored.prepare(await restored.snapshot()); assert.equal(admission.ok, false, 'void dispatch must remain permanently tainted');
  assert.equal((await restored.trace()).filter(e => e.event === 'tool').length, 0);
  await restored.stop(); active = undefined;
  // get_messages is intentionally outside the shipped guard's audited RPC
  // allowlist. Isolate that diagnostic in a fresh child: it must not pre-taint
  // the process used to prove default Web void-dispatch permanent taint.
  stage = 'saved-cli-history';
  const cliCopy = '/work/restore-cli.jsonl'; await writeFile(cliCopy, bytes, { mode: 0o600, flag: 'wx' });
  const historyChild = await launch(binding, 'history', cliCopy), historyState = await historyChild.snapshot();
  assert.equal(historyState.session_id, saved.sessionId); assert.equal(historyState.leaf_id, saved.leafId);
  const dialogueEvidence = restoredDialogue(bytes, { sdk: context.messages, cli: await historyChild.cliHistory(), web: webHistory });
  assert.equal(dialogueEvidence.expectedDialogueSha256, digest(JSON.stringify(expectedDialogue)));
  assert.equal(digest(await boundedRead(cliCopy)), saved.sha256);
  assert.equal((await historyChild.trace()).filter(e => e.event === 'model' || e.event === 'tool').length, 0);
  observations.push({ event: 'session-restored', copySha256: saved.sha256, messagesSha256, ...dialogueEvidence, beforeSession: saved.sessionId, sessionId: restoredState.session_id, beforeLeaf: saved.leafId, leafId: restoredState.leaf_id });
  observations.push({ event: 'web-void-tainted', dispatchOk: dispatched.ok, prepareOk: admission.ok, settled: true });
  await historyChild.stop(); active = undefined;
  assert.equal(await candidateTreeHash('/candidate'), binding.treeSha256);
  process.stdout.write(JSON.stringify({ schema: 1, status: 'compatible', binding, observations }) + '\n');
} catch (e) {
  process.stderr.write(JSON.stringify({ refused: 'behavior-incompatible', stage, reason: String(e.message).slice(0, 16000), observed: observations, diagnostic: active?.diagnostic() }) + '\n');
  process.exitCode = 1;
} finally { await active?.stop(); clearTimeout(timer); }

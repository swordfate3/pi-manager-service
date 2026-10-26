// Real private IPC/process boundary; adversarial protocol fixture, not a Pi substitute.
import net from 'node:net';
import path from 'node:path';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
const socket = process.env.PI_RUNTIME_EXTENSION_SOCKET;
const sessionFile = path.join(path.dirname(path.dirname(socket)), 'sessions', 'fixture.jsonl');
writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'fixture-session', cwd: process.cwd() }) + '\n', { mode: 0o600 });
let barrier;
const controls = () => { try { return JSON.parse(readFileSync('control.json', 'utf8')); } catch { return {}; } };
const snapshot = () => ({ run_id: process.env.PI_RUNTIME_RUN_ID, runtime_id: 'fixture-runtime', session_id: 'fixture-session',
  leaf_id: null, session_file: sessionFile, cwd: process.cwd(), version: '1.4.0', idle: true, pending: false, busy: false,
  provider: 'fixture', model: 'deterministic', thinking: 'off', ...controls().snapshot });
const peers = new Set();
const server = net.createServer({ allowHalfOpen: true }, peer => {
  peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer));
  let input = '';
  peer.on('data', chunk => { input += chunk; if (!input.includes('\n')) return;
    const request = JSON.parse(input.split('\n')[0]);
    if (request.token !== process.env.PI_RUNTIME_CHILD_TOKEN) { peer.end('{"ok":false}\n'); return; }
    const config = controls();
    if (request.action === 'prepare') {
      writeFileSync('prepare-observed', request.operation_id); barrier = request.operation_id;
      if (config.losePrepareReply) { peer.destroy(); return; }
    }
    if (request.action === 'cancel') {
      if (barrier !== request.operation_id || config.loseCancelReply) { peer.destroy(); return; }
      barrier = undefined;
    }
    if (request.action === 'commit') {
      writeFileSync('commit-observed', request.operation_id);
      if (config.loseCommitReply) { peer.destroy(); return; }
    }
    const result = request.action === 'cancel' ? { cancelled: true } : request.action === 'commit' ?
      { committed: true, operation_id: request.operation_id, snapshot: snapshot() } : snapshot();
    const reply = () => peer.end(JSON.stringify({ ok: true, result }) + '\n');
    if (request.action === 'prepare' && config.delayPrepare) setTimeout(reply, 100); else reply();
  });
});
await new Promise(resolve => server.listen(socket, resolve)); chmodSync(socket, 0o600);
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\n'); if (end < 0) break;
    const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
    if (request.type === 'get_state') process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: { isStreaming: false, isCompacting: false } }) + '\n');
    if (request.type === 'prompt') {
      writeFileSync('prompt-delivered', request.message);
      for (const frame of [{ type: 'response', id: request.id, command: 'prompt', success: true, data: { disposition: 'started' } },
        { type: 'agent_start' }, { type: 'agent_end', messages: [] }, { type: 'agent_settled', aborted: false }]) process.stdout.write(JSON.stringify(frame) + '\n');
    }
  }
});
process.stdin.on('end', () => { for (const peer of peers) peer.destroy(); server.close(); });

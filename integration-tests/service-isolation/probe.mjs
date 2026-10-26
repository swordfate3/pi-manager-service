// Clients and OS-permission probes only. No service, policy, task store or backend implementation.
import assert from 'node:assert/strict';
import { readFile, open, writeFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

const mode = process.argv[2];
if (mode === 'hold') {
  console.log(JSON.stringify({ ready: true }));
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
} else {
  let input = '';
  for await (const part of process.stdin) { input += part; assert.ok(input.length <= 32768); }
  const p = JSON.parse(input || '{}');
  const rpc = (socketPath, credential, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath, method: 'POST', path: '/rpc', headers: { Host: 'executor',
      Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', s => { text += s; if (text.length > 1024 * 1024) req.destroy(new Error('Response limit')); });
      res.on('end', () => { clearTimeout(timer); try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('RPC timeout')), 7000);
    req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(data);
  });
  const http = async spec => {
    const headers = { ...(spec.headers ?? {}) };
    if (spec.credential) headers.Authorization = `Bearer ${spec.credential}`;
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(spec.url, { method: spec.method ?? 'GET', headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body), signal: AbortSignal.timeout(7000), redirect: 'error' });
    const text = await res.text(); assert.ok(text.length <= 1024 * 1024);
    return { status: res.status, headers: Object.fromEntries(res.headers), body: res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  let result;
  if (mode === 'http') result = await http(p);
  else if (mode === 'rpc') result = await rpc(p.socket, p.credential, p.body);
  else if (mode === 'login') {
    const credential = await readFile(p.credentialFile, 'utf8');
    result = await http({ url: p.url, method: 'POST', headers: { Origin: new URL(p.url).origin }, body: { credential } });
  } else if (mode === 'owner-evidence') {
    const config = JSON.parse(await readFile(path.join(p.root, 'executor-config/config.json'), 'utf8'));
    const state = JSON.parse(await readFile(path.join(p.root, 'executor-state/tasks.json'), 'utf8'));
    const submit = await stat(config.submitSocket), admin = await stat(config.adminSocket);
    result = { uid: process.getuid(), tasks: Object.keys(state.tasks).length,
      submit: { uid: submit.uid, gid: submit.gid, mode: submit.mode & 0o777 },
      admin: { uid: admin.uid, gid: admin.gid, mode: admin.mode & 0o777 },
      dockerSocket: (await stat('/var/run/docker.sock')).isSocket() };
  } else if (mode === 'journal') {
    result = JSON.parse(await readFile(path.join(p.root, 'docker-state/tasks.json'), 'utf8'));
  } else if (mode === 'boundaries') {
    assert.equal(process.getuid(), p.uid);
    const failures = [];
    const denied = async (label, action, expected) => {
      try { await action(); throw new Error(`Boundary bypass: ${label}`); }
      catch (e) { assert.ok(expected.includes(e.code), `${label}: unexpected ${e.code ?? e.message}`); failures.push(label); }
    };
    for (const file of [path.join(p.root, 'executor-state/tasks.json'), path.join(p.root, 'executor-config/config.json'),
      path.join(p.root, 'admin-config/credential')]) {
      await denied(`read:${file}`, () => readFile(file), ['EACCES', 'ENOENT']);
      await denied(`write:${file}`, async () => { const h = await open(file, 'r+'); await h.close(); }, ['EACCES', 'ENOENT', 'EROFS']);
    }
    const ownCode = path.join(p.root, 'code/dist/manager/pi-manager-public.mjs');
    assert.ok((await readFile(ownCode)).length > 1000);
    await denied('modify-own-code', async () => { const h = await open(ownCode, 'r+'); await h.close(); }, ['EACCES', 'EROFS']);
    const connect = socket => new Promise((resolve, reject) => {
      const s = createConnection(socket); const timer = setTimeout(() => s.destroy(new Error('Unexpected socket timeout')), 2000);
      s.once('error', e => { clearTimeout(timer); reject(e); });
      s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve(); });
    });
    for (const socket of [path.join(p.root, 'admin-socket/rpc.sock'), '/var/run/docker.sock']) {
      await denied(`connect:${socket}`, () => connect(socket), ['EACCES', 'ENOENT']);
    }
    const positive = await rpc(path.join(p.root, 'submit/rpc.sock'), p.credential, { op: 'capabilities' });
    assert.equal(positive.status, 200); assert.equal(positive.body.docker, true); assert.equal(positive.body.approval, false);
    if (p.workspace) { await writeFile(path.join(p.workspace, 'agent-write'), 'ordinary-agent-write'); assert.equal(await readFile(path.join(p.workspace, 'agent-write'), 'utf8'), 'ordinary-agent-write'); }
    result = { uid: process.getuid(), denied: failures, ownCodeReadable: true, submitReachable: true, workspaceWritable: !!p.workspace };
  } else throw new Error('Unknown probe mode');
  console.log(JSON.stringify(result));
}

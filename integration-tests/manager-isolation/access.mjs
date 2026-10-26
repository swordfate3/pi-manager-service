import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { connectOnly } from './rpc.mjs';

export function boundaryPlan(uid) {
  assert.ok([21002, 21003, 21004].includes(uid), 'Unsupported boundary-probe UID');
  const entry = uid === 21002;
  return {
    workspace: !entry,
    readableFiles: entry ? ['/fixture/role.mjs'] : [],
    allowedSockets: entry ? ['/exec/executor.sock'] : [],
    deniedSockets: ['/admin/approval.sock', ...(entry ? [] : ['/exec/executor.sock']), '/var/run/docker.sock', '/run/docker.sock'],
    privateFiles: ['/private/store/tasks.json', '/private/policy.json', '/private/admin-secret'],
    immutableCode: ['/executor/executor.mjs', '/fixture/role.mjs'],
  };
}

export async function probeBoundaries(uid) {
  const plan = boundaryPlan(uid), results = [];
  async function denied(label, fn, codes) {
    let caught;
    try { await fn(); } catch (error) { caught = error; }
    assert.ok(caught && codes.includes(caught.code), `BOUNDARY BREACH: ${label}; ${caught?.message ?? 'operation succeeded'}`);
    results.push({ label, denied: caught.code });
  }
  if (plan.workspace) {
    await writeFile('/workspace/positive-control', 'workspace write works', { mode: 0o600 });
    assert.equal(await readFile('/workspace/positive-control', 'utf8'), 'workspace write works');
    results.push({ label: 'actual workspace write/read', ok: true });
  }
  for (const file of plan.readableFiles) {
    assert.ok((await readFile(file)).length > 0, 'Expected readable fixture');
    results.push({ label: `fixture read ${file}`, ok: true });
  }
  for (const socket of plan.allowedSockets) {
    await connectOnly(socket);
    results.push({ label: `legitimate connect ${socket}`, ok: true });
  }
  for (const file of plan.privateFiles) {
    await denied(`read ${file}`, () => readFile(file), ['ENOENT', 'EACCES']);
    await denied(`write ${file}`, () => writeFile(file, 'tamper'), ['ENOENT', 'EACCES', 'EROFS']);
  }
  for (const file of plan.immutableCode) {
    await denied(`code write ${file}`, () => writeFile(file, 'tamper'), ['ENOENT', 'EACCES', 'EROFS']);
  }
  for (const socket of plan.deniedSockets) {
    await denied(`connect ${socket}`, () => connectOnly(socket), ['ENOENT', 'EACCES']);
  }
  return results;
}

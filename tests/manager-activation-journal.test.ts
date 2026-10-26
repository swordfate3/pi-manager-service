import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function fixture(t: any) {
  const root = await mkdtemp('/tmp/manager-activation-journal-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'installation');
  const entry = new URL('../manager/updates/activation-journal.ts', import.meta.url);
  const mod = existsSync(entry) ? await import(entry.href) : {};
  assert.equal(typeof mod.ActivationJournal?.create, 'function', 'Updates require a durable private cutover journal');
  const journal = await mod.ActivationJournal.create({ root: state, installationId: 'test-installation' });
  const plan = { operationId: 'a'.repeat(32), taskId: '00000000-0000-4000-8000-000000000001', requester: 'agent',
    policyHash: 'b'.repeat(64), installationId: 'test-installation', expectedRevision: 0,
    candidate: { id: 'c-' + 'c'.repeat(64), receiptHash: 'd'.repeat(64), evidenceHash: 'e'.repeat(64) },
    consumers: [{ instanceId: 'owned-pi', generation: 0, identityHash: '1'.repeat(64), snapshotHash: '2'.repeat(64), captureHash: '3'.repeat(64) }] };
  return { root, state, journal, plan, Journal: mod.ActivationJournal };
}

test('durable plan freezes binding and only exact final readiness can publish the next selection', async t => {
  const f = await fixture(t), original = structuredClone(f.plan);
  const pending = f.journal.stage(f.plan); f.plan.candidate.id = 'c-' + '0'.repeat(64);
  const staged = await pending;
  assert.match(staged.planHash, /^[a-f0-9]{64}$/);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  assert.equal((await f.journal.selection()).revision, 0);
  await assert.rejects(tx.publish(), /stage|sequence/i);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  const selected = await tx.publish();
  assert.equal(selected.revision, 1); assert.deepEqual(selected.candidate, original.candidate);
  assert.equal(selected.operationId, original.operationId);
  assert.equal((await f.journal.inspect(original.operationId)).stage, 'selected');
  assert.equal((await readdir(f.state)).includes('.writer'), false);
  await assert.rejects(f.journal.begin(staged.operationId, staged.planHash));
  const reopened = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  assert.deepEqual(await reopened.selection(), selected);
});

test('one installation transaction excludes concurrent writers and abort is only safe before commit intent', async t => {
  const f = await fixture(t), a = await f.journal.stage(f.plan);
  const b = await f.journal.stage({ ...f.plan, operationId: '4'.repeat(32) });
  const tx = await f.journal.begin(a.operationId, a.planHash);
  await assert.rejects(f.journal.begin(b.operationId, b.planHash));
  await tx.advance('prepared', 'f'.repeat(64)); await tx.abort('5'.repeat(64));
  assert.equal((await f.journal.inspect(a.operationId)).stage, 'aborted');
  assert.equal((await f.journal.selection()).revision, 0);
  const next = await f.journal.begin(b.operationId, b.planHash);
  await next.advance('prepared', 'f'.repeat(64)); await next.advance('commit_intent', 'f'.repeat(64));
  await assert.rejects(next.abort('5'.repeat(64)), /unknown|commit|stage/i);
  await next.unknown('6'.repeat(64));
  assert.equal((await f.journal.inspect(b.operationId)).stage, 'unknown');
  assert.equal((await f.journal.selection()).revision, 0);
  assert.equal((await readdir(f.state)).includes('.writer'), true);
  const reopened = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  await assert.rejects(reopened.begin(b.operationId, b.planHash), /reconciliation|writer|unknown/i);
  assert.equal((await reopened.inspect(b.operationId)).stage, 'unknown');
});

test('closed plans refuse changed installation, duplicate consumers, authority fields and duplicate operation', async t => {
  const f = await fixture(t);
  for (const changed of [{ ...f.plan, argv: ['forbidden'] }, { ...f.plan, installationId: 'other' },
    { ...f.plan, consumers: [f.plan.consumers[0], f.plan.consumers[0]] }, { ...f.plan, expectedRevision: -1 },
    { ...f.plan, consumers: [{ ...f.plan.consumers[0], generation: -1 }] }]) await assert.rejects(f.journal.stage(changed));
  const a = await f.journal.stage(f.plan);
  const before = await readFile(path.join(f.state, a.operationId, 'plan.json'));
  await assert.rejects(f.journal.stage(f.plan));
  assert.deepEqual(await readFile(path.join(f.state, a.operationId, 'plan.json')), before);
  await assert.rejects(f.journal.begin(a.operationId, '0'.repeat(64)));
  assert.equal((await readdir(f.state)).includes('.writer'), false);
});

test('stale selection revision cannot cut over and journal stage sequence cannot be skipped or replayed', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const stale = await f.journal.stage({ ...f.plan, operationId: '4'.repeat(32) });
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  await assert.rejects(tx.advance('stopped', 'f'.repeat(64)), /stage|sequence/i);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  await tx.publish(); await assert.rejects(tx.publish());
  await assert.rejects(f.journal.begin(stale.operationId, stale.planHash), /revision|selection/i);
  assert.equal((await readdir(f.state)).includes('.writer'), false);
});

test('plan tamper, links and nonprivate root refuse without creating stop authority', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const file = path.join(f.state, staged.operationId, 'plan.json');
  await chmod(file, 0o600); await writeFile(file, '{}'); await chmod(file, 0o400);
  await assert.rejects(f.journal.begin(staged.operationId, staged.planHash));
  assert.equal((await f.journal.selection()).revision, 0);
  await chmod(f.state, 0o750); await assert.rejects(f.journal.selection()); await chmod(f.state, 0o700);
  const alias = path.join(f.root, 'alias'); await symlink(f.state, alias);
  await assert.rejects(f.Journal.open({ root: alias, installationId: 'test-installation' }));
});

test('retained partial operations consume fixed quota without cleanup or adoption', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await mkdir(path.join(f.state, i.toString(16).padStart(32, '0')), { mode: 0o700 });
  const before = await readdir(f.state);
  await assert.rejects(f.journal.stage(f.plan), /limit|quota/i);
  assert.deepEqual(await readdir(f.state), before);
});

test('changed durable stage evidence cannot be bypassed by an in-memory transaction', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  await tx.advance('prepared', 'f'.repeat(64));
  const file = path.join(f.state, staged.operationId, '01-prepared.json');
  await chmod(file, 0o600); await writeFile(file, '{}'); await chmod(file, 0o400);
  await assert.rejects(tx.advance('commit_intent', 'f'.repeat(64)), /stage|changed|invalid/i);
  assert.equal((await f.journal.selection()).revision, 0);
  assert.equal((await readdir(f.state)).includes('.writer'), true);
});

test('a replaced canonical transaction directory cannot inherit an active transaction', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  const dir = path.join(f.state, staged.operationId);
  await rename(dir, dir + '.old'); await mkdir(dir, { mode: 0o700 });
  for (const name of await readdir(dir + '.old')) await writeFile(path.join(dir, name), await readFile(path.join(dir + '.old', name)), { mode: 0o400 });
  await assert.rejects(tx.advance('prepared', 'f'.repeat(64)), /changed|identity/i);
  assert.equal((await readdir(dir)).includes('01-prepared.json'), false);
  assert.equal((await f.journal.selection()).revision, 0);
});

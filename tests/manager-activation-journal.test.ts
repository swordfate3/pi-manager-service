import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

test('publication keeps the durable installation fence until every successor admission completes', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(yes => { release = yes; });
  const pending = new Promise<void>(yes => { entered = yes; });
  assert.equal(typeof tx.publishAndAdmit, 'function', 'successor admission needs the same durable installation fence');
  const publication = tx.publishAndAdmit(async (selected: any) => {
    assert.equal(selected.revision, 1);
    assert.deepEqual(await f.journal.selection(), selected, 'selection is durable BEFORE inputs are reopened');
    entered(); await held;
  });
  await pending;
  const fresh = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  await assert.rejects(fresh.stage({ ...f.plan, operationId: '4'.repeat(32), expectedRevision: 1 }), /reconciliation|writer/i);
  await assert.rejects(tx.publishAndAdmit(async () => {}), /unavailable/i);
  assert.equal(existsSync(path.join(f.state, '.reconciliation')), true);
  release(); assert.equal((await publication).revision, 1);
  assert.equal(existsSync(path.join(f.state, '.reconciliation')), false);
  await fresh.stage({ ...f.plan, operationId: '4'.repeat(32), expectedRevision: 1 });
});

test('lost successor admission after durable publication is unknown and never unlocks or replays', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  let admissions = 0;
  assert.equal(typeof tx.publishAndAdmit, 'function');
  await assert.rejects(tx.publishAndAdmit(async () => { admissions++; throw Error('acknowledgement lost'); }), /unknown/i);
  assert.equal(admissions, 1);
  assert.equal((await f.journal.selection()).revision, 1);
  assert.equal((await f.journal.inspect(f.plan.operationId)).stage, 'selected');
  await assert.rejects(tx.publishAndAdmit(async () => { admissions++; }), /unavailable/i);
  const fresh = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  await assert.rejects(fresh.stage({ ...f.plan, operationId: '4'.repeat(32), expectedRevision: 1 }), /reconciliation|writer/i);
  assert.equal(admissions, 1);
});

test('admission callback cannot replace durable selection or release a changed journal', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan);
  const tx = await f.journal.begin(staged.operationId, staged.planHash);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  await assert.rejects(tx.publishAndAdmit(undefined as any), /invalid/i);
  assert.equal((await f.journal.selection()).revision, 0, 'invalid callback refuses before any publication');
  await assert.rejects(tx.publishAndAdmit(async (selected: any) => {
    selected.revision = 100; // Callback receives only a detached value.
    assert.equal((await f.journal.selection()).revision, 1);
    const file = path.join(f.state, f.plan.operationId, '07-selected.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.evidenceHash = '0'.repeat(64);
    await replace(file, JSON.stringify(record));
  }), /unknown/i);
  const fresh = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  await assert.rejects(fresh.stage({ ...f.plan, operationId: '4'.repeat(32), expectedRevision: 1 }), /reconciliation|writer/i);
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

// Test-local facade: every write/open is real. Fail only the selected sync after
// real writeFile has completed; no production injection hooks or fake journal.
function failSync(t: any, matches: (file: string) => boolean) {
  const original = fs.open, handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let failures = 0;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args); handles.push(handle);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (!failures && matches(String(args[0]))) { failures++; throw Object.assign(Error('injected fsync failure'), { code: 'EIO' }); }
      return sync();
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(async () => { mocked.mock.restore(); syncBuiltinESMExports(); await Promise.all(handles.map(h => h.close().catch(() => {}))); });
  return () => failures;
}
async function replace(file: string, bytes: string | Buffer) {
  await chmod(file, 0o600); await writeFile(file, bytes); await chmod(file, 0o400);
}
async function blocked(f: any, planHash: string) {
  const reopened = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  for (const journal of [f.journal, reopened]) {
    assert.equal((await journal.selection()).revision, 0);
    await assert.rejects(journal.stage({ ...f.plan, operationId: '4'.repeat(32) }), /writer|reconciliation|unknown/i);
    await assert.rejects(journal.begin(f.plan.operationId, planHash), /writer|reconciliation|unknown/i);
  }
  assert.equal(existsSync(path.join(f.state, '4'.repeat(32))), false);
}

for (const where of ['plan', 'reservation']) for (const boundary of ['file', 'directory']) test(`persisted ${where} bytes followed by ${boundary} fsync failure cannot be adopted by existing or fresh opener`, async t => {
  const f = await fixture(t);
  const staged = where === 'reservation' ? await f.journal.stage(f.plan) : undefined;
  const target = path.join(f.state, f.plan.operationId, where === 'plan' ? 'plan.json' : '00-reserved.json');
  const failures = failSync(t, file => file === (boundary === 'file' ? target : path.dirname(target)));
  await assert.rejects(where === 'plan' ? f.journal.stage(f.plan) : f.journal.begin(staged.operationId, staged.planHash), /injected|unknown/i);
  assert.equal(failures(), 1);
  const stored = JSON.parse(await readFile(path.join(f.state, f.plan.operationId, 'plan.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(target, 'utf8')).planHash, stored.planHash);
  await blocked(f, stored.planHash);
  assert.equal((await f.journal.inspect(f.plan.operationId)).stage, where === 'plan' ? 'staged' : 'reserved');
});

test('root fsync failure after writer unlink leaves an independent barrier for fresh openers', async t => {
  const f = await fixture(t);
  const failures = failSync(t, file => file === f.state && !existsSync(path.join(f.state, '.writer')));
  await assert.rejects(f.journal.stage(f.plan), /injected|unknown/i);
  assert.equal(failures(), 1); assert.equal(existsSync(path.join(f.state, '.writer')), false);
  const stored = JSON.parse(await readFile(path.join(f.state, f.plan.operationId, 'plan.json'), 'utf8'));
  await blocked(f, stored.planHash);
  assert.equal((await f.journal.inspect(f.plan.operationId)).stage, 'staged');
});

test('abort release root fsync failure blocks fresh mutation even with a complete aborted record', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan), tx = await f.journal.begin(staged.operationId, staged.planHash);
  const failures = failSync(t, file => file === f.state && !existsSync(path.join(f.state, '.writer')));
  await assert.rejects(tx.abort('f'.repeat(64)), /injected|unknown/i);
  assert.equal(failures(), 1); assert.equal(existsSync(path.join(f.state, '.writer')), false);
  assert.equal((await f.journal.inspect(f.plan.operationId)).stage, 'aborted');
  await blocked(f, staged.planHash);
});

test('publish release root fsync failure retains independent barrier after selection is already durable', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan), tx = await f.journal.begin(staged.operationId, staged.planHash);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  const failures = failSync(t, file => file === f.state && !existsSync(path.join(f.state, '.writer')));
  await assert.rejects(tx.publish(), /unknown/i);
  assert.equal(failures(), 1); assert.equal(existsSync(path.join(f.state, '.writer')), false);
  const reopened = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  assert.equal((await reopened.selection()).revision, 1);
  assert.equal((await reopened.inspect(f.plan.operationId)).stage, 'selected');
  await assert.rejects(reopened.stage({ ...f.plan, operationId: '4'.repeat(32), expectedRevision: 1 }), /reconciliation/i);
  await assert.rejects(reopened.begin(staged.operationId, staged.planHash), /reconciliation/i);
  await assert.rejects(tx.publish(), /unavailable|unknown/i);
});

test('successful release allows a fresh opener while a resurrected durable barrier fails closed', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan), tx = await f.journal.begin(staged.operationId, staged.planHash);
  const barrier = await readFile(path.join(f.state, '.reconciliation'));
  await tx.abort('f'.repeat(64));
  const reopened = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  const next = await reopened.stage({ ...f.plan, operationId: '5'.repeat(32) });
  assert.equal((await reopened.inspect(next.operationId)).stage, 'staged');
  // Simulate crash persistence resurrecting the final unsynced barrier unlink.
  await writeFile(path.join(f.state, '.reconciliation'), barrier, { flag: 'wx', mode: 0o400 });
  const recovered = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  assert.equal((await recovered.selection()).revision, 0);
  await assert.rejects(recovered.begin(next.operationId, next.planHash), /reconciliation/i);
  await assert.rejects(recovered.stage({ ...f.plan, operationId: '6'.repeat(32) }), /reconciliation/i);
});

test('a contender paused before exclusive admission cannot strand a writer during another instance release', { timeout: 10_000 }, async t => {
  const f = await fixture(t), contender = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
  const writer = path.join(f.state, '.writer'), marker = path.join(f.state, '.reconciliation');
  let admitReached!: () => void, resumeAdmission!: () => void, releaseReached!: () => void, finishRelease!: () => void;
  const atAdmission = new Promise<void>(resolve => { admitReached = resolve; });
  const allowAdmission = new Promise<void>(resolve => { resumeAdmission = resolve; });
  const atRelease = new Promise<void>(resolve => { releaseReached = resolve; });
  const allowRelease = new Promise<void>(resolve => { finishRelease = resolve; });
  let firstAdmission = true, releasing = false;
  const open = fs.open, unlink = fs.unlink;
  const heldOpen = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    // Pause the contender before its first exclusive lock acquisition. On the
    // old source this is AFTER noBarrier, immediately before creating .writer.
    if (firstAdmission && [writer, marker].includes(String(args[0]))) {
      firstAdmission = false; admitReached(); await allowAdmission;
    }
    return open(...args);
  });
  const heldRelease = t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
    await unlink(...args);
    if (!releasing && String(args[0]) === writer) {
      releasing = true; releaseReached(); await allowRelease;
    }
  });
  syncBuiltinESMExports();
  const loser = contender.stage({ ...f.plan, operationId: '4'.repeat(32) }); void loser.catch(() => {});
  let owner: Promise<any> | undefined;
  try {
    await atAdmission;
    owner = Promise.resolve(f.journal.stage(f.plan)); void owner.catch(() => {});
    await atRelease;
    const ownerMarker = await readFile(marker);
    assert.equal(existsSync(writer), false);
    resumeAdmission();
    await assert.rejects(loser, /writer|reconciliation/i);
    assert.deepEqual(await readFile(marker), ownerMarker, 'Contender must not alter the releasing owner marker');
    finishRelease(); await owner;
    assert.equal(existsSync(path.join(f.state, '4'.repeat(32))), false, 'Refused contender cannot stage an operation');
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(writer), false, 'Healthy contention must not strand a new writer requiring reconciliation');
    const fresh = await f.Journal.open({ root: f.state, installationId: 'test-installation' });
    const next = await fresh.stage({ ...f.plan, operationId: '5'.repeat(32) });
    const tx = await fresh.begin(next.operationId, next.planHash); await tx.abort('6'.repeat(64));
    assert.equal((await fresh.inspect(next.operationId)).stage, 'aborted');
    assert.equal((await fresh.selection()).revision, 0);
  } finally {
    resumeAdmission(); finishRelease(); await Promise.allSettled([loser, ...(owner ? [owner] : [])]);
    heldOpen.mock.restore(); heldRelease.mock.restore(); syncBuiltinESMExports();
  }
});

for (const target of ['.reconciliation', '.writer']) test(`partial acquisition ${target} sync failure retains evidence and blocks fresh mutation`, async t => {
  const f = await fixture(t), file = path.join(f.state, target);
  const failures = failSync(t, candidate => candidate === file);
  await assert.rejects(f.journal.stage(f.plan), /injected/i);
  assert.equal(failures(), 1);
  assert.match(JSON.parse(await readFile(file, 'utf8')).token, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(path.join(f.state, f.plan.operationId)), false);
  await blocked(f, 'f'.repeat(64));
});

test('an unknown preexisting writer is never deleted or adopted by marker-first admission', async t => {
  const f = await fixture(t), writer = path.join(f.state, '.writer');
  const evidence = Buffer.from('unknown exact writer evidence\n');
  await writeFile(writer, evidence, { mode: 0o600, flag: 'wx' });
  await assert.rejects(f.journal.stage(f.plan), /writer|reconciliation/i);
  assert.deepEqual(await readFile(writer), evidence);
  assert.equal(existsSync(path.join(f.state, f.plan.operationId)), false);
  await blocked(f, 'f'.repeat(64));
  assert.deepEqual(await readFile(writer), evidence);
});

for (const changed of ['selection', 'plan']) test(`ready publish ${changed} validation failure permanently poisons retry even after exact bytes restored`, async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan), tx = await f.journal.begin(staged.operationId, staged.planHash);
  for (const stage of ['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready']) await tx.advance(stage, 'f'.repeat(64));
  const file = changed === 'selection' ? path.join(f.state, 'selection.json') : path.join(f.state, staged.operationId, 'plan.json');
  const bytes = await readFile(file), bad = JSON.parse(bytes.toString());
  if (changed === 'selection') Object.assign(bad, { revision: 1, operationId: f.plan.operationId, candidate: f.plan.candidate });
  else bad.plan.requester = 'changed-requester';
  await replace(file, JSON.stringify(bad));
  await assert.rejects(tx.publish(), /selection|plan|unknown/i);
  await replace(file, bytes);
  await assert.rejects(tx.publish(), /unavailable|unknown/i);
  assert.equal((await f.journal.selection()).revision, 0);
  assert.equal(existsSync(path.join(f.state, '.writer')), true);
  await blocked(f, staged.planHash);
});

test('a valid replacement evidence digest cannot rewrite accepted transaction history', async t => {
  const f = await fixture(t), staged = await f.journal.stage(f.plan), tx = await f.journal.begin(staged.operationId, staged.planHash);
  await tx.advance('prepared', 'f'.repeat(64));
  const file = path.join(f.state, staged.operationId, '01-prepared.json');
  const bytes = await readFile(file), changed = JSON.parse(bytes.toString()); changed.evidenceHash = '9'.repeat(64);
  await replace(file, JSON.stringify(changed));
  await assert.rejects(tx.advance('commit_intent', 'f'.repeat(64)), /changed|unknown|invalid/i);
  await replace(file, bytes);
  await assert.rejects(tx.advance('commit_intent', 'f'.repeat(64)), /unavailable|unknown/i);
  assert.equal(existsSync(path.join(f.state, staged.operationId, '02-commit_intent.json')), false);
  await blocked(f, staged.planHash);
});

for (const shape of ['array', 'nested-array', 'boxed-string']) test(`taskId ${shape} is rejected before writer or operation mutation`, async t => {
  const f = await fixture(t), before = await readdir(f.state);
  const taskId = shape === 'array' ? [f.plan.taskId] : shape === 'nested-array' ? [[f.plan.taskId]] : new String(f.plan.taskId);
  await assert.rejects(f.journal.stage({ ...f.plan, taskId }), /plan-invalid/);
  assert.deepEqual(await readdir(f.state), before);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

async function fixture(t: any) {
  const root = await mkdtemp('/tmp/manager-session-capture-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions'), captures = path.join(root, 'captures');
  await mkdir(sessions, { mode: 0o700 }); await mkdir(captures, { mode: 0o700 });
  const source = path.join(sessions, 'dialogue.jsonl');
  const bytes = Buffer.from('{"type":"session","version":3,"id":"test-session","cwd":"/workspace"}\n{"type":"message","id":"leaf","parentId":null,"timestamp":"2026-10-26T00:00:00.000Z","message":{"role":"user","content":"private synthetic dialogue","timestamp":1}}\n');
  await writeFile(source, bytes, { mode: 0o664 }); await chmod(source, 0o664);
  const snapshot = { run_id: 'a'.repeat(32), runtime_id: 'test-runtime', session_id: 'test-session', leaf_id: 'leaf',
    session_file: source, cwd: '/workspace', version: '1.4.0', idle: true, pending: false, busy: false,
    provider: 'test', model: 'fixture', thinking: 'off' };
  const entry = new URL('../manager/updates/session-capture.ts', import.meta.url);
  const mod = existsSync(entry) ? await import(entry.href) : {};
  assert.equal(typeof mod.SessionCapture?.create, 'function', 'Executor must provide bounded real saved-session capture');
  const options = { root: captures, sessionsRoot: sessions, operationId: 'b'.repeat(32), snapshot, expiresAt: performance.now() + 10000 };
  return { root, sessions, captures, source, bytes, snapshot, options, SessionCapture: mod.SessionCapture };
}

test('captures exact private saved dialogue without altering live file or modes and supplies verifier identity', async t => {
  const f = await fixture(t), before = await lstat(f.source);
  const capture = await f.SessionCapture.create(f.options), descriptor = capture.descriptor();
  assert.equal(descriptor.reference, `restore-${'b'.repeat(32)}.jsonl`);
  assert.equal(descriptor.sessionId, 'test-session'); assert.equal(descriptor.leafId, 'leaf');
  assert.equal(descriptor.bytes, f.bytes.length); assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
  assert.equal(descriptor.expiresAt, f.options.expiresAt);
  assert.deepEqual(await readFile(path.join(f.captures, descriptor.reference)), f.bytes);
  assert.equal((await lstat(path.join(f.captures, descriptor.reference))).mode & 0o777, 0o400);
  assert.deepEqual(await readFile(f.source), f.bytes); assert.equal((await lstat(f.source)).mode, before.mode);
  await capture.verify(f.snapshot); capture.fence(f.snapshot);
  assert.equal(JSON.stringify(descriptor).includes(f.root), false, 'External evidence omits private filesystem paths');
});

test('capture freezes caller binding before awaits and duplicate operation never overwrites its copy', async t => {
  const f = await fixture(t), original = structuredClone(f.snapshot);
  const pending = f.SessionCapture.create(f.options); f.snapshot.session_id = 'injected-after-call';
  const capture = await pending;
  assert.equal(capture.descriptor().sessionId, 'test-session');
  await capture.verify(original);
  const copy = path.join(f.captures, capture.descriptor().reference), before = await readFile(copy);
  await assert.rejects(f.SessionCapture.create({ ...f.options, snapshot: original }));
  assert.deepEqual(await readFile(copy), before);
});

test('session header, runtime readiness and deadline mismatches refuse before writing a capture', async t => {
  const f = await fixture(t);
  for (const snapshot of [{ session_id: 'wrong' }, { cwd: '/elsewhere' }, { idle: false }, { pending: true }, { busy: true }]) {
    await assert.rejects(f.SessionCapture.create({ ...f.options, snapshot: { ...f.snapshot, ...snapshot } }));
    assert.deepEqual(await readdir(f.captures), []);
  }
  await assert.rejects(f.SessionCapture.create({ ...f.options, expiresAt: performance.now() - 1 }));
  for (const text of ['{bad}\n', '{"type":"session","version":3,"id":"test-session","id":"test-session","cwd":"/workspace"}\n', 'x'.repeat(65537) + '\n']) {
    await writeFile(f.source, text); await assert.rejects(f.SessionCapture.create(f.options));
  }
  assert.deepEqual(await readdir(f.captures), []);
});

test('changed source, copy, snapshot or original lease deadline invalidates proof before any stop authority', async t => {
  const f = await fixture(t), capture = await f.SessionCapture.create(f.options);
  assert.throws(() => capture.fence({ ...f.snapshot, leaf_id: 'new-leaf' }));
  await writeFile(f.source, Buffer.concat([f.bytes, Buffer.from('\n')]));
  await assert.rejects(capture.verify(f.snapshot)); assert.throws(() => capture.fence(f.snapshot));
  await writeFile(f.source, f.bytes);
  const second = await f.SessionCapture.create({ ...f.options, operationId: 'c'.repeat(32) });
  const copy = path.join(f.captures, second.descriptor().reference);
  await chmod(copy, 0o600); await writeFile(copy, f.bytes);
  await assert.rejects(second.verify(f.snapshot)); assert.throws(() => second.fence(f.snapshot));
});

test('refuses source links, executable files, nonprivate roots and root aliases without adopting paths', async t => {
  const f = await fixture(t);
  await chmod(f.source, 0o764); await assert.rejects(f.SessionCapture.create(f.options)); await chmod(f.source, 0o664);
  await link(f.source, path.join(f.sessions, 'hardlink.jsonl')); await assert.rejects(f.SessionCapture.create(f.options));
  await rm(path.join(f.sessions, 'hardlink.jsonl'));
  const alias = path.join(f.sessions, 'alias.jsonl'); await symlink(f.source, alias);
  await assert.rejects(f.SessionCapture.create({ ...f.options, snapshot: { ...f.snapshot, session_file: alias } }));
  await chmod(f.sessions, 0o750); await assert.rejects(f.SessionCapture.create(f.options)); await chmod(f.sessions, 0o700);
  const rootAlias = path.join(f.root, 'captures-alias'); await symlink(f.captures, rootAlias);
  await assert.rejects(f.SessionCapture.create({ ...f.options, root: rootAlias }));
  const capture = await f.SessionCapture.create(f.options), copy = path.join(f.captures, capture.descriptor().reference);
  await rename(copy, copy + '.old'); await writeFile(copy, f.bytes, { mode: 0o400 });
  await assert.rejects(capture.verify(f.snapshot));
});

test('exclusive capture writer and fixed retained capture quota refuse rather than replay or prune', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.captures, '.writer'), 'incomplete prior operation', { mode: 0o600 });
  await assert.rejects(f.SessionCapture.create(f.options));
  assert.equal(await readFile(path.join(f.captures, '.writer'), 'utf8'), 'incomplete prior operation');
  await rm(path.join(f.captures, '.writer'));
  for (let i = 0; i < 8; i++) await f.SessionCapture.create({ ...f.options, operationId: i.toString(16).padStart(32, '0') });
  await assert.rejects(f.SessionCapture.create(f.options), { code: 'capture-resource-limit' });
  assert.equal((await readdir(f.captures)).filter(n => n.endsWith('.jsonl')).length, 8);
});

test('orphaned capture receipts consume reservations rather than allowing additional operations', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) {
    await writeFile(path.join(f.captures, `restore-${i.toString(16).padStart(32, '0')}.receipt.json`), '{}', { mode: 0o400 });
  }
  await assert.rejects(f.SessionCapture.create(f.options), { code: 'capture-resource-limit' });
  assert.equal((await readdir(f.captures)).length, 8, 'Unknown partials remain available for explicit reconciliation');
});

test('FIFO and sparse oversized input refuse without blocking or copying', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await rm(f.source);
  execFileSync('mkfifo', ['-m', '600', f.source]);
  await assert.rejects(f.SessionCapture.create(f.options), { code: 'capture-file-unsafe' });
  assert.deepEqual(await readdir(f.captures), []);
  await rm(f.source); await writeFile(f.source, f.bytes, { mode: 0o600 });
  await truncate(f.source, 64 * 1024 ** 2 + 1);
  await assert.rejects(f.SessionCapture.create(f.options), { code: 'capture-file-unsafe' });
  assert.deepEqual(await readdir(f.captures), []);
});

test('completed capture cannot renew its original expired lease', async t => {
  const f = await fixture(t), deadline = performance.now() + 1000;
  const capture = await f.SessionCapture.create({ ...f.options, expiresAt: deadline });
  await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - performance.now() + 10)));
  assert.throws(() => capture.fence(f.snapshot), { code: 'capture-expired-or-changed' });
  await assert.rejects(capture.verify(f.snapshot), { code: 'capture-expired-or-changed' });
  assert.equal(capture.descriptor().expiresAt, deadline);
});

test('concurrent writers admit exactly one operation without overwriting either identity', async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([
    f.SessionCapture.create(f.options),
    f.SessionCapture.create({ ...f.options, operationId: 'c'.repeat(32) }),
  ]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(a => a.status === 'rejected').length, 1);
  const files = await readdir(f.captures);
  assert.equal(files.filter(n => n.endsWith('.jsonl')).length, 1);
  assert.equal(files.filter(n => n.endsWith('.receipt.json')).length, 1);
  assert.equal(files.includes('.writer'), false);
});

test('receipt-only duplicate operation refuses before creating any new evidence', async t => {
  const f = await fixture(t), receipt = path.join(f.captures, `restore-${f.options.operationId}.receipt.json`);
  await writeFile(receipt, 'prior unknown operation', { mode: 0o400 });
  const before = await readdir(f.captures);
  await assert.rejects(f.SessionCapture.create(f.options));
  assert.deepEqual(await readdir(f.captures), before);
  assert.equal(await readFile(receipt, 'utf8'), 'prior unknown operation');
});

// A scoped dependency seam schedules the exact filesystem race after the real
// privateRoot validation. The module under test and all filesystem operations
// remain real; no production test hooks or alternate capture implementation.
async function interleavedCapture(t: any, f: Awaited<ReturnType<typeof fixture>>, behavior: string) {
  const facade = path.join(f.root, 'capture-storage-seam.mjs');
  const storage = new URL('../manager/updates/candidate-storage.ts', import.meta.url).href;
  await writeFile(facade, `
    import * as actual from ${JSON.stringify(storage)};
    import {chmod,rename,mkdir,readFile,writeFile} from 'node:fs/promises';
    export const writeNew=actual.writeNew;
    export async function privateRoot(dir){
      await actual.privateRoot(dir);
      if(dir===${JSON.stringify(f.sessions)}){${behavior}}
    }
    export const syncDir=actual.syncDir;
  `, { mode: 0o600 });
  const entry = new URL('../manager/updates/session-capture.ts', import.meta.url);
  entry.searchParams.set('race', randomUUID());
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === entry.href && specifier === './candidate-storage.ts') return next(new URL(`file://${facade}`).href, context);
    return next(specifier, context);
  } });
  t.after(() => hook.deregister());
  return (await import(entry.href)).SessionCapture;
}

test('root becoming nonprivate after validation cannot be adopted as the trusted baseline', async t => {
  const f = await fixture(t);
  const Capture = await interleavedCapture(t, f, 'await chmod(dir,0o750);');
  await assert.rejects(Capture.create(f.options));
  assert.deepEqual(await readdir(f.captures), []);
});

test('canonical private root replacement after validation cannot become the trusted baseline', async t => {
  const f = await fixture(t);
  const Capture = await interleavedCapture(t, f, "await rename(dir,dir+'.previous');await mkdir(dir,{mode:0o700});await writeFile(dir+'/dialogue.jsonl',await readFile(dir+'.previous/dialogue.jsonl'),{mode:0o600});");
  await assert.rejects(Capture.create(f.options));
  assert.deepEqual(await readdir(f.captures), []);
});

test('expiry during asynchronous filesystem validation cannot mint a fresh capture deadline', async t => {
  const f = await fixture(t);
  const Capture = await interleavedCapture(t, f, 'await new Promise(resolve=>setTimeout(resolve,150));');
  await assert.rejects(Capture.create({ ...f.options, expiresAt: performance.now() + 75 }), { code: 'capture-expired' });
  assert.deepEqual(await readdir(f.captures), []);
});

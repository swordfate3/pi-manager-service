import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function api() {
  const m = await import('../manager/updates/compatibility-inputs.ts').catch(() => null);
  assert.ok(m?.sessionIdentity, 'bounded sidecar input validation must exist');
  return m;
}
const header = { type: 'session', version: 3, id: 'saved-session', timestamp: '2026-10-26T00:00:00.000Z', cwd: '/old/disposable' };
const message = { type: 'message', id: 'abc12345', parentId: null, timestamp: header.timestamp,
  message: { role: 'user', content: [{ type: 'text', text: 'saved dialogue' }], timestamp: 1 } };
const session = (...rows: unknown[]) => Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');

test('saved dialogue validation binds exact bytes, identity and leaf; refuses ambiguous or unsupported copies', async () => {
  const m = await api();
  const good = session(header, message), identity = m.sessionIdentity(good);
  assert.equal(identity.sessionId, 'saved-session'); assert.equal(identity.leafId, 'abc12345');
  assert.equal(identity.version, 3);
  for (const bad of [Buffer.alloc(1024 * 1024 + 1), Buffer.from('{}\n'), session({ ...header, version: 999 }, message),
    session(header, message, message), session(header, { ...message, parentId: 'missing' }),
    Buffer.from(good.toString().replace('"version":3', '"version":3,"version":4')), session(header, { type: 'custom', id: 'unknown' })]) {
    assert.throws(() => m.sessionIdentity(bad), /session-invalid/);
  }
  assert.notEqual(m.sessionIdentity(Buffer.from(good.toString().replace('saved dialogue', 'changed dialogue'))).sha256, identity.sha256);
});

test('source inventories hash actual files and reject links, special inputs and oversized files', async t => {
  const m = await api(), root = await mkdtemp('/tmp/compat-input-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'extensions'), { mode: 0o700 }); await writeFile(path.join(root, 'extensions', 'entry.ts'), 'original', { mode: 0o600 });
  const before = await m.inventory(root);
  await writeFile(path.join(root, 'extensions', 'entry.ts'), 'mutation');
  assert.notEqual((await m.inventory(root)).sha256, before.sha256);
  await symlink('/etc/passwd', path.join(root, 'escape'));
  await assert.rejects(m.inventory(root), /input-unsafe/);
});

test('probe output accepts only bounded exact behavioral evidence, never version-only or check-list booleans', async () => {
  const m = await api();
  for (const value of [Buffer.from('{"version":"1.4.0"}'), Buffer.from('{"ok":true,"checks":{"web":true}}'),
    Buffer.alloc(65537), Buffer.from('{"schema":1,"schema":1}'), Buffer.from([0xff])]) {
    assert.throws(() => m.parseProbe(value, {}), /probe-invalid/);
  }
});

test('container mount-boundary tree hashing agrees with installer frozen format and rejects writable drift', async t => {
  const m = await api(), root = await mkdtemp('/tmp/compat-tree-');
  const { chmod } = await import('node:fs/promises');
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'file'), 'abc', { mode: 0o400 }); await chmod(root, 0o500);
  assert.equal(typeof m.candidateTreeHash, 'function', 'container must independently hash the mounted candidate');
  const { treeHash } = await import('../manager/updates/candidate-storage.ts');
  assert.equal(await m.candidateTreeHash(root), await treeHash(root));
  await chmod(path.join(root, 'file'), 0o600);
  await assert.rejects(m.candidateTreeHash(root), /candidate-changed/);
});

test('selected SDK resolver uses ESM import exports rather than the CommonJS require condition', async t => {
  const m = await api(), root = await mkdtemp('/tmp/compat-esm-'); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'node_modules/@earendil-works/pi-coding-agent'); await mkdir(path.join(dir, 'dist'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', exports: { '.': { import: './dist/index.js' } } }), { mode: 0o600 });
  await writeFile(path.join(dir, 'dist/index.js'), '// inert', { mode: 0o600 });
  assert.equal(typeof m.selectedModule, 'function', 'ESM-only selected SDK export must be resolved without executing candidate code');
  assert.equal(await m.selectedModule(root, '@earendil-works/pi-coding-agent'), path.join(dir, 'dist/index.js'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', exports: { '.': { import: '../../escape.js' } } }));
  await assert.rejects(m.selectedModule(root, '@earendil-works/pi-coding-agent'), /sdk-export-invalid/);
});

test('v3 text dialogue retains Pi system text and session name metadata without allowing tool/custom payloads', async () => {
  const m = await api();
  const system = { ...message, id: 'system', message: { role: 'system', content: '', sections: { rules: 'Be concise', tools: '(none)' }, timestamp: 1 } };
  const user = { ...message, parentId: 'system' };
  const info = { type: 'session_info', id: 'named', parentId: message.id, timestamp: header.timestamp, name: 'saved dialogue' };
  const identity = m.sessionIdentity(session(header, system, user, info));
  assert.equal(identity.leafId, 'named'); assert.equal(identity.messages, 1);
  assert.throws(() => m.sessionIdentity(session(header, { ...system, message: { ...system.message, tools: [{ name: 'execute' }] } }, user)), /session-invalid/);
});

// Root only in a disposable, labeled helper with this run's single temporary mount.
import assert from 'node:assert/strict';
import { chmod, chown, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertTemporaryRoot } from './guards.mjs';
const [mode, root, run, hostUid, hostGid] = process.argv.slice(2);
assertTemporaryRoot(root, run);
assert.equal(process.getuid(), 0);
assert.equal(process.versions.node.split('.')[0], '24', 'Unsupported local Node image');
assert.deepEqual(Object.keys(process.env), ['PATH'], 'Inherited image environment must be cleared');
assert.equal(await readFile(path.join(root, 'run-owner'), 'utf8'), run);
assert.equal((await lstat(root)).isSymbolicLink(), false);
const directory = async (name, uid, gid = uid, permissions = 0o700) => {
  const p = path.join(root, name); await mkdir(p, { recursive: true, mode: 0o700 });
  await chown(p, uid, gid); await chmod(p, permissions);
  const actual = await lstat(p);
  assert.equal(actual.mode & 0o7777, permissions, `Provisioned permissions: ${name}`);
  assert.equal(actual.uid, uid); assert.equal(actual.gid, gid);
};
if (mode === 'init') {
  for (const [name, uid] of [['executor-config', 21001], ['executor-state', 21001], ['docker-state', 21001],
    ['public-config', 21002], ['admin-config', 21003], ['agent-work', 21004],
    ['chat-config', 21005], ['chat-state', 21005], ['chat-runtime', 21005]]) await directory(name, uid);
  await directory('submit', 21001, 22002, 0o2750);
  await directory('admin-socket', 21001, 22003, 0o2750);
  await directory('work', 1000, 22001, 0o750);
  await directory('work/project', 1000, 22001, 0o750);
  for (const [name, uid] of [['executor', 21001], ['public', 21002], ['admin', 21003], ['chat', 21005]]) {
    const file = path.join(root, `${name}-config/config.json`);
    await chown(file, uid, uid); await chmod(file, 0o400);
  }
  const credential = path.join(root, 'admin-config/credential');
  await chown(credential, 21003, 21003); await chmod(credential, 0o400);
  console.log(JSON.stringify({ initialized: true }));
} else if (mode === 'collect') {
  // Keep evidence instead of deleting the temporary root. Do not follow links.
  for (const n of [hostUid, hostGid]) assert.match(n, /^\d{1,10}$/);
  async function visit(p) {
    const s = await lstat(p);
    assert.equal(s.isSymbolicLink(), false, 'Unexpected symlink: preserve evidence');
    if (s.isDirectory()) for (const name of await readdir(p)) await visit(path.join(p, name));
    await chown(p, Number(hostUid), Number(hostGid));
  }
  await visit(root); await chmod(root, 0o700);
  console.log(JSON.stringify({ collected: true }));
} else throw new Error('Unknown provisioning operation');

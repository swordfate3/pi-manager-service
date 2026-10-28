// Runs only in an exact labeled disposable helper. Its ONLY mount is the fresh root.
import assert from 'node:assert/strict';
import { chmod, chown, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const [operation, root, nonce] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.match(root, /^\/tmp\/hcpi-[A-Za-z0-9]+$/);
assert.match(nonce, /^[a-f0-9]{32}$/);
assert.equal(await realpath(root), root);
assert.equal(await readFile(path.join(root, 'run-owner'), 'utf8'), nonce);
assert.equal((await lstat(root)).uid, 1000);

async function tree(relative, uid, gid) {
  const p = path.join(root, relative), s = await lstat(p);
  assert.equal(s.isSymbolicLink(), false, 'Do not follow links during ownership restoration');
  if (s.isDirectory()) for (const name of await readdir(p)) await tree(path.join(relative, name), uid, gid);
  await chown(p, uid, gid);
}
async function metadata(name) {
  const s = await lstat(path.join(root, name));
  return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
}
async function ipc(name, uid, gid) {
  await chown(path.join(root, name), uid, gid);
  await chmod(path.join(root, name), 0o2750);
  const actual = await metadata(name);
  assert.deepEqual(actual, { uid, gid, mode: 0o2750 }, `Post-chmod IPC directory ${name}: ${JSON.stringify(actual)}; SGID must not be silently cleared`);
  return actual;
}
if (operation === 'probe-setgid') {
  // Controlled regression: the original capability set lacks FSETID and the
  // helper is deliberately not a member of the foreign target group.
  assert.ok(![process.getgid(), ...process.getgroups()].includes(21002));
  await chown(path.join(root, 'broker'), 1000, 21002);
  await chmod(path.join(root, 'broker'), 0o2750);
  console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), broker: await metadata('broker') }));
} else if (operation === 'prepare') {
  await tree('executor', 21001, 21001);
  const directories = {};
  for (const name of ['submit', 'admin']) directories[name] = await ipc(name, 21001, 1000);
  directories.broker = await ipc('broker', 1000, 21002);
  console.log(JSON.stringify({ prepared: true, directories }));
} else if (operation === 'collect') {
  // Only executor-owned files require restoration; never recurse into packaged symlinks.
  await tree('executor', 1000, 1000);
  for (const name of ['submit', 'admin', 'broker']) {
    await chown(path.join(root, name), 1000, 1000);
    await chmod(path.join(root, name), 0o700);
  }
  console.log(JSON.stringify({ collected: true }));
} else throw new Error('Invalid helper operation');

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepared, IMAGE, DAEMON } from './fixtures.ts';

const cli = (...args: string[]) => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
}).trim();
function snapshot() {
  const ids = cli('ps', '-aq', '--no-trunc').split(/\s+/).filter(Boolean);
  return new Map<string, unknown>(ids.length ? JSON.parse(cli('inspect', ...ids)).map((c: any) => [c.Id, [c.State.StartedAt, c.State.Running, c.RestartCount]]) : []);
}
assert.equal(cli('info', '--format', '{{.ID}}'), DAEMON);
const before = snapshot();
const localOnly = process.argv[2] === '--local-only';
const parent = await mkdtemp(path.join(tmpdir(), 'manager-candidate-acceptance-'));
console.log(JSON.stringify({ acceptanceRoot: parent }));
let succeeded = false;
try {
  const mod = await import('../../manager/updates/candidate.ts').catch(() => null);
  assert.ok(mod?.CandidateInstaller, 'real isolated CandidateInstaller must exist');
  const stageRoot = path.join(parent, 'artifacts');
  const f = await prepared(stageRoot, localOnly ? {} : { dependencies: { 'is-odd': '3.0.1' } });
  const installer = await mod.CandidateInstaller.create({ root: path.join(parent, 'candidates'), preparedRoot: stageRoot, hostPreparedRoot: stageRoot,
    hostWorkerPath: path.resolve('manager/updates/candidate-worker.py'), hostGuardSource: path.resolve('gate/gate/runtime_install.py'),
    image: IMAGE, daemonId: DAEMON, socketPath: '/var/run/docker.sock', network: localOnly ? 'none' : 'host' });
  let result;
  try { result = await installer.install(f.request); }
  catch (error) {
    const candidate = (await readdir(path.join(parent, 'candidates'))).find(n => n.startsWith('c-'));
    if (candidate) console.error('PRIVATE WORKER FAILURE:', await readFile(path.join(parent, 'candidates', candidate, 'failure.json'), 'utf8'));
    throw error;
  }
  assert.equal(result.status, 'installed-unverified'); assert.equal(result.runnable, false); assert.equal(result.activation, 'not-attempted');
  assert.equal(result.lifecycleMarkerAbsent, true);
  const tree = path.join(parent, 'candidates', result.candidateId, 'tree');
  if (!localOnly) {
    assert.equal(JSON.parse(await readFile(path.join(tree, 'node_modules/is-odd/package.json'), 'utf8')).version, '3.0.1');
    assert.equal(JSON.parse(await readFile(path.join(tree, 'node_modules/is-number/package.json'), 'utf8')).version, '6.0.0');
  }
  assert.deepEqual(result.executables.map((e: any) => [e.name, e.relativePath, e.sha256, e.binLink]), [
    ['pi', 'node_modules/@earendil-works/pi-coding-agent/cli.js',
      '5d7c8be59b93a9554926fe530440a42c7d2ba09cd27db43f9b4121927a30ac6f', 'node_modules/.bin/pi']]);
  assert.equal(await readlink(path.join(tree, 'node_modules/.bin/pi')), '../@earendil-works/pi-coding-agent/cli.js');
  await installer.verify(result.candidateId, result.receiptSha256);
  await chmod(tree, 0o700);
  await assert.rejects(installer.verify(result.candidateId, result.receiptSha256), { code: 'content-invalid' });
  await chmod(tree, 0o500);
  await rename(tree, tree + '-original'); await symlink('tree-original', tree);
  try { await assert.rejects(installer.verify(result.candidateId, result.receiptSha256), { code: 'content-invalid' }); }
  finally { await unlink(tree); await rename(tree + '-original', tree); }
  await installer.verify(result.candidateId, result.receiptSha256);
  const receiptPath = path.join(parent, 'candidates', result.candidateId, 'receipt.json');
  const { writeFile } = await import('node:fs/promises');
  await chmod(receiptPath, 0o600);
  await writeFile(receiptPath, JSON.stringify({ ...result, release: { ...result.release, version: '0.0.1' } }));
  await assert.rejects(installer.verify(result.candidateId, result.receiptSha256), { code: 'content-invalid' });
  const { receiptSha256, ...stored } = result;
  await writeFile(receiptPath, JSON.stringify(stored)); await chmod(receiptPath, 0o400);
  const lockPath = path.join(tree, 'package-lock.json'), originalLock = await readFile(lockPath);
  await chmod(lockPath, 0o600); await writeFile(lockPath, '{}'); await chmod(lockPath, 0o400);
  await assert.rejects(installer.verify(result.candidateId, result.receiptSha256), { code: 'content-invalid' });
  await chmod(lockPath, 0o600); await writeFile(lockPath, originalLock); await chmod(lockPath, 0o400);
  await installer.verify(result.candidateId, result.receiptSha256);
  const file = path.join(tree, localOnly ? 'node_modules/@earendil-works/pi-coding-agent/cli.js' : 'node_modules/is-number/index.js');
  await chmod(file, 0o600);
  await writeFile(file, 'tampered'); await chmod(file, 0o400);
  await assert.rejects(installer.verify(result.candidateId, result.receiptSha256), { code: 'content-invalid' });
  await assert.rejects(installer.install(f.request), { code: 'candidate-exists' });
  const owned = JSON.parse(await readFile(path.join(parent, 'candidates', result.candidateId, 'container.json'), 'utf8'));
  console.log(JSON.stringify({ synthetic: result, recursiveDependenciesTested: !localOnly, ownedContainerRemoved: owned.id, receiptReleaseTamperRejected: true,
    lockTamperRejected: true, installedFileTamperRejected: true, rootModeTamperRejected: true, symlinkRootRejected: true,
    installedBinsReconciled: true, replayRejected: true }));
  succeeded = true;
} finally {
  const after = snapshot();
  for (const [id, state] of before) assert.deepEqual(after.get(id), state, `preexisting changed: ${id}`);
  console.log(JSON.stringify({ preexistingUnchanged: before.size, preexistingSnapshot: [...before], newContainers: [...after.keys()].filter(k => !before.has(k)), succeeded }));
  // Retain failures/partials for exact inspection; successful fixtures alone may be removed.
  if (succeeded) {
    async function writable(p: string) { await chmod(p, 0o700); for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await writable(path.join(p, e.name)); }
    await writable(parent); await rm(parent, { recursive: true });
  }
}

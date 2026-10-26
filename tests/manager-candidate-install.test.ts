import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepared, IMAGE, DAEMON } from '../integration-tests/candidate-install/fixtures.ts';
import { dockerDaemon } from './helpers/docker-daemon.ts';
import { ArtifactStager } from '../manager/updates/stage.ts';

async function fixture(t: any, budget?: any) {
  const mod = await import('../manager/updates/candidate.ts').catch(() => null);
  assert.ok(mod?.CandidateInstaller, 'real isolated CandidateInstaller must exist');
  const parent = await mkdtemp(path.join(tmpdir(), 'manager-candidate-test-'));
  t.after(async () => {
    async function writable(p: string) { await chmod(p, 0o700); for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await writable(path.join(p, e.name)); }
    await writable(parent); await rm(parent, { recursive: true, force: true });
  });
  const stageRoot = path.join(parent, 'prepared');
  const f = await prepared(stageRoot);
  const options = { root: path.join(parent, 'candidates'), preparedRoot: stageRoot, hostPreparedRoot: stageRoot,
    hostWorkerPath: path.resolve('manager/updates/candidate-worker.py'), hostGuardSource: path.resolve('gate/gate/runtime_install.py'),
    image: IMAGE, daemonId: DAEMON, socketPath: path.join(parent, 'absent.sock'), network: 'none' as const, budget };
  const installer = await mod.CandidateInstaller.create(options);
  return { ...f, parent, stageRoot, options, installer, mod };
}

test('rejects forged persisted release and prepared references before Docker or candidate writes', async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, expectedIdentity: '0'.repeat(64) },
    { ...f.request, release: { ...f.release, version: '1.0.0' } },
    { ...f.request, preparedKey: '../escape' }, { ...f.request, image: IMAGE }]) {
    await assert.rejects(f.installer.install(request), { code: 'binding-invalid' });
  }
  assert.deepEqual(await readdir(f.options.root), ['policy.json']);
});

test('rehashes real artifact bytes and rechecks persisted receipt rather than trusting shape', async t => {
  for (const name of ['artifact.tgz', 'receipt.json']) {
    const f = await fixture(t);
    const file = path.join(f.stageRoot, f.receipt.candidateKey, name);
    await chmod(file, 0o600);
    await writeFile(file, name === 'artifact.tgz' ? Buffer.from('tampered') : JSON.stringify({ ...f.receipt, contentSha256: '0'.repeat(64) }));
    await chmod(file, 0o400);
    await assert.rejects(f.installer.install(f.request), { code: 'artifact-invalid' });
    assert.deepEqual(await readdir(f.options.root), ['policy.json']);
  }
});

test('root-wide admission counts incomplete directories across IDs and reopen, refuses altered budget', async t => {
  const f = await fixture(t, { maxCandidates: 1 });
  await mkdir(path.join(f.options.root, 'c-' + 'a'.repeat(64)), { mode: 0o700 });
  const reopened = await f.mod.CandidateInstaller.open(f.options);
  await assert.rejects(reopened.install(f.request), { code: 'resource-limit' });
  await assert.rejects(f.mod.CandidateInstaller.open({ ...f.options, budget: { maxCandidates: 2 } }), { code: 'policy-mismatch' });
});

test('root-wide persisted writer lock blocks separate handles and IDs without automatic recovery', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.options.root, '.writer'), 'incomplete', { mode: 0o600 });
  const second = await f.mod.CandidateInstaller.open(f.options);
  await assert.rejects(second.install(f.request), { code: 'writer-busy' });
  await assert.rejects(f.installer.install(f.request), { code: 'writer-busy' });
  assert.equal(await readFile(path.join(f.options.root, '.writer'), 'utf8'), 'incomplete');
});

test('lost Docker create reply retains durable intent and root admission lock; no replay or name adoption', async t => {
  const f = await fixture(t), daemon = await dockerDaemon(t);
  daemon.behavior.loseCreateReply = true;
  const o = { ...f.options, root: path.join(f.parent, 'ambiguous'), socketPath: daemon.socketPath, image: daemon.image, daemonId: daemon.daemonId };
  const installer = await f.mod.CandidateInstaller.create(o);
  await assert.rejects(installer.install(f.request), { code: 'docker-outcome-unknown' });
  const names = await readdir(o.root), candidate = names.find(n => n.startsWith('c-'))!;
  assert.ok(names.includes('.writer')); assert.ok(candidate);
  const intent = JSON.parse(await readFile(path.join(o.root, candidate, 'intent.json'), 'utf8'));
  assert.equal(intent.release.identity, f.release.identity);
  assert.ok(!(await readdir(path.join(o.root, candidate))).includes('receipt.json'));
  const reopened = await f.mod.CandidateInstaller.open(o);
  await assert.rejects(reopened.install(f.request), { code: 'writer-busy' });
  assert.equal(daemon.containers.size, 1, 'unknown result is never recreated or adopted');
  assert.equal(daemon.calls.filter(c => c.method !== 'GET').length, 1);
});

test('simultaneous different installation IDs and separate handles share one durable admission', async t => {
  const f = await fixture(t), daemon = await dockerDaemon(t);
  daemon.behavior.loseCreateReply = true;
  const stager = await ArtifactStager.open({ root: f.stageRoot, transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield f.data; })() }) });
  const secondStage = await stager.stage({ installationId: 'another-install', release: f.release, expectedIdentity: f.release.identity });
  const o = { ...f.options, root: path.join(f.parent, 'concurrent'), socketPath: daemon.socketPath, image: daemon.image, daemonId: daemon.daemonId };
  const first = await f.mod.CandidateInstaller.create(o), second = await f.mod.CandidateInstaller.open(o);
  const results = await Promise.allSettled([first.install(f.request), second.install({ ...f.request, installationId: 'another-install', preparedKey: secondStage.candidateKey })]);
  assert.deepEqual(results.map((r: any) => r.reason?.code).sort(), ['docker-outcome-unknown', 'writer-busy']);
  assert.equal((await readdir(o.root)).filter(n => n.startsWith('c-')).length, 1);
  assert.equal(daemon.containers.size, 1);
});

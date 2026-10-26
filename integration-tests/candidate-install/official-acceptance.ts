/** Explicit opt-in acceptance of the controller's verified 1.4.0 artifact. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CandidateInstaller } from '../../manager/updates/candidate.ts';
import { ArtifactStager } from '../../manager/updates/stage.ts';
import { validateRelease } from '../../manager/updates/release.ts';
import { boundedFile } from '../../manager/updates/candidate-storage.ts';
import { strictJson } from '../../manager/updates/json.ts';
import { IMAGE, DAEMON } from './fixtures.ts';

const original = '/tmp/manager-official-artifacts-PJ4prd/artifacts/85b42e1702877c851eb7412fe958c8fb447c3207b4798fadab42ea8539046ce1/cc8118c0789be893ddd2190eb8558f26b68b22770f42b53f32310032ab5f3bc0';
const sourceReceipt: any = strictJson(await boundedFile(path.join(original, 'receipt.json'), 1024 ** 2));
const release = validateRelease(sourceReceipt.release);
assert.equal(release.identity, 'cc8118c0789be893ddd2190eb8558f26b68b22770f42b53f32310032ab5f3bc0');
assert.equal(release.version, '1.4.0');
const artifact = await boundedFile(path.join(original, 'artifact.tgz'), 32 * 1024 ** 2);
const cli = (...args: string[]) => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 ** 2,
}).trim();
function snapshot() {
  const ids = cli('ps', '-aq', '--no-trunc').split(/\s+/).filter(Boolean);
  return new Map<string, unknown>(ids.length ? JSON.parse(cli('inspect', ...ids)).map((c: any) => [c.Id, [c.State.StartedAt, c.State.Running, c.RestartCount]]) : []);
}
assert.equal(cli('info', '--format', '{{.ID}}'), DAEMON);
const before = snapshot(), parent = await mkdtemp('/tmp/manager-candidate-official-');
console.log(JSON.stringify({ parent, originalArtifact: original, release }));
try {
  // Restaging in a new owned fixture verifies actual SHA512, archive and receipt.
  // No mutation/adoption of the controller's existing artifact or task state.
  const stageRoot = path.join(parent, 'artifacts');
  const stager = await ArtifactStager.create({ root: stageRoot, nodeVersion: '24.21.0', transport: async ({ url, accept }) => {
    assert.equal(url, release.tarball); void accept;
    return { url, statusCode: 200, headers: {}, body: (async function* () { yield artifact; })() };
  } });
  const prepared = await stager.stage({ installationId: 'official-pi-1.4.0', release, expectedIdentity: release.identity });
  assert.equal(prepared.contentSha256, sourceReceipt.contentSha256);
  const installer = await CandidateInstaller.create({ root: path.join(parent, 'candidates'), preparedRoot: stageRoot, hostPreparedRoot: stageRoot,
    hostWorkerPath: path.resolve('manager/updates/candidate-worker.py'), hostGuardSource: path.resolve('gate/gate/runtime_install.py'),
    socketPath: '/var/run/docker.sock', daemonId: DAEMON, image: IMAGE, network: 'host' });
  let result;
  try { result = await installer.install({ installationId: 'official-pi-1.4.0', release, expectedIdentity: release.identity, preparedKey: prepared.candidateKey }); }
  catch (error) {
    const candidate = (await readdir(path.join(parent, 'candidates'))).find(n => n.startsWith('c-'));
    if (candidate) console.error('PRIVATE WORKER FAILURE:', await readFile(path.join(parent, 'candidates', candidate, 'failure.json'), 'utf8').catch(() => 'no failure output'));
    throw error;
  }
  await installer.verify(result.candidateId, result.receiptSha256);
  assert.equal(result.runnable, false); assert.equal(result.status, 'installed-unverified'); assert.equal(result.activation, 'not-attempted');
  console.log(JSON.stringify({ officialCandidate: result }));
} finally {
  const after = snapshot();
  for (const [id, state] of before) assert.deepEqual(after.get(id), state, `preexisting changed: ${id}`);
  console.log(JSON.stringify({ preexistingUnchanged: before.size, newContainers: [...after.keys()].filter(k => !before.has(k)), retainedEvidence: parent }));
}

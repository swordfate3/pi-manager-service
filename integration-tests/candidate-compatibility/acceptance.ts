/** Explicit new-resource acceptance; no default candidate and no source-tree SDK fallback. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CandidateInstaller } from '../../manager/updates/candidate.ts';
import { digest, inventory, webInventory } from '../../manager/updates/compatibility-inputs.ts';

const [candidate, receiptHash, selectedWeb, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === '--saved-fixture');
assert.ok(candidate && path.isAbsolute(candidate) && /^[a-f0-9]{64}$/.test(receiptHash) && selectedWeb && path.isAbsolute(selectedWeb),
  'Required: exact candidate directory, externally persisted receipt hash, explicitly selected thin Web source to pack');
const parent = await mkdtemp('/tmp/manager-compatibility-');
console.log(JSON.stringify({ evidenceRoot: parent, candidate, receiptHash, selectedWeb }));
const run = (file: string, args: string[], cwd?: string) => execFileSync(file, args, {
  cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: parent, NPM_CONFIG_CACHE: path.join(parent, 'cache'), NPM_CONFIG_USERCONFIG: path.join(parent, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(parent, 'global-npmrc'), DOCKER_CONFIG: path.join(parent, 'docker-config') },
  encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 ** 2,
});
const docker = (...args: string[]) => run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args]).trim();
const snapshot = () => {
  const ids = docker('ps', '-aq', '--no-trunc').split(/\s+/).filter(Boolean);
  const containers = ids.length ? JSON.parse(docker('inspect', ...ids)).map((c: any) => ({ id: c.Id, name: c.Name, image: c.Image,
    running: c.State.Running, restarting: c.State.Restarting, startedAt: c.State.StartedAt, finishedAt: c.State.FinishedAt, restartCount: c.RestartCount })) : [];
  containers.sort((a: any, b: any) => a.id.localeCompare(b.id));
  return { containers, images: docker('image', 'ls', '-aq', '--no-trunc').split('\n').sort(), volumes: docker('volume', 'ls', '-q').split('\n').sort(), networks: docker('network', 'ls', '-q', '--no-trunc').split('\n').sort() };
};
const before = snapshot(); await writeFile(path.join(parent, 'before.json'), JSON.stringify(before), { mode: 0o400 });
let behavior: any;
try {
  const { CandidateCompatibility } = await import('../../manager/updates/compatibility.ts');
  const candidateRoot = path.dirname(candidate);
  const policy = JSON.parse(await readFile(path.join(candidateRoot, 'policy.json'), 'utf8'));
  // THIS run's authorization, not a product-wide administrator-policy allowlist.
  assert.equal(policy.daemonId, 'bac0be49-8ddb-4387-83aa-362f70f3ae8d');
  assert.equal(policy.image, 'sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6');
  assert.equal(policy.socketPath, '/var/run/docker.sock');
  const installer = await CandidateInstaller.open(policy);
  const installed = await installer.verify(path.basename(candidate), receiptHash);
  console.log(JSON.stringify({ independentlyVerified: installed.candidateId, version: installed.release.version, tree: installed.contentSha256, lock: installed.lockSha256 }));
  const archiveRoot = path.join(parent, 'archive'); await mkdir(archiveRoot, { mode: 0o700 });
  const pack = JSON.parse(run('/usr/local/bin/npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', archiveRoot], selectedWeb));
  assert.equal(pack.length, 1); assert.match(pack[0].filename, /^[A-Za-z0-9_.-]+\.tgz$/);
  run('/usr/bin/tar', ['-xzf', path.join(archiveRoot, pack[0].filename), '--no-same-owner', '--no-same-permissions', '-C', archiveRoot]);
  const web = path.join(archiveRoot, 'package'), sources = path.join(parent, 'sources'); await mkdir(sources, { mode: 0o700 });
  const origins = ['compatibility-probe.mjs', 'compatibility-provider.mjs', 'compatibility-inputs.ts', 'json.ts'].map(name => path.resolve('manager/updates', name));
  origins.push(path.resolve('runtime/pi_rpc_guard.mjs'));
  const pinned = new Map(await Promise.all(origins.map(async source => [source, digest(await readFile(source))] as const)));
  for (const source of origins) await copyFile(source, path.join(sources, path.basename(source)));
  for (const source of origins) {
    assert.equal(digest(await readFile(source)), pinned.get(source), 'source-pinning-race: wait for controller freeze');
    assert.equal(digest(await readFile(path.join(sources, path.basename(source)))), pinned.get(source), 'source-pinning-race: copied bytes differ');
  }
  async function freeze(p: string) {
    for (const e of await readdir(p, { withFileTypes: true })) {
      assert.ok(e.isDirectory() || e.isFile(), 'no package links/specials');
      const q = path.join(p, e.name); if (e.isDirectory()) await freeze(q); else await chmod(q, 0o400);
    }
    await chmod(p, 0o500);
  }
  await freeze(web); await freeze(sources);
  const webEvidence = await webInventory(web), sourceEvidence = await inventory(sources);
  await writeFile(path.join(parent, 'profiles.json'), JSON.stringify({ archiveSha256: digest(await readFile(path.join(archiveRoot, pack[0].filename))), webEvidence, sourceEvidence }), { mode: 0o400 });
  let session;
  const sessionRoot = path.join(parent, 'saved');
  if (mode === '--saved-fixture') {
    // Generated test data only; not a second live-session capture implementation.
    await mkdir(sessionRoot, { mode: 0o700 });
    const timestamp = '2026-10-26T00:00:00.000Z', sessionId = '00000000-0000-4000-8000-000000000001', leafId = 'eeeeeeee';
    const rows = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd: '/work/restored/workspace' },
      { type: 'model_change', id: 'aaaaaaaa', parentId: null, timestamp, provider: 'compatibility-offline', modelId: 'fixed' },
      { type: 'thinking_level_change', id: 'bbbbbbbb', parentId: 'aaaaaaaa', timestamp, thinkingLevel: 'off' },
      { type: 'message', id: 'cccccccc', parentId: 'bbbbbbbb', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'SAVED_DIALOGUE_MUST_NOT_REPLAY' }], timestamp: 1 } },
      { type: 'message', id: 'dddddddd', parentId: 'cccccccc', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'SAVED_ANSWER' }], api: 'faux', provider: 'compatibility-offline', model: 'fixed', timestamp: 2, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { type: 'session_info', id: leafId, parentId: 'dddddddd', timestamp, name: 'saved fixture' },
    ];
    const bytes = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const reference = 'restore-00000000000000000000000000000001.jsonl';
    await writeFile(path.join(sessionRoot, reference), bytes, { mode: 0o400, flag: 'wx' });
    session = { reference, sha256: digest(bytes), sessionId, leafId };
  }
  const verifier = await CandidateCompatibility.create({ installer, root: path.join(parent, 'evidence'), hostCandidateRoot: candidateRoot,
    web: { root: web, hostRoot: web, sha256: webEvidence.sha256 }, sources: { root: sources, hostRoot: sources, sha256: sourceEvidence.sha256 },
    ...(session ? { sessions: { root: sessionRoot, hostRoot: sessionRoot } } : {}) });
  behavior = await verifier.verify({ candidateId: path.basename(candidate), receiptHash, ...(session ? { session } : {}) });
  console.log(JSON.stringify({ candidateBehavior: behavior }));
} catch (error: any) {
  behavior = { status: 'refused', code: error.code, message: error.message };
  console.error(JSON.stringify({ candidateBehavior: behavior })); process.exitCode = 1;
} finally {
  const after = snapshot(); await writeFile(path.join(parent, 'after.json'), JSON.stringify(after), { mode: 0o400 });
  const changes = before.containers.filter((c: any) => JSON.stringify(after.containers.find((a: any) => a.id === c.id)) !== JSON.stringify(c));
  await writeFile(path.join(parent, 'summary.json'), JSON.stringify({ behavior, preexistingChanged: changes, newContainers: after.containers.filter((a: any) => !before.containers.some((b: any) => a.id === b.id)) }), { mode: 0o400 });
  console.log(JSON.stringify({ retainedEvidence: parent, preexistingChangedIds: changes.map((c: any) => c.id) }));
  // Deliberately strict: concurrent restart-looping Hub is NOT excused or repaired.
  assert.equal(digest(JSON.stringify(after)), digest(JSON.stringify(before)), 'Strict global snapshot failed; see before.json/after.json (candidate behavior is a separate result, not global acceptance)');
}

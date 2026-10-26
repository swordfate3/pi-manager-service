import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DockerEngine, DockerOutcomeUnknownError } from '../backends/docker-engine.ts';
import { checkArchive } from './archive.ts';
import { strictJson } from './json.ts';
import { approvedPackages, validateRelease, type ResolvedRelease } from './release.ts';
import { admit, boundedFile, budget, CandidateError, CandidateReceiver, hash, privateRoot, syncDir, TMPFS_BYTES, treeHash, writeNew, type CandidateBudget } from './candidate-storage.ts';
export { CandidateError } from './candidate-storage.ts';

export interface CandidateOptions {
  readonly root: string; readonly preparedRoot: string; readonly hostPreparedRoot: string;
  readonly hostWorkerPath: string; readonly hostGuardSource: string;
  readonly socketPath: string; readonly daemonId: string; readonly image: string;
  /** Host is explicit egress, NOT network isolation. */
  readonly network: 'none' | 'host'; readonly extensionPackages?: readonly string[]; readonly budget?: Partial<CandidateBudget>;
}
export interface CandidateRequest { readonly installationId: string; readonly release: ResolvedRelease; readonly expectedIdentity: string; readonly preparedKey: string }
function options(value: CandidateOptions) {
  if (!value || Object.keys(value).some(k => !['root', 'preparedRoot', 'hostPreparedRoot', 'hostWorkerPath', 'hostGuardSource', 'socketPath', 'daemonId', 'image', 'network', 'extensionPackages', 'budget'].includes(k))) throw new CandidateError('options-invalid');
  for (const p of [value.root, value.preparedRoot, value.hostPreparedRoot, value.hostWorkerPath, value.hostGuardSource, value.socketPath]) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p === '/' || path.resolve(p) !== p || p.length > 2048 || /[\x00-\x1f]/.test(p)) throw new CandidateError('options-invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.image) || !/^[a-zA-Z0-9-]{1,128}$/.test(value.daemonId) || !['none', 'host'].includes(value.network)) throw new CandidateError('options-invalid');
  approvedPackages(value.extensionPackages);
  return Object.freeze({ ...value, extensionPackages: Object.freeze([...(value.extensionPackages ?? [])]), budget: budget(value.budget) });
}
async function exists(file: string) { try { await lstat(file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
function binding(request: CandidateRequest) {
  try {
    if (!request || Object.keys(request).sort().join() !== 'expectedIdentity,installationId,preparedKey,release' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.installationId)) throw new Error();
    const release = validateRelease(request.release);
    if (release.identity !== request.expectedIdentity || request.preparedKey !== hash(request.installationId) + '/' + release.identity) throw new Error();
    return Object.freeze({ ...request, release });
  } catch { throw new CandidateError('binding-invalid'); }
}

/** Executor-private construction only. No activation, execution or live path API. */
export class CandidateInstaller {
  readonly config: ReturnType<typeof options>;
  readonly inode: number;
  readonly device: number;
  private constructor(config: ReturnType<typeof options>, inode: number, device: number) { this.config = config; this.inode = inode; this.device = device; }
  static async create(value: CandidateOptions) {
    const o = options(value);
    await privateRoot(path.dirname(o.root));
    await mkdir(o.root, { mode: 0o700 });
    await writeNew(path.join(o.root, 'policy.json'), JSON.stringify(o)); await syncDir(o.root); await syncDir(path.dirname(o.root));
    return CandidateInstaller.open(o);
  }
  static async open(value: CandidateOptions) {
    const o = options(value); await privateRoot(o.root);
    const persisted = await boundedFile(path.join(o.root, 'policy.json'), 32768);
    if (persisted.toString() !== JSON.stringify(o)) throw new CandidateError('policy-mismatch');
    const s = await lstat(o.root); return new CandidateInstaller(o, s.ino, s.dev);
  }
  async #root() {
    await privateRoot(this.config.root); const s = await lstat(this.config.root);
    if (s.ino !== this.inode || s.dev !== this.device) throw new CandidateError('root-unsafe');
  }
  async #artifact(request: CandidateRequest) {
    try {
      await privateRoot(this.config.preparedRoot);
      const dir = path.join(this.config.preparedRoot, request.preparedKey);
      if (await realpath(dir) !== dir) throw new Error();
      for (const p of [path.dirname(dir), dir]) { const s = await lstat(p); if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o022)) throw new Error(); }
      const raw = await boundedFile(path.join(dir, 'artifact.tgz'), 32 * 1024 ** 2);
      if ('sha512-' + createHash('sha512').update(raw).digest('base64') !== request.release.integrity) throw new Error();
      const receipt: any = strictJson(await boundedFile(path.join(dir, 'receipt.json'), 1024 ** 2));
      const checked = await checkArchive(raw, request.release);
      const expected = { schema: 1, status: 'prepared-unverified', runnable: false, dependencyClosure: 'not-installed', activation: 'not-attempted',
        candidateKey: request.preparedKey, release: request.release, nodeVersion: receipt.nodeVersion, candidateExecutable: checked.candidateExecutable,
        executables: checked.executables, contentSha256: checked.contentSha256, packageLockSha256: checked.packageLockSha256 };
      if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error();
    } catch { throw new CandidateError('artifact-invalid'); }
  }
  async install(value: CandidateRequest): Promise<any> {
    const request = binding(value), o = this.config;
    if (!approvedPackages(o.extensionPackages).has(request.release.packageName)) throw new CandidateError('binding-invalid');
    await this.#root();
    const lockPath = path.join(o.root, '.writer'); let lock;
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (e: any) { throw new CandidateError(e.code === 'EEXIST' ? 'writer-busy' : 'root-unsafe'); }
    const candidateId = 'c-' + hash(JSON.stringify([request.installationId, request.release.identity]));
    const directory = path.join(o.root, candidateId), engine = new DockerEngine(o.socketPath);
    let container: string | undefined, uncertain = false, receiver: CandidateReceiver | undefined;
    try {
      if (await exists(directory)) throw new CandidateError('candidate-exists');
      await admit(o.root, o.budget);
      await lock.writeFile(JSON.stringify({ candidateId, reservationBytes: TMPFS_BYTES + 514 * 1024 ** 2 })); await lock.sync(); await syncDir(o.root);
      await this.#artifact(request);
      const info: any = await engine.call('GET', '/info'); if (info.ID !== o.daemonId) throw new CandidateError('daemon-mismatch');
      const image: any = await engine.call('GET', '/images/' + encodeURIComponent(o.image) + '/json');
      if (image.Id !== o.image || Object.keys(image.Config?.Volumes ?? {}).length) throw new CandidateError('image-invalid');
      await mkdir(directory, { mode: 0o700 }); await syncDir(o.root);
      const name = 'pi-manager-candidate-' + hash(o.root).slice(0, 12) + '-' + candidateId.slice(2, 26);
      const label = { 'pi.manager.candidate': candidateId, 'pi.manager.candidate.root': hash(o.root) };
      await writeNew(path.join(directory, 'intent.json'), JSON.stringify({ schema: 1, name, image: o.image, daemonId: o.daemonId, labels: label, release: request.release }));
      await syncDir(directory); // Intent precedes ANY Docker mutation. Never retry/adopt names on uncertainty.
      const workerRequest = Buffer.from(JSON.stringify({ release: request.release, candidateId, image: o.image })).toString('base64');
      const spec = { Image: o.image, User: '1000:1000', WorkingDir: '/work', Entrypoint: ['/usr/bin/python3', '-I', '/worker.py'], Cmd: [workerRequest],
        Env: ['HOME=/work/home', 'PATH=/usr/local/bin:/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE=1', 'NPM_CONFIG_USERCONFIG=/work/user.npmrc',
          'NPM_CONFIG_PREFIX=/work/tree', 'GIT_CONFIG_GLOBAL=/dev/null', 'PI_CODING_AGENT_DIR=/work/unused', 'HF_HOME=/work/unused', 'HF_HUB_CACHE=/work/unused'],
        Labels: label, AttachStdout: true, AttachStderr: true, Tty: false, NetworkDisabled: o.network === 'none',
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: o.network,
          Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, NanoCpus: 2e9, PidsLimit: 64, RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'none', Config: {} }, ShmSize: 1024 * 1024,
          Tmpfs: { '/work': `rw,nosuid,nodev,noexec,size=${TMPFS_BYTES},nr_inodes=100000,uid=1000,gid=1000,mode=700` },
          Mounts: [{ Type: 'bind', Source: path.join(o.hostPreparedRoot, request.preparedKey, 'artifact.tgz'), Target: '/input/artifact.tgz', ReadOnly: true },
            { Type: 'bind', Source: o.hostWorkerPath, Target: '/worker.py', ReadOnly: true },
            { Type: 'bind', Source: o.hostGuardSource, Target: '/guard-source.py', ReadOnly: true }] } };
      uncertain = true;
      const created: any = await engine.call('POST', '/containers/create?name=' + name, spec);
      if (!/^[a-f0-9]{64}$/.test(created?.Id)) throw new DockerOutcomeUnknownError();
      container = created.Id;
      await writeNew(path.join(directory, 'container.json'), JSON.stringify({ id: container })); await syncDir(directory);
      await mkdir(path.join(directory, 'tree'), { mode: 0o700 }); receiver = new CandidateReceiver(path.join(directory, 'tree'));
      await this.#run(container!, receiver, directory);
      const done: any = await engine.call('GET', '/containers/' + container + '/json');
      if (done.State?.Running || done.State?.ExitCode !== 0 || done.Image !== o.image || done.Config?.Labels?.['pi.manager.candidate'] !== candidateId) throw new CandidateError('worker-failed');
      const result = await receiver.finish();
      if (result.candidateId !== candidateId || JSON.stringify(result.release) !== JSON.stringify(request.release) || result.image !== o.image ||
        result.status !== 'installed-unverified' || result.runnable !== false || result.activation !== 'not-attempted' || result.lifecycleMarkerAbsent !== true) throw new CandidateError('content-invalid');
      if (await treeHash(path.join(directory, 'tree')) !== result.contentSha256 || hash(await boundedFile(path.join(directory, 'tree/package-lock.json'), 8 * 1024 ** 2)) !== result.lockSha256) throw new CandidateError('content-invalid');
      const receipt = JSON.stringify(result);
      await writeNew(path.join(directory, 'receipt.json'), receipt); await syncDir(directory);
      return Object.freeze({ ...result, receiptSha256: hash(receipt) });
    } catch (e) { throw e instanceof CandidateError ? e : new CandidateError(uncertain ? 'docker-outcome-unknown' : 'docker-unavailable'); }
    finally {
      await receiver?.close();
      if (container) {
        try {
          const info: any = await engine.call('GET', '/info');
          const own: any = await engine.call('GET', '/containers/' + container + '/json');
          if (info.ID !== o.daemonId || own.Id !== container || own.Image !== o.image || own.Config?.Labels?.['pi.manager.candidate'] !== candidateId || own.Config?.Labels?.['pi.manager.candidate.root'] !== hash(o.root)) throw new CandidateError('ownership-unknown');
          await engine.call('DELETE', '/containers/' + container + '?force=true'); uncertain = false;
        } catch { uncertain = true; }
      }
      engine.close();
      try {
        if (!uncertain) {
          await this.#root(); const current = await lstat(lockPath), original = await lock.stat();
          if (current.ino !== original.ino || current.dev !== original.dev) throw new CandidateError('root-unsafe');
          await unlink(lockPath); await syncDir(o.root);
        }
      } finally { await lock.close(); }
      if (uncertain) throw new CandidateError('docker-outcome-unknown');
    }
  }
  async #run(container: string, receiver: CandidateReceiver, directory: string) {
    const child = spawn('/usr/bin/docker', ['--host', 'unix://' + this.config.socketPath, 'start', '-a', container],
      { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined, stderr = 0, bytes = 0;
    const diagnostics: Buffer[] = [];
    const closed = new Promise<number | null>(resolve => { child.once('error', () => { failure = new CandidateError('worker-failed'); resolve(null); }); child.once('close', resolve); });
    const timer = setTimeout(() => { failure = new CandidateError('worker-timeout'); child.kill('SIGKILL'); }, 330000);
    child.stderr.on('data', (b: Buffer) => { stderr += b.length; if (stderr > 65536) { failure = new CandidateError('output-limit'); child.kill('SIGKILL'); } else diagnostics.push(b); });
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        bytes += chunk.length; if (bytes > 768 * 1024 ** 2) throw new CandidateError('output-limit');
        pending = Buffer.concat([pending, chunk]); let end;
        while ((end = pending.indexOf(10)) !== -1) { if (failure) throw failure; await receiver.accept(pending.subarray(0, end)); pending = pending.subarray(end + 1); }
        if (pending.length > 1024 ** 2) throw new CandidateError('output-limit');
      }
      const code = await closed;
      if (failure || code !== 0 || pending.length) {
        await writeNew(path.join(directory, 'failure.json'), JSON.stringify({ code, stderr: Buffer.concat(diagnostics).toString('utf8') }));
        throw failure ?? new CandidateError('worker-failed');
      }
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await closed; }
  }
  /** expectedReceiptSha256 must come from executor-persisted installation evidence. */
  async verify(candidateId: string, expectedReceiptSha256: string): Promise<any> {
    await this.#root();
    if (!/^c-[a-f0-9]{64}$/.test(candidateId) || !/^[a-f0-9]{64}$/.test(expectedReceiptSha256)) throw new CandidateError('binding-invalid');
    try {
      const directory = path.join(this.config.root, candidateId);
      if (await realpath(directory) !== directory) throw new Error();
      const bytes = await boundedFile(path.join(directory, 'receipt.json'), 1024 ** 2);
      if (hash(bytes) !== expectedReceiptSha256) throw new Error();
      const result: any = strictJson(bytes), release = validateRelease(result.release);
      const intent: any = strictJson(await boundedFile(path.join(directory, 'intent.json'), 16384));
      if (JSON.stringify(release) !== JSON.stringify(intent.release) || intent.image !== this.config.image || intent.daemonId !== this.config.daemonId) throw new Error();
      if (result.candidateId !== candidateId || result.image !== this.config.image || result.status !== 'installed-unverified' || result.runnable !== false || result.activation !== 'not-attempted' ||
        await treeHash(path.join(directory, 'tree')) !== result.contentSha256 || hash(await boundedFile(path.join(directory, 'tree/package-lock.json'), 8 * 1024 ** 2)) !== result.lockSha256) throw new Error();
      return Object.freeze({ ...result, receiptSha256: expectedReceiptSha256 });
    } catch { throw new CandidateError('content-invalid'); }
  }
}

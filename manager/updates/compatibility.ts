import cp from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DockerEngine } from '../backends/docker-engine.ts';
import { CandidateInstaller } from './candidate.ts';
import { privateRoot, syncDir, writeNew } from './candidate-storage.ts';
import { absolute, digest, fileBytes, hex, inventory, parseProbe, refuse, sessionIdentity, webInventory } from './compatibility-inputs.ts';

const SOURCE_NAMES = ['compatibility-inputs.ts', 'compatibility-probe.mjs', 'compatibility-provider.mjs', 'json.ts', 'pi_rpc_guard.mjs'];
type Profile = { readonly root: string; readonly hostRoot: string; readonly sha256: string };
export interface CompatibilityOptions {
  readonly installer: CandidateInstaller;
  readonly root: string;
  readonly hostCandidateRoot: string;
  /** Independently unpacked, dependency-free thin Web; peers resolved inside the candidate only. */
  readonly web: Profile;
  /** Private copies of the five shipped files, fixed by administrator identity. */
  readonly sources: Profile;
  /** Optional administrator-owned directory of single-file saved dialogue snapshots. */
  readonly sessions?: { readonly root: string; readonly hostRoot: string };
}
export interface CompatibilityRequest {
  readonly candidateId: string;
  /** Authoritative executor-persisted hash, never read from the candidate receipt. */
  readonly receiptHash: string;
  readonly session?: { readonly reference: string; readonly sha256: string; readonly sessionId: string; readonly leafId: string };
}
function profile(p: Profile) {
  if (!p || Object.keys(p).sort().join() !== 'hostRoot,root,sha256' || !hex(p.sha256)) refuse('options-invalid');
  return Object.freeze({ root: absolute(p.root), hostRoot: absolute(p.hostRoot), sha256: p.sha256 });
}

/** Bounded fixed docker attach, not a caller-selectable process execution seam. */
async function attachProbe(socket: string, id: string) {
  absolute(socket); if (!/^[a-f0-9]{64}$/.test(id)) refuse('request-invalid');
  const child = cp.spawn('/usr/bin/docker', ['--host', 'unix://' + socket, 'start', '-a', id], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }>((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let out = 0, err = 0, failure: string | undefined;
    const stop = (code: string) => { if (!failure) { failure = code; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => stop('probe-timeout'), 90000);
    child.stdout.on('data', (b: Buffer) => { out += b.length; if (out > 65536) stop('output-limit'); else stdout.push(b); });
    child.stderr.on('data', (b: Buffer) => { err += b.length; if (err > 65536) stop('output-limit'); else stderr.push(b); });
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Attach unavailable'), { code: 'docker-outcome-unknown' })); });
    child.once('close', code => {
      clearTimeout(timer);
      const diagnostic = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
      if (failure) reject(Object.assign(new Error(failure), { code: failure, diagnostic })); else resolve(diagnostic);
    });
  });
}

/** No activation API, no live-resource identity, no public task/API registration. */
export class CandidateCompatibility {
  readonly #options: CompatibilityOptions;
  readonly #inode: number;
  readonly #device: number;
  private constructor(o: CompatibilityOptions, inode: number, device: number) { this.#options = o; this.#inode = inode; this.#device = device; }
  static async create(o: CompatibilityOptions) {
    if (!o || Object.keys(o).some(k => !['installer', 'root', 'hostCandidateRoot', 'web', 'sources', 'sessions'].includes(k)) || !(o.installer instanceof CandidateInstaller)) refuse('options-invalid');
    const fixed = Object.freeze({ installer: o.installer, root: absolute(o.root), hostCandidateRoot: absolute(o.hostCandidateRoot), web: profile(o.web), sources: profile(o.sources),
      sessions: o.sessions ? Object.freeze({ root: absolute(o.sessions.root), hostRoot: absolute(o.sessions.hostRoot) }) : undefined });
    if (o.sessions && Object.keys(o.sessions).sort().join() !== 'hostRoot,root') refuse('options-invalid');
    await privateRoot(path.dirname(fixed.root)); await mkdir(fixed.root, { mode: 0o700 });
    await writeNew(path.join(fixed.root, 'policy.json'), JSON.stringify({ ...fixed, installer: fixed.installer.config }));
    await syncDir(fixed.root); const s = await lstat(fixed.root);
    return new CandidateCompatibility(fixed, s.ino, s.dev);
  }
  async #root() {
    const o = this.#options; await privateRoot(o.root); const s = await lstat(o.root);
    if (s.ino !== this.#inode || s.dev !== this.#device) refuse('root-changed');
  }
  async #inputs() {
    const o = this.#options;
    const source = await inventory(o.sources.root);
    if (source.sha256 !== o.sources.sha256 || source.files.map(f => f.path).join() !== SOURCE_NAMES.join()) refuse('source-changed');
    const web = await webInventory(o.web.root); if (web.sha256 !== o.web.sha256) refuse('web-changed');
    return { source, web };
  }
  async verify(value: CompatibilityRequest): Promise<any> {
    if (!value || Object.keys(value).some(k => !['candidateId', 'receiptHash', 'session'].includes(k)) ||
      !/^c-[a-f0-9]{64}$/.test(value.candidateId) || !hex(value.receiptHash)) refuse('request-invalid');
    const request = structuredClone(value), o = this.#options;
    const selectedImage = o.installer.config.image, selectedDaemon = o.installer.config.daemonId;
    if (request.session && (!o.sessions || Object.keys(request.session).sort().join() !== 'leafId,reference,sessionId,sha256' ||
      !/^[A-Za-z0-9_-]{1,64}\.jsonl$/.test(request.session.reference) || !hex(request.session.sha256))) refuse('request-invalid');
    await this.#root();
    let lock;
    try { lock = await open(path.join(o.root, '.writer'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { return refuse('reconciliation-required'); }
    const engine = new DockerEngine(o.installer.config.socketPath);
    let id: string | undefined, uncertain = false, directory: string | undefined, spec: any;
    let evidence: any, failure: any;
    const checkDaemon = async () => {
      const info: any = await engine.call('GET', '/info'); if (info.ID !== selectedDaemon) refuse('daemon-mismatch');
    };
    const owned = async () => {
      await checkDaemon(); const c: any = await engine.call('GET', '/containers/' + id + '/json');
      if (c.Id !== id || c.Image !== selectedImage || c.Config?.User !== '1000:1000' ||
        Object.entries(spec.Labels).some(([k, v]) => c.Config.Labels?.[k] !== v) ||
        JSON.stringify(c.Config.Entrypoint) !== JSON.stringify(spec.Entrypoint) || JSON.stringify(c.Config.Cmd) !== JSON.stringify(spec.Cmd) ||
        !c.HostConfig?.ReadonlyRootfs || c.HostConfig.NetworkMode !== 'none' || c.HostConfig.Privileged === true || c.HostConfig.CapAdd?.length ||
        c.HostConfig.Devices?.length || c.HostConfig.DeviceRequests?.length || c.HostConfig.PidMode === 'host' || c.HostConfig.IpcMode === 'host' ||
        JSON.stringify(c.HostConfig.CapDrop) !== '["ALL"]' || !c.HostConfig.SecurityOpt?.includes('no-new-privileges') ||
        c.HostConfig.Memory !== spec.HostConfig.Memory || c.HostConfig.MemorySwap !== spec.HostConfig.MemorySwap || c.HostConfig.PidsLimit !== spec.HostConfig.PidsLimit ||
        c.HostConfig.NanoCpus !== spec.HostConfig.NanoCpus || c.HostConfig.LogConfig?.Type !== 'none' ||
        JSON.stringify(c.HostConfig.Tmpfs) !== JSON.stringify(spec.HostConfig.Tmpfs) ||
        c.Mounts?.length !== spec.HostConfig.Mounts.length || c.Mounts.some((m: any) => !spec.HostConfig.Mounts.some((s: any) => m.Type === 'bind' && m.Source === s.Source && m.Destination === s.Target && m.RW === false))) refuse('ownership-unknown');
      return c;
    };
    try {
      // Revalidation does not execute candidate code. It precedes ALL Docker mutations.
      const receipt = await o.installer.verify(request.candidateId, request.receiptHash);
      if (receipt.release.packageName !== '@earendil-works/pi-coding-agent') refuse('candidate-unsupported');
      const inputs = await this.#inputs();
      let session: ReturnType<typeof sessionIdentity> | undefined;
      const checkSession = async () => {
        if (!request.session) return undefined;
        await privateRoot(o.sessions!.root);
        const s = sessionIdentity(await fileBytes(path.join(o.sessions!.root, request.session.reference)));
        if (s.sha256 !== request.session.sha256 || s.sessionId !== request.session.sessionId || s.leafId !== request.session.leafId) refuse('session-changed');
        return s;
      };
      session = await checkSession();
      const cli = receipt.executables.find((x: any) => x.name === 'pi' && x.relativePath === 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
      if (!cli || !hex(cli.sha256)) refuse('candidate-unsupported');
      // At most 16 attempts; bounded stdout/stderr JSON escaping fits below 1 MiB
      // per attempt, plus fixed policy. No automatic pruning or result adoption.
      if ((await readdir(o.root)).length >= 18) refuse('evidence-limit');
      const binding = { candidateId: request.candidateId, receiptHash: request.receiptHash, release: receipt.release, treeSha256: receipt.contentSha256,
        lockSha256: receipt.lockSha256, cli, node: receipt.node, image: selectedImage, daemon: selectedDaemon,
        webSha256: inputs.web.sha256, webSourceSha256: inputs.web.sourceSha256, webOutputSha256: inputs.web.outputSha256,
        sourceSha256: inputs.source.sha256, session: session ?? null };
      const attempt = 'v-' + digest(JSON.stringify(binding)), nonce = randomBytes(16).toString('hex');
      const attemptDirectory = path.join(o.root, attempt);
      try { await mkdir(attemptDirectory, { mode: 0o700 }); }
      catch (e: any) { if (e.code === 'EEXIST') refuse('evidence-exists'); throw e; }
      directory = attemptDirectory;
      const labels = { 'pi.manager.compatibility': attempt, 'pi.manager.compatibility.root': digest(o.root), 'pi.manager.compatibility.nonce': nonce };
      const name = 'pi-manager-compat-' + nonce;
      await lock.writeFile(JSON.stringify({ attempt, name })); await lock.sync();
      await writeNew(path.join(directory, 'intent.json'), JSON.stringify({ binding, name, labels })); await syncDir(directory); await syncDir(o.root);
      await checkDaemon(); const image: any = await engine.call('GET', '/images/' + encodeURIComponent(selectedImage) + '/json');
      if (image.Id !== selectedImage || Object.keys(image.Config?.Volumes ?? {}).length) refuse('image-mismatch');
      const mount = (Source: string, Target: string) => ({ Type: 'bind', Source, Target, ReadOnly: true, BindOptions: { Propagation: 'rprivate', NonRecursive: true } });
      spec = { Image: selectedImage, User: '1000:1000', WorkingDir: '/work',
        Entrypoint: ['/usr/local/bin/node', '/probe/compatibility-probe.mjs'], Cmd: [Buffer.from(JSON.stringify(binding)).toString('base64')],
        Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work/home', 'TMPDIR=/work/tmp', 'NODE_OPTIONS=', 'NODE_PATH=', 'PI_OFFLINE=1', 'PI_SKIP_VERSION_CHECK=1'],
        Labels: labels, AttachStdout: true, AttachStderr: true, Tty: false, NetworkDisabled: true, Healthcheck: { Test: ['NONE'] },
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'none',
          Memory: 1024 ** 3, MemorySwap: 1024 ** 3, NanoCpus: 1e9, PidsLimit: 64, ShmSize: 1024 ** 2,
          RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none', Config: {} },
          Tmpfs: { '/work': 'rw,nosuid,nodev,noexec,size=268435456,nr_inodes=30000,uid=1000,gid=1000,mode=700' },
          Mounts: [mount(path.join(o.hostCandidateRoot, request.candidateId, 'tree'), '/candidate'), mount(o.web.hostRoot, '/web-input'),
            ...SOURCE_NAMES.map(n => mount(path.join(o.sources.hostRoot, n), '/probe/' + n)),
            ...(request.session ? [mount(path.join(o.sessions!.hostRoot, request.session.reference), '/saved.jsonl')] : [])] } };
      uncertain = true;
      const created: any = await engine.call('POST', '/containers/create?name=' + name, spec);
      if (!/^[a-f0-9]{64}$/.test(created?.Id)) refuse('docker-outcome-unknown');
      id = created.Id;
      await writeNew(path.join(directory, 'container.json'), JSON.stringify({ id })); await syncDir(directory);
      await owned(); uncertain = false;
      let output;
      try { output = await attachProbe(o.installer.config.socketPath, id!); }
      catch (e: any) { if (e.code === 'docker-outcome-unknown') uncertain = true; if (e.diagnostic) await writeNew(path.join(directory, 'output.json'), JSON.stringify({ ...e.diagnostic, stdout: e.diagnostic.stdout.toString(), stderr: e.diagnostic.stderr.toString() })); throw e; }
      await writeNew(path.join(directory, 'output.json'), JSON.stringify({ code: output.code, stdout: output.stdout.toString(), stderr: output.stderr.toString() }));
      const stopped = await owned();
      if (output.code !== 0 && (stopped.State?.Running || stopped.State?.ExitCode !== output.code)) {
        uncertain = true; refuse('docker-outcome-unknown');
      }
      if (stopped.State?.Running || stopped.State?.ExitCode !== 0 || output.code !== 0) refuse('behavior-incompatible');
      evidence = parseProbe(output.stdout, binding);
      // Both sides of execution are checked, including supplied session copy and packed Web/source identity.
      await o.installer.verify(request.candidateId, request.receiptHash); await this.#inputs(); await checkSession();
    } catch (e: any) {
      failure = e;
      if (directory) await writeNew(path.join(directory, 'failure.json'), JSON.stringify({ code: e.code ?? 'probe-failed' })).catch(() => { uncertain = true; });
    } finally {
      if (id && !uncertain) {
        try { await owned(); await engine.call('DELETE', '/containers/' + id + '?force=true'); }
        catch { uncertain = true; }
      }
      engine.close();
      try {
        if (!uncertain) {
          await this.#root(); const current = await lstat(path.join(o.root, '.writer')), original = await lock.stat();
          if (current.ino !== original.ino || current.dev !== original.dev) refuse('root-changed');
          await unlink(path.join(o.root, '.writer')); await syncDir(o.root);
        }
      } catch { uncertain = true; } finally { await lock.close(); }
    }
    if (uncertain) return refuse('docker-outcome-unknown');
    if (failure) throw failure;
    const result = { ...evidence, runnable: false, activation: 'not-attempted', updates: false, webDispatchEligibility: 'permanently-tainted-after-void-send', ownedContainerRemoved: true };
    await writeNew(path.join(directory!, 'evidence.json'), JSON.stringify(result)); await syncDir(directory!);
    return Object.freeze({ ...result, evidenceKey: path.basename(directory!), evidenceSha256: digest(JSON.stringify(result)) });
  }
}

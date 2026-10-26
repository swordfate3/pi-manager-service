import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_LIMITS, checkArchive, type CandidateExecutable } from "./archive.ts";
import { checkNodeEngine } from "./engine.ts";
import { StageError } from "./errors.ts";
import { GLOBAL_WRITER, RECEIPT_BYTES, ROOT_MARKER, quotaMarker, readQuotaMarker,
  reserveCandidate, stagingQuota, type StagingQuota } from "./quota.ts";
import { approvedPackages, validateRelease, type ResolvedRelease } from "./release.ts";
import { boundedDownload, type OfficialTransport } from "./transport.ts";
export { StageError } from "./errors.ts";
export type { StagingQuota } from "./quota.ts";

export interface StagerOptions {
  /** Administrator-selected NEW directory with an existing trusted canonical parent. No live install root. */
  readonly root: string;
  readonly extensionPackages?: readonly string[];
  /** Administrator's intended runtime version; defaults to this executor's Node, never a candidate probe. */
  readonly nodeVersion?: string;
  readonly transport?: OfficialTransport;
  /** Administrator-only shared retained-state policy. Persisted at create; open may only match it. */
  readonly quota?: Partial<StagingQuota>;
}
export interface StageRequest { readonly installationId: string; readonly release: ResolvedRelease; readonly expectedIdentity: string }
export interface PreparedArtifact {
  readonly schema: 1;
  readonly status: "prepared-unverified";
  readonly runnable: false;
  readonly dependencyClosure: "not-installed";
  readonly activation: "not-attempted";
  /** Relative to the executor-private root; never an absolute public/private host path. */
  readonly candidateKey: string;
  readonly release: ResolvedRelease;
  readonly nodeVersion: string;
  readonly candidateExecutable: string | null;
  readonly executables: readonly CandidateExecutable[];
  readonly contentSha256: string;
  /** Hash of a lockfile IN THE ARTIFACT, if any. Not proof of installed dependencies. */
  readonly packageLockSha256: string | null;
}
function snapshotOptions(options: StagerOptions): StagerOptions {
  if (!options || typeof options !== "object" || Reflect.ownKeys(options).some(key =>
    typeof key !== "string" || !["root", "extensionPackages", "nodeVersion", "transport", "quota"].includes(key))) throw new StageError("options-invalid");
  const quota = options.quota === undefined ? undefined : stagingQuota(options.quota);
  if (typeof options.root !== "string" || (options.nodeVersion !== undefined &&
    (typeof options.nodeVersion !== "string" || options.nodeVersion.length > 64)) ||
    (options.transport !== undefined && typeof options.transport !== "function")) throw new StageError("options-invalid");
  approvedPackages(options.extensionPackages);
  return Object.freeze({ ...options, extensionPackages: Object.freeze([...(options.extensionPackages ?? [])]), quota });
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
function privateDirectory(info: Stats) {
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new StageError("root-unsafe");
}
async function canonicalParent(root: string): Promise<void> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root || root.length > 2048 || root.includes("\0")) throw new StageError("root-unsafe");
  const parent = path.dirname(root);
  if (await realpath(parent) !== parent) throw new StageError("root-unsafe");
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022)) throw new StageError("root-unsafe");
  // User/mount namespaces may map the system root owner to an overflow UID.
  const systemUid = (await lstat(path.parse(root).root)).uid;
  for (let ancestor = parent;; ancestor = path.dirname(ancestor)) {
    const info = await lstat(ancestor);
    const stickyRootOwned = info.uid === systemUid && !!(info.mode & 0o1000);
    if (!info.isDirectory() || (info.uid !== systemUid && info.uid !== process.getuid?.()) || ((info.mode & 0o022) && !stickyRootOwned)) throw new StageError("root-unsafe");
    if (ancestor === path.dirname(ancestor)) break;
  }
}
async function writeNew(file: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); await handle.chmod(0o400); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Artifact-only, executor-private. No candidate execution, npm, activation, live path or rollback API. */
export class ArtifactStager {
  readonly #root: string;
  readonly #identity: Stats;
  readonly #packages: ReadonlySet<string>;
  readonly #nodeVersion: string;
  readonly #transport?: OfficialTransport;
  readonly #quota: StagingQuota;
  private constructor(options: StagerOptions, identity: Stats, quota: StagingQuota) {
    this.#root = options.root; this.#identity = identity; this.#packages = approvedPackages(options.extensionPackages);
    this.#nodeVersion = options.nodeVersion ?? process.versions.node; this.#transport = options.transport;
    this.#quota = quota;
  }
  static async create(options: StagerOptions): Promise<ArtifactStager> {
    options = snapshotOptions(options);
    try {
      approvedPackages(options.extensionPackages);
      await canonicalParent(options.root);
      await mkdir(options.root, { mode: 0o700 }); // exclusive; never reuse a live/installed directory
      await writeNew(path.join(options.root, ROOT_MARKER), quotaMarker(stagingQuota(options.quota)));
      await syncDirectory(options.root); await syncDirectory(path.dirname(options.root));
      return await ArtifactStager.open(options);
    } catch { throw new StageError("root-unsafe"); }
  }
  static async open(options: StagerOptions): Promise<ArtifactStager> {
    options = snapshotOptions(options);
    try {
      await canonicalParent(options.root);
      const info = await lstat(options.root); privateDirectory(info);
      if (await realpath(options.root) !== options.root) throw new StageError("root-unsafe");
      const handle = await open(path.join(options.root, ROOT_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
      let quota: StagingQuota;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o400 || stat.size > 1024) throw new StageError("root-unsafe");
        const buffer = Buffer.alloc(1025);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new StageError("root-unsafe");
        quota = readQuotaMarker(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await handle.close(); }
      if (options.quota !== undefined && quotaMarker(stagingQuota(options.quota)) !== quotaMarker(quota)) throw new StageError("options-invalid");
      return new ArtifactStager(options, info, quota);
    } catch (error) { if (error instanceof StageError && error.code === "options-invalid") throw error; throw new StageError("root-unsafe"); }
  }
  async #checkRoot(): Promise<void> {
    try {
      await canonicalParent(this.#root);
      const stat = await lstat(this.#root); privateDirectory(stat);
      if (!same(stat, this.#identity) || await realpath(this.#root) !== this.#root) throw new StageError("root-unsafe");
    } catch { throw new StageError("root-unsafe"); }
  }
  async stage(request: StageRequest): Promise<PreparedArtifact> {
    // Capture immutable inputs before any await. The identity is supplied from executor-persisted task binding.
    if (!request || typeof request !== "object" || Reflect.ownKeys(request).some(key =>
      typeof key !== "string" || !["installationId", "release", "expectedIdentity"].includes(key))) throw new StageError("release-invalid");
    const { installationId, expectedIdentity } = request;
    if (typeof installationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(installationId)) throw new StageError("invalid-installation");
    let release: ResolvedRelease;
    try { release = validateRelease(request.release); if (release.identity !== expectedIdentity) throw new Error(); }
    catch { throw new StageError("release-invalid"); }
    if (!this.#packages.has(release.packageName)) throw new StageError("package-not-approved");
    checkNodeEngine(release.nodeEngine, this.#nodeVersion);
    await this.#checkRoot();
    const installKey = hash(installationId), lockPath = path.join(this.#root, `.${installKey}.lock`);
    const globalPath = path.join(this.#root, GLOBAL_WRITER);
    const locks: { handle: FileHandle; file: string }[] = [];
    try { locks.push({ handle: await open(globalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), file: globalPath }); }
    catch (error) { throw new StageError(code(error) === "EEXIST" ? "writer-busy" : "stage-io"); }
    try {
      try { locks.push({ handle: await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), file: lockPath }); }
      catch (error) { throw new StageError(code(error) === "EEXIST" ? "writer-busy" : "stage-io"); }
      const candidateKey = `${installKey}/${release.identity}`, candidate = path.join(this.#root, candidateKey);
      try { await lstat(candidate); throw new StageError("stage-exists"); }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      await reserveCandidate(this.#root, this.#quota);
      await syncDirectory(this.#root); // Persist admission before substantial work; never reclaim unknown locks.
      let artifact: Buffer;
      try { artifact = await boundedDownload(release.tarball, ARCHIVE_LIMITS.artifactBytes, 30_000, this.#transport); }
      catch { throw new StageError("download-failed"); }
      const digest = createHash("sha512").update(artifact).digest("base64");
      if (`sha512-${digest}` !== release.integrity) throw new StageError("integrity-mismatch");
      const checked = await checkArchive(artifact, release);
      const result: PreparedArtifact = Object.freeze({ schema: 1, status: "prepared-unverified", runnable: false,
        dependencyClosure: "not-installed", activation: "not-attempted", candidateKey, release, nodeVersion: this.#nodeVersion,
        candidateExecutable: checked.candidateExecutable, executables: checked.executables, contentSha256: checked.contentSha256,
        packageLockSha256: checked.packageLockSha256 });
      const receipt = JSON.stringify(result) + "\n";
      if (Buffer.byteLength(receipt) > RECEIPT_BYTES) throw new StageError("resource-limit");
      await this.#checkRoot();
      const installation = path.join(this.#root, installKey);
      try { await mkdir(installation, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
      privateDirectory(await lstat(installation));
      try { await mkdir(candidate, { mode: 0o700 }); } catch (error) { if (code(error) === "EEXIST") throw new StageError("stage-exists"); throw error; }
      // On IO/crash leave the exclusively-created directory for explicit reconciliation, never overwrite/replay it.
      await writeNew(path.join(candidate, "artifact.tgz"), artifact);
      for (const entry of checked.entries) {
        const target = path.join(candidate, entry.name);
        if (entry.directory) await mkdir(target, { mode: 0o700 });
        else await writeNew(target, entry.data);
      }
      for (const entry of [...checked.entries].reverse()) if (entry.directory) {
        await chmod(path.join(candidate, entry.name), 0o500); await syncDirectory(path.join(candidate, entry.name));
      }
      await writeNew(path.join(candidate, "receipt.json"), receipt);
      await chmod(candidate, 0o500); await syncDirectory(candidate); await syncDirectory(installation); await syncDirectory(this.#root);
      return result;
    } catch (error) { throw error instanceof StageError ? error : new StageError("stage-io"); }
    finally {
      try {
        await this.#checkRoot();
        for (const lock of [...locks].reverse()) {
          const own = await lock.handle.stat(), current = await lstat(lock.file);
          if (!same(own, current)) throw new StageError("root-unsafe");
          await unlink(lock.file);
        }
        await syncDirectory(this.#root);
      } catch { throw new StageError("root-unsafe"); }
      finally { await Promise.all(locks.map(lock => lock.handle.close())); }
    }
  }
}

import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { NativeRuntimeSnapshot } from '../backends/native.ts';
import { canonical } from '../validation.ts';
import { privateRoot, syncDir, writeNew } from './candidate-storage.ts';
import { record, strictJson } from './json.ts';

const MAX_BYTES = 64 * 1024 ** 2, MAX_RETAINED = 512 * 1024 ** 2, MAX_RECEIPT = 16384;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fail = (code: string): never => { throw Object.assign(new Error(`Session capture refused: ${code}`), { code }); };
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const absolute = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) === p && p !== '/' && p.length <= 4096 && !/\p{Cc}/u.test(p);

function rootIdentity(directory: string): string {
  const root = lstatSync(directory, { bigint: true });
  const uid = BigInt(process.getuid!()), system = lstatSync('/', { bigint: true }).uid;
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o7777n) !== 0o700n ||
    realpathSync(directory) !== directory) fail('capture-root-changed');
  for (let dir = path.dirname(directory);; dir = path.dirname(dir)) {
    const s = lstatSync(dir, { bigint: true });
    if (!s.isDirectory() || (s.uid !== uid && s.uid !== system) ||
      ((s.mode & 0o022n) !== 0n && !(s.uid === system && (s.mode & 0o1000n) !== 0n))) fail('capture-root-changed');
    if (dir === '/') break;
  }
  return `${root.dev}:${root.ino}:${root.mode}:${root.uid}`;
}

export interface CaptureOptions {
  readonly root: string;
  readonly sessionsRoot: string;
  readonly snapshot: NativeRuntimeSnapshot;
  readonly operationId: string;
  /** Original proven lease deadline in this process's performance.now() coordinates. Never renewed here. */
  readonly expiresAt: number;
}
export interface CaptureDescriptor {
  readonly reference: string; readonly sha256: string; readonly bytes: number;
  readonly sessionId: string; readonly leafId: string | null; readonly expiresAt: number;
}

function options(value: CaptureOptions): CaptureOptions {
  if (!value || Object.keys(value).sort().join() !== 'expiresAt,operationId,root,sessionsRoot,snapshot') fail('capture-options-invalid');
  const o = structuredClone(value), s = o.snapshot;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
  if (!absolute(o.root) || !absolute(o.sessionsRoot) || o.root === o.sessionsRoot ||
    o.root.startsWith(o.sessionsRoot + path.sep) || o.sessionsRoot.startsWith(o.root + path.sep) ||
    !/^[a-f0-9]{32}$/.test(o.operationId) || !Number.isFinite(o.expiresAt) ||
    o.expiresAt <= performance.now() || o.expiresAt > performance.now() + 150000 || !s ||
    Object.keys(s).sort().join() !== 'busy,cwd,idle,leaf_id,model,pending,provider,run_id,runtime_id,session_file,session_id,thinking,version' ||
    !id(s.runtime_id) || !id(s.session_id) || (s.leaf_id !== null && !id(s.leaf_id)) || !/^[a-f0-9]{32}$/.test(s.run_id) ||
    !id(s.version) || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(s.version) ||
    !id(s.thinking) || (s.provider !== null && !id(s.provider)) || (s.model !== null && !id(s.model)) ||
    !absolute(s.cwd) || !absolute(s.session_file) || path.dirname(s.session_file) !== o.sessionsRoot ||
    s.idle !== true || s.pending !== false || s.busy !== false) fail('capture-options-invalid');
  return Object.freeze({ ...o, snapshot: Object.freeze(s) });
}

/** O_NONBLOCK prevents a substituted FIFO from waiting for an external writer. */
async function bytes(file: string, copy = false) {
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await f.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n ||
      before.size < 1n || before.size > BigInt(MAX_BYTES) || (before.mode & 0o7111n) !== 0n ||
      (copy && (before.mode & 0o7777n) !== 0o400n) ||
      identity(await lstat(file, { bigint: true })) !== identity(before) || await realpath(file) !== file) fail('capture-file-unsafe');
    const data = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await f.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== Number(before.size) || identity(await f.stat({ bigint: true })) !== identity(before) ||
      identity(await lstat(file, { bigint: true })) !== identity(before)) fail('capture-file-changed');
    return { data: data.subarray(0, offset), identity: identity(before) };
  } finally { await f.close(); }
}

async function admission(root: string, operationId: string) {
  const reservations = new Set<string>();
  let size = 0, entries = 0;
  for await (const e of await opendir(root, { bufferSize: 1 })) {
    if (++entries > 25) fail('capture-resource-limit');
    const s = await lstat(path.join(root, e.name));
    if (!e.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 0o7111) || (s.mode & 0o022) ||
      !/^(?:\.writer|restore-[a-f0-9]{32}\.(?:jsonl|receipt\.json))$/.test(e.name)) fail('capture-root-unsafe');
    if (e.name !== '.writer') {
      const prefix = e.name.slice(0, 40);
      if (prefix === `restore-${operationId}`) fail('capture-operation-exists');
      reservations.add(prefix);
    }
    size += s.size;
    if (size + MAX_BYTES + MAX_RECEIPT > MAX_RETAINED || reservations.size >= 8) fail('capture-resource-limit');
  }
}

/** Byte capture only: the caller separately owns input-lease, compatibility and stop authorization. */
export class SessionCapture {
  readonly #options: CaptureOptions;
  readonly #sourceIdentity: string;
  readonly #copyIdentity: string;
  readonly #rootIdentity: string;
  readonly #sessionRootIdentity: string;
  readonly #descriptor: CaptureDescriptor;
  private constructor(o: CaptureOptions, source: string, copy: string, roots: [string, string], descriptor: CaptureDescriptor) {
    this.#options = o; this.#sourceIdentity = source; this.#copyIdentity = copy;
    [this.#rootIdentity, this.#sessionRootIdentity] = roots; this.#descriptor = Object.freeze(descriptor);
  }
  static async create(value: CaptureOptions): Promise<SessionCapture> {
    // Snapshot and deadline are copied before the first await.
    const o = options(value);
    const roots: [string, string] = [rootIdentity(o.root), rootIdentity(o.sessionsRoot)];
    await privateRoot(o.root); await privateRoot(o.sessionsRoot);
    if (rootIdentity(o.root) !== roots[0] || rootIdentity(o.sessionsRoot) !== roots[1]) fail('capture-root-changed');
    const lockPath = path.join(o.root, '.writer');
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await lock.writeFile(JSON.stringify({ operationId: o.operationId })); await lock.sync(); await syncDir(o.root);
      await admission(o.root, o.operationId);
      const source = await bytes(o.snapshot.session_file!);
      const newline = source.data.indexOf(10);
      if (newline < 1 || newline > 65536) fail('capture-header-invalid');
      const header = strictJson(source.data.subarray(0, newline));
      if (!record(header) || header.type !== 'session' || !Number.isSafeInteger(header.version) || (header.version as number) < 1 ||
        header.id !== o.snapshot.session_id || header.cwd !== o.snapshot.cwd) fail('capture-header-invalid');
      if (performance.now() >= o.expiresAt) fail('capture-expired');
      const descriptor: CaptureDescriptor = { reference: `restore-${o.operationId}.jsonl`, sha256: sha256(source.data), bytes: source.data.length,
        sessionId: o.snapshot.session_id, leafId: o.snapshot.leaf_id, expiresAt: o.expiresAt };
      const copy = path.join(o.root, descriptor.reference);
      await writeNew(copy, source.data);
      const copyIdentity = identity(await lstat(copy, { bigint: true }));
      const receipt = JSON.stringify({ schema: 1, descriptor, operationId: o.operationId, snapshot: o.snapshot,
        sourceIdentity: source.identity, copyIdentity });
      if (Buffer.byteLength(receipt) > MAX_RECEIPT) fail('capture-resource-limit');
      await writeNew(path.join(o.root, `restore-${o.operationId}.receipt.json`), receipt);
      await syncDir(o.root);
      const capture = new SessionCapture(o, source.identity, copyIdentity, roots, descriptor);
      await capture.verify(o.snapshot);
      return capture;
    } finally {
      try {
        const current = await lstat(lockPath), original = await lock.stat();
        if (current.ino !== original.ino || current.dev !== original.dev || !current.isFile()) fail('capture-lock-changed');
        await unlink(lockPath); await syncDir(o.root);
      } finally { await lock.close(); }
    }
  }
  descriptor(): CaptureDescriptor { return Object.freeze({ ...this.#descriptor }); }
  /** Synchronous short final check; perform expensive content verification before a fresh live runtime handshake. */
  fence(snapshot: NativeRuntimeSnapshot): void {
    const o = this.#options;
    if (performance.now() >= o.expiresAt || canonical(snapshot) !== canonical(o.snapshot)) fail('capture-expired-or-changed');
    for (const [dir, expected] of [[o.root, this.#rootIdentity], [o.sessionsRoot, this.#sessionRootIdentity]]) {
      if (rootIdentity(dir!) !== expected) fail('capture-root-changed');
    }
    if (identity(lstatSync(o.snapshot.session_file!, { bigint: true })) !== this.#sourceIdentity ||
      identity(lstatSync(path.join(o.root, this.#descriptor.reference), { bigint: true })) !== this.#copyIdentity ||
      performance.now() >= o.expiresAt) fail('capture-file-changed');
  }
  async verify(snapshot: NativeRuntimeSnapshot): Promise<void> {
    this.fence(snapshot);
    const source = await bytes(this.#options.snapshot.session_file!);
    if (source.identity !== this.#sourceIdentity || sha256(source.data) !== this.#descriptor.sha256) fail('capture-content-changed');
    const copy = await bytes(path.join(this.#options.root, this.#descriptor.reference), true);
    if (copy.identity !== this.#copyIdentity || sha256(copy.data) !== this.#descriptor.sha256) fail('capture-content-changed');
    this.fence(snapshot);
  }
}

import { randomBytes } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../validation.ts';
import { boundedFile, hash, privateRoot, syncDir, writeNew } from './candidate-storage.ts';
import { record, strictJson } from './json.ts';

function fail(reason: string): never { throw Error(`Activation journal refused: ${reason}`); }
const hex = (x: unknown, n = 64): x is string => typeof x === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const fields = (x: unknown, keys: string): x is Record<string, any> => record(x) && Object.keys(x).sort().join() === keys;
const stages = ['reserved', 'prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready', 'selected'] as const;
type Stage = typeof stages[number] | 'aborted' | 'unknown';
type Candidate = { readonly id: string; readonly receiptHash: string; readonly evidenceHash: string };
export interface ActivationPlan {
  readonly operationId: string; readonly taskId: string; readonly requester: string; readonly policyHash: string;
  readonly installationId: string; readonly expectedRevision: number; readonly candidate: Candidate;
  readonly consumers: readonly { readonly instanceId: string; readonly generation: number;
    readonly identityHash: string; readonly snapshotHash: string; readonly captureHash: string }[];
}
export interface InstallationSelection {
  readonly schema: 1; readonly installationId: string; readonly revision: number;
  readonly operationId: string | null; readonly candidate: Candidate | null;
}
export interface ActivationTransaction {
  advance(stage: Exclude<Stage, 'reserved' | 'selected' | 'aborted' | 'unknown'>, evidenceHash: string): Promise<void>;
  publish(): Promise<InstallationSelection>;
  abort(evidenceHash: string): Promise<void>;
  unknown(evidenceHash: string): Promise<void>;
}
function candidate(value: unknown): value is Candidate {
  return fields(value, 'evidenceHash,id,receiptHash') && typeof value.id === 'string' && /^c-[a-f0-9]{64}$/.test(value.id) && hex(value.receiptHash) && hex(value.evidenceHash);
}
function plan(value: unknown, installation: string): ActivationPlan {
  if (!fields(value, 'candidate,consumers,expectedRevision,installationId,operationId,policyHash,requester,taskId') ||
    !hex(value.operationId, 32) || typeof value.taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.taskId) ||
    !identifier(value.requester) || !hex(value.policyHash) || value.installationId !== installation ||
    !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !candidate(value.candidate) || !Array.isArray(value.consumers) || value.consumers.length > 32) fail('plan-invalid');
  const seen = new Set<string>();
  for (const c of value.consumers) {
    if (!fields(c, 'captureHash,generation,identityHash,instanceId,snapshotHash') || !identifier(c.instanceId) || seen.has(c.instanceId) ||
      !Number.isSafeInteger(c.generation) || c.generation < 0 || !hex(c.identityHash) || !hex(c.snapshotHash) || !hex(c.captureHash)) fail('plan-invalid');
    seen.add(c.instanceId);
  }
  const copy = structuredClone(value) as ActivationPlan;
  if (Buffer.byteLength(canonical(copy)) > 60000) fail('plan-limit');
  return copy;
}
function rootIdentity(root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/' || /\p{Cc}/u.test(root) || realpathSync(root) !== root) fail('root-invalid');
  const s = lstatSync(root), uid = process.getuid?.(), system = lstatSync('/').uid;
  if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o7777) !== 0o700) fail('root-invalid');
  for (let dir = path.dirname(root);; dir = path.dirname(dir)) {
    const p = lstatSync(dir);
    if (!p.isDirectory() || (p.uid !== uid && p.uid !== system) || ((p.mode & 0o022) && !(p.uid === system && (p.mode & 0o1000)))) fail('root-invalid');
    if (dir === '/') break;
  }
  return `${s.dev}:${s.ino}:${s.mode}:${s.uid}`;
}
function options(value: { root: string; installationId: string }) {
  if (!fields(value, 'installationId,root') || !identifier(value.installationId) || typeof value.root !== 'string' ||
    value.root.length > 4096 || !path.isAbsolute(value.root) || path.resolve(value.root) !== value.root || value.root === '/' || /\p{Cc}/u.test(value.root)) fail('options-invalid');
  return Object.freeze({ ...value });
}
type Lock = { file: FileHandle; dev: number; ino: number; barrierDev: number; barrierIno: number };

/** Private transaction evidence only. TaskStore remains the sole task queue and approval authority. */
export class ActivationJournal {
  readonly #root: string; readonly #installation: string; readonly #identity: string;
  #busy = false;
  private constructor(root: string, installation: string) { this.#root = root; this.#installation = installation; this.#identity = rootIdentity(root); }
  static async create(value: { root: string; installationId: string }) {
    const o = options(value);
    await privateRoot(path.dirname(o.root)); await mkdir(o.root, { mode: 0o700 });
    const journal = new ActivationJournal(o.root, o.installationId);
    await writeNew(path.join(o.root, 'selection.json'), JSON.stringify({ schema: 1, installationId: o.installationId, revision: 0, operationId: null, candidate: null }));
    await syncDir(o.root); await syncDir(path.dirname(o.root));
    return journal;
  }
  static async open(value: { root: string; installationId: string }) {
    const o = options(value), journal = new ActivationJournal(o.root, o.installationId);
    await journal.selection(); return journal;
  }
  #fence() { if (rootIdentity(this.#root) !== this.#identity) fail('root-changed'); }
  async #read(file: string): Promise<any> {
    this.#fence();
    const parent = path.dirname(file);
    const parentIdentity = parent !== this.#root ? rootIdentity(parent) : this.#identity;
    const data = await boundedFile(file, 65536), parsed = strictJson(data);
    this.#fence(); if (rootIdentity(parent) !== parentIdentity) fail('directory-identity-changed');
    return parsed;
  }
  async selection(): Promise<InstallationSelection> {
    const s = await this.#read(path.join(this.#root, 'selection.json'));
    if (!fields(s, 'candidate,installationId,operationId,revision,schema') || s.schema !== 1 || s.installationId !== this.#installation ||
      !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      (s.revision === 0 ? s.operationId !== null || s.candidate !== null : !hex(s.operationId, 32) || !candidate(s.candidate))) fail('selection-invalid');
    return structuredClone(s) as InstallationSelection;
  }
  async #quota() {
    let total = 0, count = 0, entries = 0;
    for await (const e of await opendir(this.#root, { bufferSize: 1 })) {
      if (++entries > 19) fail('quota-limit');
      const p = path.join(this.#root, e.name), s = await lstat(p);
      if (e.isDirectory() && hex(e.name, 32)) {
        if (++count >= 16) fail('quota-limit'); rootIdentity(p);
        let childCount = 0;
        for await (const child of await opendir(p, { bufferSize: 1 })) {
          if (++childCount > 11) fail('quota-limit');
          const f = await lstat(path.join(p, child.name));
          if (!f.isFile() || f.nlink !== 1 || f.uid !== process.getuid?.() || (f.mode & 0o7222) || f.size > 65536 ||
            !/^(?:plan\.json|[0-9]{2}-(?:reserved|prepared|commit_intent|committed|stopped|started|ready|selected|aborted|unknown)\.json)$/.test(child.name)) fail('state-invalid');
          total += f.size;
          if (total + 1024 ** 2 > 16 * 1024 ** 2) fail('quota-limit');
        }
      } else if (!['selection.json', '.writer', '.reconciliation'].includes(e.name) || !s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o022) || s.size > 65536) fail('state-invalid');
    }
  }
  async #lock(): Promise<Lock> {
    if (this.#busy) fail('writer-reconciliation-required');
    this.#busy = true;
    let file: FileHandle | undefined, barrier: FileHandle | undefined;
    try {
      this.#fence();
      // Exclusive marker creation is admission, not an observation followed by
      // writer creation. A releasing owner keeps this gate until its LAST unlink,
      // so a contender cannot create a writer in that owner's release window.
      barrier = await open(path.join(this.#root, '.reconciliation'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const b = await barrier.stat(), token = JSON.stringify({ token: randomBytes(32).toString('hex') });
      await barrier.writeFile(token); await barrier.sync(); await barrier.chmod(0o400); await barrier.close();
      file = await open(path.join(this.#root, '.writer'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const s = await file.stat();
      await file.writeFile(token); await file.sync();
      await syncDir(this.#root); this.#fence();
      const lock = { file, dev: s.dev, ino: s.ino, barrierDev: b.dev, barrierIno: b.ino };
      this.#barrier(lock);
      return lock;
    } catch (e) {
      // Only close handles acquired here. A failed exclusive gate creates
      // nothing; any partial acquisition retains its marker/writer for explicit
      // reconciliation, including a preexisting unknown writer. Never delete it.
      await file?.close().catch(() => {}); await barrier?.close().catch(() => {});
      this.#busy = file !== undefined || barrier !== undefined;
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('writer-reconciliation-required');
      throw e;
    }
  }
  #barrier(lock: Lock) {
    const s = lstatSync(path.join(this.#root, '.reconciliation'));
    if (!s.isFile() || s.nlink !== 1 || s.dev !== lock.barrierDev || s.ino !== lock.barrierIno) fail('reconciliation-barrier-changed');
  }
  async #retain(lock: Lock) { this.#busy = true; await lock.file.close().catch(() => {}); }
  async #unlock(lock: Lock) {
    try {
      this.#fence(); this.#barrier(lock); const s = await lstat(path.join(this.#root, '.writer'));
      if (!s.isFile() || s.nlink !== 1 || s.dev !== lock.dev || s.ino !== lock.ino) fail('writer-changed');
      await unlink(path.join(this.#root, '.writer')); await syncDir(this.#root);
      await lock.file.close(); this.#fence(); this.#barrier(lock);
      // All state and writer removal are durable BEFORE this release point.
      // No fallible operation/fsync follows barrier unlink. Its removal need not
      // survive a crash: resurrection only blocks admission (safe reconciliation),
      // whereas absence means every preceding durability boundary succeeded.
      await unlink(path.join(this.#root, '.reconciliation')); this.#busy = false;
    } catch (e) { await this.#retain(lock); throw e; }
  }
  async stage(value: ActivationPlan) {
    const p = plan(value, this.#installation), planHash = hash(canonical(p));
    const lock = await this.#lock();
    let mutated = false;
    try {
      await this.#quota(); this.#fence();
      const dir = path.join(this.#root, p.operationId);
      mutated = true;
      try { await mkdir(dir, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') mutated = false; throw e; }
      await writeNew(path.join(dir, 'plan.json'), JSON.stringify({ schema: 1, plan: p, planHash }));
      await syncDir(dir); await syncDir(this.#root); this.#fence();
      await this.#unlock(lock);
      return Object.freeze({ operationId: p.operationId, planHash });
    } catch (e) {
      if (mutated) await this.#retain(lock); else await this.#unlock(lock);
      throw e;
    }
  }
  async #plan(operation: string, expectedHash?: string) {
    if (!hex(operation, 32) || (expectedHash !== undefined && !hex(expectedHash))) fail('plan-invalid');
    const dir = path.join(this.#root, operation), value = await this.#read(path.join(dir, 'plan.json'));
    if (!fields(value, 'plan,planHash,schema') || value.schema !== 1) fail('plan-invalid');
    const p = plan(value.plan, this.#installation), actualHash = hash(canonical(p));
    if (p.operationId !== operation || value.planHash !== actualHash || (expectedHash !== undefined && actualHash !== expectedHash)) fail('plan-changed');
    return { p, planHash: actualHash, dir };
  }
  async inspect(operation: string): Promise<{ stage: Stage | 'staged'; planHash: string }> {
    const { stage, planHash } = await this.#history(operation); return { stage, planHash };
  }
  async #history(operation: string) {
    const { planHash, dir } = await this.#plan(operation);
    const names: string[] = [];
    for await (const e of await opendir(dir, { bufferSize: 1 })) {
      if (e.name !== 'plan.json') names.push(e.name);
      if (names.length > 9) fail('stage-limit');
    }
    names.sort();
    let stage: Stage | 'staged' = 'staged';
    const digests: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const e = await this.#read(path.join(dir, names[i]));
      if (!fields(e, 'evidenceHash,planHash,sequence,stage') || e.sequence !== i || e.planHash !== planHash || !hex(e.evidenceHash) ||
        (e.stage !== stages[i] && !['aborted', 'unknown'].includes(e.stage)) ||
        names[i] !== `${String(i).padStart(2, '0')}-${e.stage}.json` || ['aborted', 'unknown', 'selected'].includes(stage)) fail('stage-invalid');
      if ((e.stage === 'aborted' && (i < 1 || i > 2)) || (e.stage === 'unknown' && i < 1)) fail('stage-invalid');
      stage = e.stage;
      digests.push(hash(canonical(e)));
    }
    return { stage, planHash, digests };
  }
  async begin(operation: string, expectedHash: string): Promise<ActivationTransaction> {
    if (!hex(operation, 32) || !hex(expectedHash)) fail('plan-invalid');
    const lock = await this.#lock();
    let p: ActivationPlan, planHash: string, dir: string, original: InstallationSelection, directoryIdentity: string;
    let reservationAttempted = false;
    const history: string[] = [];
    try {
      ({ p, planHash, dir } = await this.#plan(operation, expectedHash));
      original = await this.selection();
      if (original.revision !== p.expectedRevision) fail('selection-revision-changed');
      if ((await this.inspect(operation)).stage !== 'staged') fail('stage-replay-refused');
      directoryIdentity = rootIdentity(dir);
      const reserved = { sequence: 0, stage: 'reserved', planHash, evidenceHash: expectedHash };
      reservationAttempted = true;
      await writeNew(path.join(dir, '00-reserved.json'), JSON.stringify(reserved)); await syncDir(dir);
      this.#fence(); if (rootIdentity(dir) !== directoryIdentity) fail('directory-identity-changed');
      history.push(hash(canonical(reserved)));
    } catch (e) { if (reservationAttempted) await this.#retain(lock); else await this.#unlock(lock); throw e; }
    const transactionFence = () => {
      this.#fence();
      if (rootIdentity(dir) !== directoryIdentity) fail('directory-identity-changed');
      this.#barrier(lock);
      const s = lstatSync(path.join(this.#root, '.writer'));
      if (!s.isFile() || s.nlink !== 1 || s.dev !== lock.dev || s.ino !== lock.ino) fail('writer-changed');
    };
    let current: Stage = 'reserved', sequence = 0, active = true, pending = false;
    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!active || pending) fail('stage-transaction-unavailable');
      pending = true;
      try { return await fn(); }
      finally { pending = false; }
    };
    const event = async (next: Stage, evidenceHash: string) => {
      if (!hex(evidenceHash)) fail('evidence-invalid');
      try {
        transactionFence();
        await this.#plan(operation, expectedHash);
        const observed = await this.#history(operation);
        if (observed.stage !== current || canonical(observed.digests) !== canonical(history)) fail('stage-content-changed');
        transactionFence();
        const accepted = { sequence: sequence + 1, stage: next, planHash, evidenceHash };
        await writeNew(path.join(dir, `${String(sequence + 1).padStart(2, '0')}-${next}.json`), JSON.stringify(accepted));
        await syncDir(dir); transactionFence(); sequence++; current = next;
        history.push(hash(canonical(accepted)));
      } catch { active = false; await this.#retain(lock); fail('unknown-changed-or-invalid-durable-outcome'); }
    };
    return Object.freeze({
      advance: (next, evidenceHash) => run(async () => {
        if (!['prepared', 'commit_intent', 'committed', 'stopped', 'started', 'ready'].includes(next) ||
          next !== stages[stages.findIndex(stage => stage === current) + 1]) fail('stage-sequence-invalid');
        await event(next, evidenceHash);
      }),
      abort: (evidenceHash) => run(async () => {
        if (!['reserved', 'prepared'].includes(current)) fail('commit-stage-requires-unknown');
        await event('aborted', evidenceHash); active = false; await this.#unlock(lock);
      }),
      unknown: (evidenceHash) => run(async () => {
        await event('unknown', evidenceHash); active = false; await lock.file.close();
        // Intentionally retain .writer and busy state for explicit reconciliation.
      }),
      publish: () => run(async () => {
        if (current !== 'ready') fail('stage-not-ready');
        try {
          transactionFence();
          const observed = await this.selection();
          if (canonical(observed) !== canonical(original)) fail('selection-revision-changed');
          await this.#plan(operation, expectedHash);
          const accepted = await this.#history(operation);
          if (accepted.stage !== 'ready' || canonical(accepted.digests) !== canonical(history)) fail('stage-content-changed');
          const selected: InstallationSelection = { schema: 1, installationId: this.#installation, revision: original.revision + 1, operationId: operation, candidate: p.candidate };
          const temp = path.join(this.#root, `.selection-${operation}.tmp`);
          await writeNew(temp, JSON.stringify(selected)); transactionFence();
          await rename(temp, path.join(this.#root, 'selection.json')); await syncDir(this.#root);
          await event('selected', hash(canonical(selected)));
          active = false; await this.#unlock(lock);
          return structuredClone(selected);
        } catch { active = false; await this.#retain(lock); fail('unknown-selection-outcome'); }
      }),
    } satisfies ActivationTransaction);
  }
}

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { NativeBackend, type NativeBackendConfig, type NativeCreateRequest, type NativeIdentity, type NativeRuntimeSnapshot } from '../backends/native.ts';
import type { TaskRecord } from '../contracts.ts';
import { ExecutionOutcomeUnknownError } from '../errors.ts';
import { canonical } from '../validation.ts';
import { ActivationJournal, type ActivationTransaction, type InstallationSelection } from './activation-journal.ts';
import { CandidateInstaller } from './candidate.ts';
import { hash, privateRoot, syncDir, writeNew } from './candidate-storage.ts';
import { digest, fileBytes, hex, webInventory } from './compatibility-inputs.ts';
import { checkNodeEngine } from './engine.ts';
import { NativeCandidateCompatibility, type NativeCompatibilityProof } from './native-compatibility.ts';
import type { SessionCapture } from './session-capture.ts';

const CLI = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
function fail(code: string): never { throw Object.assign(Error(`Native installation refused: ${code}`), { code }); }
const object = (v: any, fields: string): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === fields;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
type Consumer = { request: NativeCreateRequest; identity: NativeIdentity; backend: NativeBackend; selectionRevision: number };
type PendingConsumer = Pick<Consumer, 'request' | 'backend' | 'selectionRevision'>;
interface SelectedInputs {
  request: UpdateRequest; executable: string;
  webRoot: string; webIdentity: string; files: { path: string; sha256: string }[];
  peers: { name: string; target: string }[];
}
type Inventory = { instanceId: string; generation: number; identityHash: string }[];
interface UpdateRequest {
  candidateId: string; receiptHash: string; releaseIdentity: string; version: string;
  expectedRevision: number; consumers: Inventory;
}
interface Options {
  readonly root: string; readonly installationId: string; readonly policyHash: string;
  readonly installer: CandidateInstaller; readonly native: NativeBackendConfig;
  readonly web: { readonly root: string; readonly sha256: string }; readonly trustedLocal: true;
}
interface Held {
  consumer: Consumer; snapshot: NativeRuntimeSnapshot; operation: string; capturesRoot: string;
  capture?: SessionCapture; verifier?: NativeCandidateCompatibility; proof?: NativeCompatibilityProof;
  successor?: Consumer; successorSnapshot?: NativeRuntimeSnapshot;
}

/** Executor-private sole lifecycle owner for one native installation. Not an
 * approval endpoint: the authoritative TaskEngine must authorize the stored task
 * before calling activate. New roots only; never reconstruct/adopt live PIDs or
 * automatically reconcile an interrupted activation. Same UID is trusted-local.
 */
export class NativeInstallation {
  readonly #o: Options;
  readonly #journal: ActivationJournal;
  readonly #identity: string;
  readonly #consumers = new Map<string, Consumer>();
  readonly #creating = new Set<string>();
  readonly #pending = new Map<string, PendingConsumer>();
  #backend: NativeBackend;
  // Undefined only for the explicitly administrator-owned initial backend.
  #selectedInputs?: SelectedInputs;
  #selection: InstallationSelection;
  #mutations = 0;
  #active = false;
  #blocked = false;
  #closed = false;
  private constructor(o: Options, journal: ActivationJournal, identity: string, selection: InstallationSelection) {
    this.#o = o; this.#journal = journal; this.#identity = identity; this.#selection = selection;
    this.#backend = new NativeBackend(o.native);
  }
  static async create(value: Options): Promise<NativeInstallation> {
    if (!object(value, 'installationId,installer,native,policyHash,root,trustedLocal,web') || !identifier(value.installationId) ||
      !hex(value.policyHash) || !(value.installer instanceof CandidateInstaller) || value.trustedLocal !== true ||
      !value.native?.runtimeControl || !value.native?.web || !object(value.web, 'root,sha256') || !hex(value.web.sha256) ||
      typeof value.root !== 'string' || !path.isAbsolute(value.root) || path.resolve(value.root) !== value.root || value.root === '/') fail('options-invalid');
    const o: Options = Object.freeze({ ...value, native: structuredClone(value.native), web: Object.freeze({ ...value.web }) });
    await privateRoot(path.dirname(o.root));
    if ((await webInventory(o.web.root)).sha256 !== o.web.sha256) fail('web-changed');
    // A preexisting root is evidence, not a reconstructible owned process set.
    await mkdir(o.root, { mode: 0o700 });
    await writeNew(path.join(o.root, 'policy.json'), canonical({ installationId: o.installationId, policyHash: o.policyHash,
      native: o.native, web: o.web, installerRoot: o.installer.config.root, trustedLocal: true }));
    await mkdir(path.join(o.root, 'operations'), { mode: 0o700 });
    const journal = await ActivationJournal.create({ root: path.join(o.root, 'journal'), installationId: o.installationId });
    await syncDir(o.root); await syncDir(path.dirname(o.root));
    const s = await lstat(o.root);
    return new NativeInstallation(o, journal, `${s.dev}:${s.ino}`, await journal.selection());
  }
  async #fence() {
    await privateRoot(this.#o.root); const s = await lstat(this.#o.root);
    if (`${s.dev}:${s.ino}` !== this.#identity) { this.#blocked = true; fail('installation-root-changed'); }
  }
  #available() {
    if (this.#blocked) throw new ExecutionOutcomeUnknownError();
    if (this.#active || this.#closed) fail('activation-or-installation-busy');
  }
  async #mutate<T>(action: () => T | Promise<T>): Promise<T> {
    try { return await action(); }
    catch (cause) { this.#blocked = true; throw Object.assign(new ExecutionOutcomeUnknownError(), { cause }); }
  }
  async #record(dir: string, name: string, value: unknown) {
    const bytes = canonical(value);
    await this.#mutate(async () => { await writeNew(path.join(dir, name), bytes); await syncDir(dir); });
  }
  async #ownedPersistence<T>(action: () => Promise<T>): Promise<T> {
    // Shared capture/verifier construction also performs writes. Their explicit
    // validation refusals are known; a raw OS error provides no evidence that
    // the mutating phase did not start. Never infer safety from its prose.
    try { return await action(); }
    catch (error: any) {
      if (typeof error?.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)) this.#blocked = true;
      throw error;
    }
  }
  #inventory(): Inventory {
    return this.list().map(identity => ({
      instanceId: identity.instanceId, generation: identity.generation ?? 0, identityHash: hash(canonical(identity)),
    })).sort((a, b) => a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
  }
  async review() {
    await this.#fence();
    return { expectedRevision: this.#selection.revision, consumers: this.#inventory() };
  }
  list(): readonly NativeIdentity[] {
    const owned = [...this.#consumers.values()].flatMap(c => c.backend.list().filter(i => i === c.identity));
    for (const [id, pending] of this.#pending) for (const identity of pending.backend.list())
      if (identity.instanceId === id && !owned.includes(identity)) owned.push(identity);
    return owned;
  }
  async inspect(id: string) {
    // A stopped old generation must not hide an already-owned uncertain successor.
    return await this.#pending.get(id)?.backend.inspect(id) ?? await this.#consumers.get(id)?.backend.inspect(id) ?? null;
  }
  async snapshotRuntime(id: string) {
    const c = this.#consumers.get(id); if (!c) fail('consumer-not-owned'); return c.backend.snapshotRuntime(id);
  }
  async generate(id: string, message: string) {
    this.#available(); const c = this.#consumers.get(id); if (!c) fail('consumer-not-owned');
    return c.backend.generate(id, message);
  }
  async create(request: NativeCreateRequest) {
    this.#available();
    if (this.#consumers.has(request.instanceId) || this.#creating.has(request.instanceId) || this.#consumers.size + this.#creating.size >= 8) fail('consumer-already-owned-or-limit');
    const copy = structuredClone(request); this.#creating.add(copy.instanceId); this.#mutations++;
    const backend = this.#backend;
    try {
      await this.#fence();
      if (this.#selectedInputs) await this.#checkSelected(this.#selectedInputs);
      this.#pending.set(copy.instanceId, { request: copy, backend, selectionRevision: this.#selection.revision });
      const identity = await backend.create(copy);
      this.#consumers.set(identity.instanceId, { request: copy, identity, backend, selectionRevision: this.#selection.revision });
      this.#pending.delete(copy.instanceId);
      return identity;
    } catch (e) {
      if (e instanceof ExecutionOutcomeUnknownError || backend.list().some(i => i.instanceId === copy.instanceId)) this.#blocked = true;
      else this.#pending.delete(copy.instanceId);
      throw e;
    }
    finally { this.#mutations--; this.#creating.delete(copy.instanceId); }
  }
  async stop(id: string) {
    this.#available(); const c = this.#consumers.get(id); if (!c) fail('consumer-not-owned');
    this.#mutations++;
    try {
      await this.#fence(); const result = await c.backend.stop(id);
      if (result.status !== 'stopped') { this.#blocked = true; throw new ExecutionOutcomeUnknownError(); }
      return result;
    } catch (e) { if (e instanceof ExecutionOutcomeUnknownError) this.#blocked = true; throw e; }
    finally { this.#mutations--; }
  }
  #request(task: TaskRecord, expectedState = 'running'): { task: TaskRecord; request: UpdateRequest } {
    if (!object(task, 'action,createdAt,id,key,payload,requester,revision,state,target,updatedAt') ||
      typeof task.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(task.id) ||
      task.state !== expectedState || !['pi-update', 'pi-rollback'].includes(task.action) || task.target !== this.#o.installationId || !identifier(task.requester)) fail('task-invalid');
    const copy = structuredClone(task), p: unknown = copy.payload;
    if (!object(p, 'candidateId,consumers,expectedRevision,receiptHash,releaseIdentity,version') ||
      typeof p.candidateId !== 'string' || !/^c-[a-f0-9]{64}$/.test(p.candidateId) || !hex(p.receiptHash) || !hex(p.releaseIdentity) ||
      typeof p.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(p.version) ||
      !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0 || !Array.isArray(p.consumers) || p.consumers.length > 8) fail('payload-invalid');
    for (const c of p.consumers) if (!object(c, 'generation,identityHash,instanceId') || !identifier(c.instanceId) ||
      !Number.isSafeInteger(c.generation) || c.generation < 0 || !hex(c.identityHash)) fail('payload-invalid');
    if (p.expectedRevision !== this.#selection.revision) fail('selection-revision-changed');
    if (!p.consumers.length || canonical(p.consumers) !== canonical(this.#inventory())) fail('consumer-inventory-changed');
    return { task: copy, request: p as unknown as UpdateRequest };
  }
  /** Observation only, for the authoritative engine's durable waiting_idle
   * phase. It holds no lease and does not authorize execute. activate always
   * rechecks and acquires its own original-generation fences afterwards.
   */
  async waitForIdle(value: TaskRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { request } = this.#request(value, 'waiting_idle');
    for (;;) {
      signal.throwIfAborted(); this.#available(); await this.#fence();
      if (request.expectedRevision !== this.#selection.revision || canonical(request.consumers) !== canonical(this.#inventory())) fail('consumer-inventory-changed');
      let idle = this.#mutations === 0;
      for (const c of request.consumers) {
        const snapshot = await this.#consumers.get(c.instanceId)!.backend.snapshotRuntime(c.instanceId);
        idle &&= snapshot.idle && !snapshot.busy && !snapshot.pending;
      }
      signal.throwIfAborted(); if (idle) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', abort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, 50);
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  async #receipt(r: UpdateRequest) {
    const receipt = await this.#o.installer.verify(r.candidateId, r.receiptHash);
    if (receipt.release.packageName !== '@earendil-works/pi-coding-agent' || receipt.release.identity !== r.releaseIdentity ||
      receipt.release.version !== r.version) fail('candidate-binding-changed');
    checkNodeEngine(receipt.release.nodeEngine, process.versions.node);
    const cli = receipt.executables?.find((e: any) => e.name === 'pi' && e.relativePath === CLI);
    const file = path.join(this.#o.installer.config.root, r.candidateId, 'tree', CLI);
    if (!cli || digest(await fileBytes(file, 32 * 1024 ** 2)) !== cli.sha256) fail('candidate-cli-changed');
    return file;
  }
  async #candidateBackend(dir: string, r: UpdateRequest, executable: string) {
    const inventory = await webInventory(this.#o.web.root);
    if (inventory.sha256 !== this.#o.web.sha256) fail('web-changed');
    const root = path.join(dir, 'web'); await this.#mutate(() => mkdir(root, { mode: 0o700 }));
    for (const file of inventory.files) {
      const target = path.join(root, file.path); await this.#mutate(() => mkdir(path.dirname(target), { recursive: true, mode: 0o700 }));
      const bytes = await fileBytes(path.join(this.#o.web.root, file.path), 32 * 1024 ** 2);
      if (digest(bytes) !== file.sha256) fail('web-changed'); await this.#mutate(() => writeNew(target, bytes));
    }
    if ((await webInventory(root)).sha256 !== inventory.sha256) fail('web-changed');
    const peers = path.join(this.#o.installer.config.root, r.candidateId, 'tree/node_modules');
    await this.#mutate(() => mkdir(path.join(root, 'node_modules/@earendil-works'), { recursive: true, mode: 0o700 }));
    const links = ['ws', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name => ({ name, target: path.join(peers, name) }));
    for (const link of links) await this.#mutate(() => symlink(link.target, path.join(root, 'node_modules', link.name)));
    const s = await lstat(root);
    const inputs: SelectedInputs = { request: structuredClone(r), executable, webRoot: root, webIdentity: `${s.dev}:${s.ino}`,
      files: inventory.files.map(({ path, sha256 }) => ({ path, sha256 })), peers: links };
    await this.#checkSelected(inputs);
    return { inputs, backend: new NativeBackend({ ...this.#o.native, piExecutable: executable,
      web: { ...this.#o.native.web!, extensionPath: path.join(root, 'extensions/mirror-server.ts') } }) };
  }
  async #checkSelected(inputs: SelectedInputs) {
    if (await this.#receipt(inputs.request) !== inputs.executable) fail('candidate-binding-changed');
    // webInventory deliberately rejects node_modules. Check the *actual copied*
    // package separately from its three exact peer links, without following any
    // other symlink or consulting a new administrator-source baseline.
    const files = new Map(inputs.files.map(f => [f.path, f.sha256])), seen = new Set<string>(), dirs = new Set(['']);
    for (const name of files.keys()) for (let p = path.posix.dirname(name); p !== '.'; p = path.posix.dirname(p)) dirs.add(p);
    const visit = async (relative: string) => {
      const dir = path.join(inputs.webRoot, relative); await privateRoot(dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!relative && entry.name === 'node_modules') continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && dirs.has(name)) await visit(name);
        else if (entry.isFile() && files.has(name) && digest(await fileBytes(path.join(inputs.webRoot, name), 32 * 1024 ** 2)) === files.get(name)) seen.add(name);
        else fail('selected-web-changed');
      }
    };
    try {
      const root = await lstat(inputs.webRoot); if (`${root.dev}:${root.ino}` !== inputs.webIdentity) fail('selected-web-changed');
      await visit(''); if (seen.size !== files.size) fail('selected-web-changed');
      const peers = path.join(inputs.webRoot, 'node_modules');
      await privateRoot(peers); await privateRoot(path.join(peers, '@earendil-works'));
      if ((await readdir(peers)).sort().join() !== '@earendil-works,ws' ||
        (await readdir(path.join(peers, '@earendil-works'))).sort().join() !== 'pi-ai,pi-coding-agent') fail('selected-web-changed');
      for (const link of inputs.peers) {
        const file = path.join(peers, link.name), s = await lstat(file);
        if (!s.isSymbolicLink() || s.uid !== process.getuid?.() || await readlink(file) !== link.target || await realpath(file) !== link.target) fail('selected-web-changed');
      }
    } catch { fail('selected-web-changed'); }
  }
  async activate(value: TaskRecord) {
    this.#available(); if (this.#mutations) fail('lifecycle-mutation-busy');
    const { task, request: r } = this.#request(value);
    this.#active = true; // Exclude create/stop/activation BEFORE the first await.
    const held: Held[] = [];
    let tx: ActivationTransaction | undefined, irreversible = false, journalAttempted = false, operationDir: string | undefined;
    const operationId = task.id.replaceAll('-', '');
    const uncertainty = (e: any) => e instanceof ExecutionOutcomeUnknownError || ['native-outcome-unknown', 'reconciliation-required'].includes(e?.code);
    try {
      await this.#fence();
      if ((await readdir(path.join(this.#o.root, 'operations'))).length >= 8) fail('operation-evidence-limit');
      const target = path.join(this.#o.root, 'operations', operationId);
      try { await mkdir(target, { mode: 0o700 }); }
      catch (e: any) {
        if (e.code === 'EEXIST') fail('operation-evidence-exists');
        operationDir = target; this.#blocked = true; throw e;
      }
      operationDir = target;
      await this.#record(operationDir, 'task.json', { task, policyHash: this.#o.policyHash });
      await this.#mutate(() => syncDir(path.dirname(operationDir!)));
      const executable = await this.#receipt(r);
      const selectedRuntime = await this.#candidateBackend(operationDir, r, executable), next = selectedRuntime.backend;
      const captures = path.join(operationDir, 'captures'), proofs = path.join(operationDir, 'proofs');
      await this.#mutate(async () => {
        await mkdir(captures, { mode: 0o700 }); await mkdir(proofs, { mode: 0o700 });
        for (const item of r.consumers) await mkdir(path.join(captures, item.instanceId), { mode: 0o700 });
        await syncDir(captures); await syncDir(proofs); await syncDir(operationDir!);
      });
      // Every currently affected owner must still be the exact approved child.
      for (const item of r.consumers) {
        const consumer = this.#consumers.get(item.instanceId)!;
        const inspection = await consumer.backend.inspect(item.instanceId);
        if (!inspection || inspection.status !== 'ready' || hash(canonical(consumer.identity)) !== item.identityHash) fail('consumer-ownership-changed');
        const snapshot = await consumer.backend.snapshotRuntime(item.instanceId);
        if (!snapshot.idle || snapshot.busy || snapshot.pending || !snapshot.session_file || !snapshot.leaf_id) fail('consumer-busy-or-unsupported');
        const operation = randomBytes(16).toString('hex');
        const capturesRoot = path.join(captures, item.instanceId);
        await consumer.backend.prepareRuntime(item.instanceId, operation, snapshot);
        const h: Held = { consumer, snapshot, operation, capturesRoot }; held.push(h);
        h.capture = await this.#ownedPersistence(() => consumer.backend.captureRuntime(item.instanceId, operation, capturesRoot));
        const d = h.capture.descriptor();
        h.verifier = await this.#ownedPersistence(() => NativeCandidateCompatibility.create({ installer: this.#o.installer,
          root: path.join(proofs, item.instanceId), web: this.#o.web, captures: { root: capturesRoot }, trustedLocal: true }));
        h.proof = await h.verifier.verify({ candidateId: r.candidateId, receiptHash: r.receiptHash,
          session: { reference: d.reference, sha256: d.sha256, sessionId: d.sessionId, leafId: d.leafId! } });
      }
      if (canonical(this.#inventory()) !== canonical(r.consumers)) fail('consumer-inventory-changed');
      const plan = { operationId, taskId: task.id, requester: task.requester, policyHash: this.#o.policyHash,
        installationId: this.#o.installationId, expectedRevision: r.expectedRevision,
        candidate: { id: r.candidateId, receiptHash: r.receiptHash, evidenceHash: hash(canonical(held.map(h => h.proof!.result))) },
        consumers: held.map(h => ({ instanceId: h.consumer.identity.instanceId, generation: h.consumer.identity.generation ?? 0,
          identityHash: hash(canonical(h.consumer.identity)), snapshotHash: hash(canonical(h.snapshot)), captureHash: h.capture!.descriptor().sha256 })) };
      await this.#record(operationDir, 'prepared.json', held.map(h => ({ identity: h.consumer.identity,
        request: h.consumer.request, snapshot: h.snapshot, capture: h.capture!.descriptor(), proof: h.proof!.result })));
      journalAttempted = true;
      const staged = await this.#journal.stage(plan); tx = await this.#journal.begin(operationId, staged.planHash);
      await tx.advance('prepared', hash(canonical(plan.consumers)));
      for (const h of held) { await h.verifier!.revalidate(h.proof!); await h.capture!.verify(h.snapshot); }
      await this.#checkSelected(selectedRuntime.inputs); await this.#fence();
      // From durable intent onward, never cancel, reopen inputs or replay.
      irreversible = true; await tx.advance('commit_intent', hash(canonical(plan)));
      for (const h of held) await h.consumer.backend.commitRuntime(h.consumer.identity.instanceId, h.operation, h.capture!);
      await tx.advance('committed', hash(canonical(plan.consumers)));
      // No old process is stopped until EVERY original generation acknowledged.
      for (const h of held) if ((await h.consumer.backend.stop(h.consumer.identity.instanceId)).status !== 'stopped') throw new ExecutionOutcomeUnknownError();
      await tx.advance('stopped', hash(canonical(plan.consumers)));
      for (const h of held) {
        await this.#record(operationDir, `start-${h.consumer.identity.instanceId}.json`, {
          previous: h.consumer.identity, operation: h.operation, candidateId: r.candidateId, receiptHash: r.receiptHash });
        await this.#checkSelected(selectedRuntime.inputs);
        this.#pending.set(h.consumer.identity.instanceId, { request: h.consumer.request, backend: next, selectionRevision: r.expectedRevision + 1 });
        const identity = await next.resumeForActivation(h.consumer.request, h.consumer.identity, { operationId: h.operation, snapshot: h.snapshot });
        h.successor = { ...h.consumer, backend: next, identity, selectionRevision: r.expectedRevision + 1 };
        // Keep an exact owned handle visible even if a later successor or
        // durable acknowledgement fails. This is not input admission.
        this.#consumers.set(identity.instanceId, h.successor);
        this.#pending.delete(identity.instanceId);
        await this.#record(operationDir, `successor-${identity.instanceId}.json`, identity);
        h.successorSnapshot = await next.snapshotRuntime(identity.instanceId);
        if (h.successorSnapshot.version !== r.version || identity.generation !== (h.consumer.identity.generation ?? 0) + 1) fail('successor-restore-changed');
        await h.capture!.verify(h.snapshot);
        await next.prepareRuntime(identity.instanceId, h.operation, h.successorSnapshot);
      }
      const successors = held.map(h => ({ identity: h.successor!.identity, snapshot: h.successorSnapshot! }));
      await tx.advance('started', hash(canonical(successors)));
      await this.#checkSelected(selectedRuntime.inputs); await this.#fence();
      await tx.advance('ready', hash(canonical(successors)));
      const selected = await tx.publishAndAdmit(async selection => {
        // Routing changes while the installation gate is still closed. All
        // successors started with a startup Web/RPC gate and exact saved bytes.
        this.#selection = selection; this.#backend = next; this.#selectedInputs = selectedRuntime.inputs;
        for (const h of held) this.#consumers.set(h.consumer.identity.instanceId, h.successor!);
        for (const h of held) await next.admitRuntime(h.successor!.identity.instanceId, h.operation, h.successorSnapshot!);
      });
      return { status: 'updated', installationId: this.#o.installationId, version: r.version, revision: selected.revision };
    } catch (error) {
      let unknown = this.#blocked || irreversible || uncertainty(error) || (journalAttempted && !tx);
      if (!unknown) for (const h of held) {
        try { await h.consumer.backend.cancelRuntime(h.consumer.identity.instanceId, h.operation); }
        catch { unknown = true; break; }
      }
      if (tx) try {
        if (unknown) await tx.unknown(hash('activation-outcome-unknown'));
        else await tx.abort(hash('precommit-refused'));
      } catch { unknown = true; }
      if (operationDir) try {
        await this.#record(operationDir, 'outcome.json', { status: unknown ? 'unknown' : 'failed', code: unknown ? 'reconciliation-required' : 'precommit-refused' });
      } catch { unknown = true; }
      if (unknown) { this.#blocked = true; throw new ExecutionOutcomeUnknownError(); }
      throw error;
    } finally { if (!this.#blocked) this.#active = false; }
  }
  async close() {
    this.#available(); if (this.#mutations) fail('lifecycle-mutation-busy'); this.#closed = true;
    for (const c of this.#consumers.values()) if (c.backend.list().some(i => i === c.identity)) {
      try { if ((await c.backend.stop(c.identity.instanceId)).status !== 'stopped') throw new ExecutionOutcomeUnknownError(); }
      catch (e) { this.#blocked = true; throw e; }
    }
  }
}

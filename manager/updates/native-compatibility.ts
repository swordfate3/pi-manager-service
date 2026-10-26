import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { initializeHub } from '../../hub/config.ts';
import { NativeBackend } from '../backends/native.ts';
import { readProcessIdentity } from '../process-identity.ts';
import { listen } from '../http.ts';
import { CandidateInstaller } from './candidate.ts';
import { privateRoot, syncDir, writeNew } from './candidate-storage.ts';
import { absolute, digest, fileBytes, hex, refuse, selectedModule, sessionIdentity, snapshotDialogue, webInventory } from './compatibility-inputs.ts';
import { checkNodeEngine } from './engine.ts';
import { strictJson } from './json.ts';

export interface NativeCompatibilityRequest {
  readonly candidateId: string;
  readonly receiptHash: string;
  readonly session: { readonly reference: string; readonly sha256: string; readonly sessionId: string; readonly leafId: string };
}
export interface NativeCompatibilityOptions {
  readonly installer: CandidateInstaller;
  readonly root: string;
  readonly web: { readonly root: string; readonly sha256: string };
  readonly captures: { readonly root: string };
  readonly trustedLocal: true;
}
declare const proofBrand: unique symbol;
export interface NativeCompatibilityProof {
  readonly [proofBrand]: true;
  readonly result: Readonly<{
    candidateId: string; receiptHash: string;
    session: Readonly<NativeCompatibilityRequest['session'] & { dialogueSha256: string }>;
    bindingSha256: string; evidenceKey: string; evidenceSha256: string;
    updates: false; activation: 'not-attempted';
  }>;
}
const CLI = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const SOURCE = fileURLToPath(new URL('../../', import.meta.url));
const SOURCES = ['manager/updates/native-compatibility.ts', 'manager/updates/native-compatibility-provider.mjs',
  'manager/updates/native-compatibility-sdk.mjs', 'manager/updates/native-compatibility-runtime.mjs', 'manager/updates/compatibility-inputs.ts', 'manager/updates/json.ts',
  'manager/updates/engine.ts', 'manager/updates/release.ts', 'manager/updates/candidate.ts', 'manager/updates/candidate-storage.ts',
  'manager/backends/native.ts', 'manager/backends/runtime-client.ts', 'manager/process-identity.ts', 'hub/config.ts', 'runtime/pi_rpc_guard.mjs'];
const keys = (v: any, expected: string) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === expected;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function request(value: NativeCompatibilityRequest): NativeCompatibilityRequest {
  if (!keys(value, 'candidateId,receiptHash,session')) refuse('request-invalid');
  const r = structuredClone(value);
  if (typeof r.candidateId !== 'string' || !/^c-[a-f0-9]{64}$/.test(r.candidateId) || !hex(r.receiptHash) ||
    !keys(r.session, 'leafId,reference,sessionId,sha256') || typeof r.session.reference !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}\.jsonl$/.test(r.session.reference) || !hex(r.session.sha256) || !id(r.session.sessionId) || !id(r.session.leafId)) refuse('request-invalid');
  return Object.freeze({ ...r, session: Object.freeze(r.session) });
}
async function rootIdentity(root: string) {
  await privateRoot(root); const s = await lstat(root); return `${s.dev}:${s.ino}`;
}
async function hostIdentity() {
  if (process.platform !== 'linux' || process.arch !== 'x64') refuse('host-unsupported');
  const executable = await realpath(process.execPath);
  if (await realpath('/proc/self/exe') !== executable) refuse('host-changed');
  const f = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (!s.isFile() || ![0, process.getuid?.()].includes(s.uid) || (s.mode & 0o022) || s.size > 256 * 1024 ** 2) refuse('host-unsafe');
    const h = createHash('sha256'); for await (const b of f.createReadStream({ autoClose: false })) h.update(b);
    const after = await f.stat(); if (s.mtimeMs !== after.mtimeMs || s.ctimeMs !== after.ctimeMs || s.size !== after.size) refuse('host-changed');
    return { executable, sha256: h.digest('hex'), inode: s.ino, device: s.dev, node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch };
  } finally { await f.close(); }
}
async function sources() {
  return Promise.all(SOURCES.map(async name => ({ name, sha256: digest(await sourceBytes(name)) })));
}
// Distribution sources may be group-writable in the administrator's checkout.
// They are construction-time trusted code, NOT private captured input. Pin bytes
// and inode metadata without changing permissions on the shared distribution.
async function sourceBytes(name: string) {
  const file = path.join(SOURCE, name);
  if (await realpath(file) !== file) refuse('source-unsafe');
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || ![0, process.getuid?.()].includes(s.uid) || (s.mode & 0o002) || s.size > 2 * 1024 ** 2) refuse('source-unsafe');
    const bytes = await f.readFile(), after = await f.stat();
    if (bytes.length !== s.size || after.ctimeMs !== s.ctimeMs || after.mtimeMs !== s.mtimeMs) refuse('source-changed');
    return bytes;
  } finally { await f.close(); }
}
function modelProfile(bytes: Buffer) {
  const rows: any[] = bytes.toString('utf8').trimEnd().split('\n').map(l => strictJson(Buffer.from(l)));
  const model = [...rows].reverse().find(r => r.type === 'model_change');
  const cli = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/.test(v);
  // No inferred real-provider fallback, model rewriting, or multi-namespace replay.
  if (!model || !cli(model.provider) || !cli(model.modelId) || rows.some(r => r.type === 'model_change' && (r.provider !== model.provider || r.modelId !== model.modelId))) refuse('session-model-unsupported');
  const thinking = [...rows].reverse().find(r => r.type === 'thinking_level_change')?.thinkingLevel ?? 'off';
  return { provider: model.provider as string, model: model.modelId as string, thinking };
}
async function until(check: () => Promise<boolean>, ms = 10000) {
  const end = performance.now() + ms;
  do { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } while (performance.now() < end);
  refuse('behavior-timeout');
}
async function rejects(action: () => Promise<unknown>) {
  try { await action(); } catch { return; }
  refuse('behavior-incompatible');
}
function requireBehavior(value: unknown): asserts value { if (!value) refuse('behavior-incompatible'); }

/** Same-UID trusted-local preflight ONLY. Not a network jail, updater or stop authority. */
export class NativeCandidateCompatibility {
  readonly #o: NativeCompatibilityOptions;
  readonly #root: string;
  readonly #captures: string;
  readonly #fixed: string;
  readonly #policy: string;
  readonly #admission: string;
  readonly #proofs = new WeakMap<NativeCompatibilityProof, { request: NativeCompatibilityRequest; binding: string; intent: string;
    run: { root: string; identity: string }; artifacts: { name: string; sha256: string }[] }>();
  #unknown = false;
  #busy = false;
  private constructor(o: NativeCompatibilityOptions, root: string, captures: string, fixed: string, policy: string, admission: string) {
    this.#o = o; this.#root = root; this.#captures = captures; this.#fixed = fixed; this.#policy = policy; this.#admission = admission;
  }
  static async create(value: NativeCompatibilityOptions) {
    if (!keys(value, 'captures,installer,root,trustedLocal,web') || value.trustedLocal !== true || !(value.installer instanceof CandidateInstaller) ||
      !keys(value.web, 'root,sha256') || !hex(value.web.sha256) || !keys(value.captures, 'root')) refuse('options-invalid');
    const o = Object.freeze({ installer: value.installer, root: absolute(value.root), trustedLocal: true as const,
      web: Object.freeze({ root: absolute(value.web.root), sha256: value.web.sha256 }), captures: Object.freeze({ root: absolute(value.captures.root) }) });
    for (const input of [o.web.root, o.captures.root, o.installer.config.root])
      if (o.root === input || o.root.startsWith(input + '/') || input.startsWith(o.root + '/')) refuse('options-invalid');
    const fixed = JSON.stringify({ host: await hostIdentity(), sources: await sources() });
    const captures = await rootIdentity(o.captures.root);
    if ((await webInventory(o.web.root)).sha256 !== o.web.sha256) refuse('web-changed');
    await privateRoot(path.dirname(o.root)); await mkdir(o.root, { mode: 0o700 });
    const policy = JSON.stringify({ root: o.root, captures: o.captures, web: o.web, trustedLocal: true, fixed: JSON.parse(fixed), installerRoot: o.installer.config.root });
    // Permanent reservation for this issuer, NOT a recoverable lock. Never
    // remove or adopt it, even after successful attempts. In particular it
    // survives unlink/fsync ambiguity when releasing the per-attempt writer.
    // create() requires a NEW root; no constructor/open path adopts old roots.
    const admission = JSON.stringify({ issuer: randomBytes(32).toString('hex'), reopen: false });
    await writeNew(path.join(o.root, '.admission'), admission);
    await writeNew(path.join(o.root, 'policy.json'), policy); await syncDir(o.root); await syncDir(path.dirname(o.root));
    return new NativeCandidateCompatibility(o, await rootIdentity(o.root), captures, fixed, policy, admission);
  }
  async #checkRoot() {
    if (await rootIdentity(this.#o.root) !== this.#root || (await fileBytes(path.join(this.#o.root, 'policy.json'))).toString() !== this.#policy ||
      (await fileBytes(path.join(this.#o.root, '.admission'))).toString() !== this.#admission) refuse('root-changed');
  }
  async #mutate<T>(action: () => T | Promise<T>): Promise<T> {
    try { return await action(); }
    catch (e) { this.#unknown = true; throw e; }
  }
  async #inputs(r: NativeCompatibilityRequest) {
    const o = this.#o;
    const receipt = await o.installer.verify(r.candidateId, r.receiptHash);
    if (receipt.release.packageName !== '@earendil-works/pi-coding-agent') refuse('candidate-unsupported');
    checkNodeEngine(receipt.release.nodeEngine, process.versions.node);
    const fixed = JSON.stringify({ host: await hostIdentity(), sources: await sources() });
    if (fixed !== this.#fixed) refuse('host-or-source-changed');
    const web = await webInventory(o.web.root); if (web.sha256 !== o.web.sha256) refuse('web-changed');
    if (await rootIdentity(o.captures.root) !== this.#captures) refuse('capture-root-changed');
    const capture = path.join(o.captures.root, r.session.reference), bytes = await fileBytes(capture), session = sessionIdentity(bytes);
    if (session.sha256 !== r.session.sha256 || session.sessionId !== r.session.sessionId || session.leafId !== r.session.leafId) refuse('session-changed');
    const model = modelProfile(bytes), captureStat = await lstat(capture);
    const tree = path.join(o.installer.config.root, r.candidateId, 'tree');
    const cli = receipt.executables?.find((e: any) => e.name === 'pi' && e.relativePath === CLI);
    if (!cli || !hex(cli.sha256) || digest(await fileBytes(path.join(tree, CLI), 32 * 1024 ** 2)) !== cli.sha256) refuse('candidate-unsupported');
    const pkg: any = strictJson(await fileBytes(path.join(tree, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
    if (pkg.name !== receipt.release.packageName || pkg.version !== receipt.release.version || pkg.engines?.node !== receipt.release.nodeEngine || pkg.bin?.pi !== 'dist/bundle/cli.js') refuse('candidate-unsupported');
    const binding = { candidateId: r.candidateId, receiptHash: r.receiptHash, release: receipt.release, treeSha256: receipt.contentSha256,
      lockSha256: receipt.lockSha256, cli, hostAndSources: JSON.parse(fixed), webSha256: web.sha256,
      webSourceSha256: web.sourceSha256, webOutputSha256: web.outputSha256,
      session: { ...r.session, dialogueSha256: session.dialogueSha256 }, captureIdentity: `${captureStat.dev}:${captureStat.ino}`, model };
    return { binding, bytes, tree, web, model };
  }
  async verify(value: NativeCompatibilityRequest): Promise<NativeCompatibilityProof> {
    const r = request(value);
    if (this.#unknown || this.#busy) refuse('reconciliation-required');
    // Covers the entire finalizer, including the interval after writer unlink.
    this.#busy = true;
    try { return await this.#verify(r); } finally { this.#busy = false; }
  }
  async #verify(r: NativeCompatibilityRequest): Promise<NativeCompatibilityProof> {
    const o = this.#o;
    await this.#checkRoot();
    let lock;
    try { lock = await open(path.join(o.root, '.writer'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (e: any) {
      if (e.code === 'EEXIST') return refuse('reconciliation-required');
      this.#unknown = true; return refuse('native-outcome-unknown');
    }
    let directory: string | undefined, failure: unknown, proof: NativeCompatibilityProof | undefined;
    const written = new Map<string, string>();
    let backend: NativeBackend | undefined, active = false, stopFailed = false;
    const persist = async (name: string, data: unknown) => {
      const bytes = JSON.stringify(data);
      await this.#mutate(async () => { await writeNew(path.join(directory!, name), bytes); await syncDir(directory!); });
      written.set(name, digest(bytes));
    };
    const stop = async () => {
      if (!active || stopFailed) return;
      try {
        if (!backend || (await backend.stop('probe')).status !== 'stopped') refuse('native-outcome-unknown');
        active = false;
      } catch (e) { stopFailed = true; this.#unknown = true; throw e; }
    };
    try {
      const entries = await readdir(o.root);
      if (entries.filter(n => n.startsWith('v-')).length >= 8 || entries.some(n => !['policy.json', '.admission', '.writer'].includes(n) && !/^v-[a-f0-9]{64}$/.test(n))) refuse('evidence-limit');
      const inputs = await this.#inputs(r), binding = JSON.stringify(inputs.binding), key = 'v-' + digest(binding);
      const target = path.join(o.root, key);
      try { await mkdir(target, { mode: 0o700 }); }
      catch (e: any) { if (e.code === 'EEXIST') refuse('evidence-exists'); this.#unknown = true; throw e; }
      directory = target;
      await this.#mutate(async () => { await lock.writeFile(JSON.stringify({ evidenceKey: key })); await lock.sync(); await syncDir(o.root); });
      // Evidence roots can be deeply nested. All socket-bearing runtime paths
      // live in this new short private root, durably bound before any spawn.
      // Never reopen/adopt/prune it, including after a known failure.
      const runRoot = await this.#mutate(() => mkdtemp('/tmp/ncv-run-'));
      const run = { root: runRoot, identity: await rootIdentity(runRoot) };
      const intent = { binding: inputs.binding, trustedLocal: true, updates: false, run };
      await persist('intent.json', intent); await this.#mutate(() => syncDir('/tmp'));
      // Resolve SDK entrypoints without importing ANY candidate code here.
      const sdk = await selectedModule(inputs.tree, '@earendil-works/pi-coding-agent');
      const ai = await selectedModule(inputs.tree, '@earendil-works/pi-ai');
      const compat = await selectedModule(inputs.tree, '@earendil-works/pi-ai', './compat');
      const webRoot = path.join(directory, 'web'); await this.#mutate(() => mkdir(webRoot, { mode: 0o700 }));
      for (const f of inputs.web.files) {
        const dest = path.join(webRoot, f.path); await this.#mutate(() => mkdir(path.dirname(dest), { recursive: true, mode: 0o700 }));
        const bytes = await fileBytes(path.join(o.web.root, f.path), 32 * 1024 ** 2);
        if (digest(bytes) !== f.sha256) refuse('web-changed'); await this.#mutate(() => writeNew(dest, bytes));
      }
      await this.#mutate(() => mkdir(path.join(webRoot, 'node_modules/@earendil-works'), { recursive: true, mode: 0o700 }));
      for (const name of ['ws', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'])
        await this.#mutate(() => symlink(path.join(inputs.tree, 'node_modules', name), path.join(webRoot, 'node_modules', name)));
      const provider = path.join(directory, 'provider.mjs');
      const providerBytes = await sourceBytes('manager/updates/native-compatibility-provider.mjs');
      await this.#mutate(() => writeNew(provider, providerBytes));
      await persist('provider.json', { ai, compat, ...inputs.model });
      const workspace = path.join(runRoot, 'workspace'); await this.#mutate(() => mkdir(workspace, { mode: 0o700 }));
      const hubConfigFile = path.join(runRoot, 'registrar/hub.json'); await this.#mutate(() => initializeHub(hubConfigFile, { port: 0 }));
      const reserve = await this.#mutate(() => listen(async (_req, res) => { res.end(); }, 0)), port = reserve.port;
      await this.#mutate(() => reserve.close());
      const backendConfig = { piExecutable: path.join(inputs.tree, CLI), workspaceRoots: { private: runRoot },
        stateRoot: path.join(runRoot, 'state'), agentRoot: path.join(runRoot, 'agent'), runtimeControl: true,
        provider: { extensionPath: provider, name: inputs.model.provider, model: inputs.model.model },
        web: { extensionPath: path.join(webRoot, 'extensions/mirror-server.ts'), hubConfigFile, port },
        startupTimeoutMs: 15000, generationTimeoutMs: 20000, stopTimeoutMs: 2000 };
      backend = new NativeBackend(backendConfig);
      const create = { instanceId: 'probe', workspace: { root: 'private', path: 'workspace' } };
      // Startup failures have no public exact terminal receipt: conservatively retain admission.
      let previous;
      try { previous = await backend.create(create); active = true; } catch (e) { this.#unknown = true; throw e; }
      await persist('seed-child.json', previous);
      const seed = await backend.generate('probe', 'NATIVE_SEED'); requireBehavior(seed.settled && seed.text === 'NATIVE_COMPAT_OK 中文🙂');
      const operation = randomBytes(16).toString('hex');
      const busyGeneration = backend.generate('probe', 'NATIVE_BUSY'); void busyGeneration.catch(() => {});
      await until(async () => { try { return (await fileBytes(path.join(directory!, 'busy'))).toString() === '1'; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } });
      const busy = await backend.snapshotRuntime('probe'); requireBehavior(!busy.idle || busy.busy);
      await rejects(() => backend!.prepareRuntime('probe', operation, busy));
      await this.#mutate(() => writeNew(path.join(directory!, 'release'), '1'));
      const generation = await busyGeneration;
      requireBehavior(generation.settled && generation.agentEndObserved && !generation.aborted && generation.text === 'NATIVE_COMPAT_OK 中文🙂');
      const cliIdle = await backend.snapshotRuntime('probe'); await backend.prepareRuntime('probe', operation, cliIdle);
      await rejects(() => backend!.generate('probe', 'blocked'));
      await rejects(() => backend!.cancelRuntime('probe', 'f'.repeat(32)));
      await backend.cancelRuntime('probe', operation);
      const cliResumed = await backend.generate('probe', 'NATIVE_RELEASED');
      requireBehavior(cliResumed.settled && cliResumed.agentEndObserved && !cliResumed.aborted && cliResumed.text === 'NATIVE_COMPAT_OK 中文🙂');
      const initial = await backend.snapshotRuntime('probe'); await stop();
      requireBehavior(initial.session_file && initial.version === inputs.binding.release.version);
      // Overwrite only our own stopped seed's session copy, never the supplied capture.
      await this.#mutate(async () => { await writeFile(initial.session_file!, inputs.bytes, { mode: 0o600 }); await chmod(initial.session_file!, 0o600); });
      const restoredExpected = { ...initial, session_id: r.session.sessionId, leaf_id: r.session.leafId, provider: inputs.model.provider, model: inputs.model.model, thinking: inputs.model.thinking };
      const runtime = path.join(directory, 'restore-runtime.mjs');
      const runtimeBytes = await sourceBytes('manager/updates/native-compatibility-runtime.mjs');
      await this.#mutate(() => writeNew(runtime, runtimeBytes, 0o500));
      await persist('restore-runtime.json', { module: sdk, version: inputs.binding.release.version, file: initial.session_file, workspace, ...inputs.model });
      backend = new NativeBackend({ ...backendConfig, piExecutable: runtime });
      try { const child = await backend.resumeForActivation(create, previous, { operationId: operation, snapshot: restoredExpected }); active = true; await persist('restored-child.json', child); }
      catch (e) { this.#unknown = true; throw e; }
      const restored = await backend.snapshotRuntime('probe');
      requireBehavior(restored.session_id === r.session.sessionId && restored.leaf_id === r.session.leafId && restored.version === inputs.binding.release.version);
      const checkCopy = async () => { if (digest(await fileBytes(initial.session_file!)) !== r.session.sha256) refuse('session-copy-changed'); };
      await checkCopy();
      const web = await this.#webHistory(port, r.session.sessionId, inputs.model);
      const sdkFile = path.join(directory, 'sdk-copy.jsonl'); await this.#mutate(() => writeNew(sdkFile, inputs.bytes, 0o600));
      await persist('sdk-request.json', { module: sdk, version: inputs.binding.release.version, file: sdkFile, sessions: path.join(directory, 'sdk-sessions'), workspace });
      let sdkResult;
      try { sdkResult = await sdkRead(directory, runRoot, persist, action => this.#mutate(action)); }
      catch (e: any) { if (e.code === 'native-outcome-unknown') this.#unknown = true; throw e; }
      await persist('sdk-output.json', sdkResult);
      requireBehavior(sdkResult.version === inputs.binding.release.version && sdkResult.node === process.version && sdkResult.abi === process.versions.modules && sdkResult.sessionId === r.session.sessionId && sdkResult.leafId === r.session.leafId);
      if (digest(await fileBytes(sdkFile)) !== r.session.sha256) refuse('session-copy-changed');
      const expected = JSON.stringify(snapshotDialogue(inputs.bytes));
      const normalize = (messages: any[]) => messages.filter(m => m.role !== 'system').map(m => {
        if (!['user', 'assistant'].includes(m.role) || (typeof m.content !== 'string' && (!Array.isArray(m.content) || m.content.some((b: any) => b.type !== 'text' || typeof b.text !== 'string')))) refuse('session-dialogue-changed');
        return { role: m.role, text: typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text).join('') };
      });
      if (JSON.stringify(normalize(web.messages)) !== expected || JSON.stringify(normalize(sdkResult.messages)) !== expected) refuse('session-dialogue-changed');
      await checkCopy();
      await rejects(() => backend!.generate('probe', 'blocked'));
      await backend.prepareRuntime('probe', operation, restored);
      await rejects(() => backend!.cancelRuntime('probe', 'f'.repeat(32)));
      await backend.admitRuntime('probe', operation, restored);
      const idle = await backend.snapshotRuntime('probe'); await backend.prepareRuntime('probe', operation, idle);
      await rejects(() => backend!.generate('probe', 'blocked'));
      await rejects(() => backend!.cancelRuntime('probe', 'f'.repeat(32)));
      await backend.cancelRuntime('probe', operation);
      const resumed = await backend.generate('probe', 'NATIVE_RELEASED');
      requireBehavior(resumed.settled && resumed.agentEndObserved && !resumed.aborted && resumed.text === 'NATIVE_COMPAT_OK 中文🙂');
      await stop(); await persist('children-stopped.json', { exactOwnedChildrenStopped: true });
      if (await rootIdentity(runRoot) !== run.identity) refuse('run-root-changed');
      if (JSON.stringify((await this.#inputs(r)).binding) !== binding) refuse('inputs-changed');
      const artifacts = await Promise.all(['provider.mjs', 'provider.json', 'restore-runtime.mjs', 'restore-runtime.json',
        'sdk-request.json', 'sdk-child.json', 'sdk-terminal.json', 'sdk-output.json', 'sdk-copy.jsonl', 'seed-child.json', 'restored-child.json', 'children-stopped.json',
        ...inputs.web.files.map(f => 'web/' + f.path)].map(async name => ({ name, sha256: digest(await fileBytes(path.join(directory!, name), 32 * 1024 ** 2)) })));
      // Actual executable copies must match construction-pinned originals, not
      // merely agree with a new post-execution baseline.
      for (const [copy, original] of [['provider.mjs', 'native-compatibility-provider.mjs'], ['restore-runtime.mjs', 'native-compatibility-runtime.mjs']])
        if (artifacts.find(a => a.name === copy)!.sha256 !== digest(await sourceBytes('manager/updates/' + original))) refuse('execution-input-changed');
      for (const file of inputs.web.files)
        if (artifacts.find(a => a.name === 'web/' + file.path)!.sha256 !== file.sha256) refuse('execution-input-changed');
      for (const artifact of artifacts)
        if (written.has(artifact.name) && written.get(artifact.name) !== artifact.sha256) refuse('execution-input-changed');
      const evidence = { binding: inputs.binding, observations: { restoredSession: r.session.sessionId, restoredLeaf: r.session.leafId,
        copySha256: r.session.sha256, expectedDialogueSha256: digest(expected), sdkDialogueSha256: digest(JSON.stringify(normalize(sdkResult.messages))),
        webDialogueSha256: digest(JSON.stringify(normalize(web.messages))), webBodySha256: web.bodySha256,
        fullHistory: true, busyRefused: true, inputFenced: true, webInputFenced: true, webMutationFenced: true,
        wrongCancelRefused: true, exactCancel: true, generationAfterRelease: resumed.text },
        run, artifacts, exactOwnedChildrenStopped: true, updates: false, activation: 'not-attempted' };
      await persist('evidence.json', evidence);
      proof = Object.freeze({ result: Object.freeze({ candidateId: r.candidateId, receiptHash: r.receiptHash,
        session: Object.freeze({ ...r.session, dialogueSha256: inputs.binding.session.dialogueSha256 }), bindingSha256: digest(binding),
        evidenceKey: key, evidenceSha256: digest(JSON.stringify(evidence)), updates: false as const, activation: 'not-attempted' as const }) }) as NativeCompatibilityProof;
      this.#proofs.set(proof, { request: r, binding, intent: digest(JSON.stringify(intent)), run, artifacts });
    } catch (e) {
      failure = e;
      if (directory) await persist('failure.json', { code: (e as any).code ?? 'behavior-incompatible', message: String((e as any).message).slice(0, 1024) }).catch(() => { this.#unknown = true; });
    } finally {
      try { await stop(); } catch { this.#unknown = true; }
      try {
        if (!this.#unknown) {
          await this.#checkRoot(); const current = await lstat(path.join(o.root, '.writer')), original = await lock.stat();
          if (current.ino !== original.ino || current.dev !== original.dev) refuse('root-changed');
          await this.#mutate(() => syncDir(o.root));
        }
      } catch { this.#unknown = true; }
      // Close exactly once, BEFORE exposing per-attempt release. Even a compound
      // sync/close failure must reach the sticky outcome below. Never retry it.
      try { await this.#mutate(() => lock.close()); } catch { this.#unknown = true; }
      if (!this.#unknown) {
        try { await this.#mutate(async () => { await unlink(path.join(o.root, '.writer')); await syncDir(o.root); }); }
        catch { this.#unknown = true; }
      }
    }
    if (this.#unknown) return refuse('native-outcome-unknown');
    if (failure) throw failure;
    return proof!;
  }
  async revalidate(proof: NativeCompatibilityProof): Promise<void> {
    const record = this.#proofs.get(proof); if (!record) refuse('proof-invalid');
    if (this.#unknown || this.#busy) refuse('reconciliation-required');
    await this.#checkRoot();
    try { await lstat(path.join(this.#o.root, '.writer')); refuse('reconciliation-required'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (JSON.stringify((await this.#inputs(record.request)).binding) !== record.binding) refuse('inputs-changed');
    if (await rootIdentity(record.run.root) !== record.run.identity) refuse('run-root-changed');
    const directory = path.join(this.#o.root, proof.result.evidenceKey);
    if (digest(await fileBytes(path.join(directory, 'evidence.json'), 2 * 1024 ** 2)) !== proof.result.evidenceSha256 ||
      digest(await fileBytes(path.join(directory, 'intent.json'), 2 * 1024 ** 2)) !== record.intent ||
      (await fileBytes(path.join(directory, 'children-stopped.json'))).toString() !== '{"exactOwnedChildrenStopped":true}') refuse('evidence-changed');
    for (const artifact of record.artifacts)
      if (digest(await fileBytes(path.join(directory, artifact.name), 32 * 1024 ** 2)) !== artifact.sha256) refuse('evidence-changed');
  }
  async #webHistory(port: number, sessionId: string, model: { provider: string; model: string }) {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    requireBehavior(response.status === 200);
    const chunks: Uint8Array[] = []; let bodyBytes = 0;
    requireBehavior(response.body);
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      bodyBytes += chunk.length; requireBehavior(bodyBytes <= 2 * 1024 ** 2); chunks.push(chunk);
    }
    const body = Buffer.concat(chunks); requireBehavior(body.length > 0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}`, maxPayload: 2 * 1024 ** 2 });
    const frames: any[] = []; let bytes = 0, failed = false;
    ws.on('error', () => { failed = true; });
    ws.on('message', raw => { bytes += raw.toString().length; if (bytes > 8 * 1024 ** 2) { failed = true; ws.terminate(); return; }
      try { frames.push(JSON.parse(raw.toString())); } catch { failed = true; } });
    try {
      const deadline = performance.now() + 20000;
      const reply = async (id: string, method: string, params: unknown) => {
        if (performance.now() >= deadline) refuse('web-history-incomplete');
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
        await until(async () => { if (failed) refuse('web-invalid'); return frames.some(f => f.type === 'res' && f.id === id); }, Math.min(10000, deadline - performance.now()));
        return frames.find(f => f.type === 'res' && f.id === id);
      };
      await until(async () => { if (failed) refuse('web-invalid'); return frames.some(f => f.event === 'state_sync'); });
      requireBehavior((await reply('fenced-prompt', 'prompt', { message: 'NATIVE_RELEASED' })).ok === false);
      requireBehavior((await reply('fenced-model', 'set_model', { provider: model.provider, modelId: model.model })).ok === false);
      const entries: any[] = [], cursors = new Set<string>(); let before: string | undefined;
      for (let page = 0; page < 64; page++) {
        const id = `history-${page}`;
        const result = await reply(id, 'get_messages', { sessionId, from: -8640000000000000, to: 8640000000000000, ...(before ? { before } : {}) });
        requireBehavior(result.ok && Array.isArray(result.result?.entries) && result.result.history?.truncatedEntries === 0 && result.result.history.returned === result.result.entries.length);
        entries.unshift(...result.result.entries); requireBehavior(entries.length <= 4096);
        const next = result.result.history.nextBefore;
        if (next === null) return { messages: entries.filter(e => e.type === 'message').map(e => e.message), bodySha256: digest(body) };
        requireBehavior(typeof next === 'string' && next.length > 0 && !cursors.has(next)); cursors.add(next); before = next;
      }
      return refuse('web-history-incomplete');
    } finally { ws.terminate(); }
  }
}

async function sdkRead(directory: string, runRoot: string, persist: (name: string, value: unknown) => Promise<void>,
  mutate: <T>(action: () => T | Promise<T>) => Promise<T>): Promise<any> {
  for (const name of ['sdk-home', 'sdk-tmp', 'sdk-config', 'sdk-cache']) await mutate(() => mkdir(path.join(runRoot, name), { mode: 0o700 }));
  const child = await mutate(() => spawn(process.execPath, [path.join(SOURCE, 'manager/updates/native-compatibility-sdk.mjs'), path.join(directory, 'sdk-request.json')], {
    cwd: path.join(runRoot, 'workspace'), env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(runRoot, 'sdk-home'),
      TMPDIR: path.join(runRoot, 'sdk-tmp'), XDG_CONFIG_HOME: path.join(runRoot, 'sdk-config'), XDG_CACHE_HOME: path.join(runRoot, 'sdk-cache'),
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const identity = child.pid ? readProcessIdentity(child.pid) : null;
  const completion = new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = []; let count = 0, failed = false, spawnError = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15000);
    const deadline = setTimeout(() => { clearTimeout(timer); reject(Object.assign(Error('SDK terminal outcome unavailable'), { code: 'native-outcome-unknown' })); }, 18000);
    child.once('error', () => { spawnError = true; });
    child.stdout.on('data', b => { count += b.length; if (count > 2 * 1024 ** 2) { failed = true; child.kill('SIGKILL'); } else chunks.push(b); });
    child.stderr.on('data', b => { count += b.length; if (count > 2 * 1024 ** 2) { failed = true; child.kill('SIGKILL'); } });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(deadline);
      void persist('sdk-terminal.json', { pid: child.pid ?? null, processIdentity: identity, code, signal }).then(() => {
        if (spawnError || !identity) return reject(Object.assign(Error('SDK spawn unknown'), { code: 'native-outcome-unknown' }));
        if (failed || code !== 0) return reject(Object.assign(Error('Candidate SDK incompatible'), { code: 'behavior-incompatible' }));
        try { resolve(strictJson(Buffer.concat(chunks))); } catch (e) { reject(e); }
      }, reject);
    });
  });
  void completion.catch(() => {});
  try { await persist('sdk-child.json', { pid: child.pid ?? null, processIdentity: identity }); }
  catch (e) {
    if (identity && child.pid && readProcessIdentity(child.pid) === identity) child.kill('SIGKILL');
    await completion.catch(() => {}); throw e;
  }
  return completion;
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchesProcessIdentity, readProcessIdentity } from "../process-identity.ts";
import { ExecutionOutcomeUnknownError } from "../errors.ts";
import { issueSession, readHubConfig, revokeSession, type HubConfig } from "../../hub/config.ts";

export interface NativeBackendConfig {
  readonly piExecutable: string;
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly stateRoot: string;
  readonly agentRoot: string;
  /** Trusted administrator code only; never exposed in a task request. */
  readonly provider?: { readonly extensionPath: string; readonly name: string; readonly model: string };
  /** Explicit installed thin Web package + private registrar; no HOME discovery. */
  readonly web?: { readonly extensionPath: string; readonly hubConfigFile: string; readonly port: number };
  readonly startupTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly generationTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface NativeCreateRequest {
  readonly instanceId: string;
  readonly workspace: { readonly root: string; readonly path: string };
}

export interface NativeIdentity {
  readonly instanceId: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly agentDir: string;
  readonly auditFile?: string;
  readonly generation?: number;
}

export interface NativeInspection extends NativeIdentity {
  readonly status: "starting" | "ready" | "stopping" | "ownership-lost";
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
}

export interface NativeStopResult {
  readonly status: "stopped" | "not-owned" | "ownership-lost";
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly forced?: boolean;
}

export interface NativeGeneration {
  readonly disposition: "started" | "handled";
  readonly text: string;
  readonly agentEndObserved: boolean;
  readonly settled: boolean;
  readonly aborted: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Events can fail a child before the initiating caller reaches its await.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type RecordValue = Record<string, unknown>;
type Pending = ReturnType<typeof deferred<RecordValue>> & { command: string; timer: NodeJS.Timeout };
type Generation = ReturnType<typeof deferred<void>> & { text: string; agentEndObserved: boolean; settled: boolean; aborted: boolean; lastMessageFailed: boolean };
interface OwnedChild {
  child: ChildProcessWithoutNullStreams;
  identity: NativeIdentity;
  status: NativeInspection["status"];
  exited: boolean;
  exit: ReturnType<typeof deferred<void>>;
  error?: Error;
  stop?: Promise<NativeStopResult>;
  buffer: Buffer;
  stderr: Buffer;
  stderrTruncated: boolean;
  pending: Map<string, Pending>;
  generation?: Generation;
  enrollment?: { config: HubConfig; runId: string; revokeFailed?: boolean };
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instanceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid instance ID");
}

function absolute(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Administrator paths must be absolute");
  return path.resolve(value);
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("Invalid native backend limit");
  return result;
}

async function privateRoot(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new Error("Native state/agent root must be a canonical private owned directory");
  }
  return directory;
}

async function exitedWithin(entry: OwnedChild, ms: number): Promise<boolean> {
  if (entry.exited) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([entry.exit.promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Private trusted-local infrastructure. Cwd restrictions are NOT a filesystem jail. */
export class NativeBackend {
  #config: NativeBackendConfig;
  #owned = new Map<string, OwnedChild>();
  #starting = new Map<string, { controller: AbortController; promise: Promise<NativeIdentity> }>();
  #startupMs: number;
  #rpcMs: number;
  #generationMs: number;
  #stopMs: number;
  #frameBytes: number;
  #stderrBytes: number;

  constructor(config: NativeBackendConfig) {
    if (process.platform !== "linux" || readProcessIdentity(process.pid) === null) throw new Error("Native backend requires Linux /proc process identities");
    const roots = Object.fromEntries(Object.entries(config.workspaceRoots).map(([key, value]) => [key, absolute(value)]));
    if (!Object.keys(roots).length) throw new Error("At least one allowed workspace root is required");
    this.#config = Object.freeze({
      ...config, piExecutable: absolute(config.piExecutable), stateRoot: absolute(config.stateRoot), agentRoot: absolute(config.agentRoot),
      workspaceRoots: Object.freeze(roots),
      provider: config.provider ? Object.freeze({ ...config.provider, extensionPath: absolute(config.provider.extensionPath) }) : undefined,
      web: config.web ? Object.freeze({ ...config.web, extensionPath: absolute(config.web.extensionPath), hubConfigFile: absolute(config.web.hubConfigFile) }) : undefined,
    });
    if (config.provider && [config.provider.name, config.provider.model].some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value))) throw new Error("Invalid administrator provider selection");
    if (config.web && (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535)) throw new Error("Invalid administrator Web port");
    this.#startupMs = limit(config.startupTimeoutMs, 10_000, 120_000);
    this.#rpcMs = limit(config.rpcTimeoutMs, 5000, 120_000);
    this.#generationMs = limit(config.generationTimeoutMs, 30_000, 600_000);
    this.#stopMs = limit(config.stopTimeoutMs, 1000, 30_000);
    this.#frameBytes = limit(config.maxFrameBytes, 1024 * 1024, 4 * 1024 * 1024);
    this.#stderrBytes = limit(config.maxStderrBytes, 16 * 1024, 1024 * 1024);
  }

  async create(request: NativeCreateRequest, options: { signal?: AbortSignal } = {}): Promise<NativeIdentity> {
    return this.#begin(request, options);
  }

  /** Executor-private recovery of SAVED DATA. Never reconstructs a child handle or signals the old PID. */
  async resume(request: NativeCreateRequest, previous: NativeIdentity, options: { signal?: AbortSignal } = {}): Promise<NativeIdentity> {
    return this.#begin(request, options, structuredClone(previous));
  }

  async #begin(request: NativeCreateRequest, options: { signal?: AbortSignal }, previous?: NativeIdentity): Promise<NativeIdentity> {
    if (!object(request) || Object.keys(request).some((key) => !["instanceId", "workspace"].includes(key))) throw new Error("Invalid create request");
    instanceId(request.instanceId);
    if (this.#starting.has(request.instanceId) || this.#owned.has(request.instanceId)) throw new Error("Instance already owned or starting");
    if (!object(request.workspace) || Object.keys(request.workspace).some((key) => !["root", "path"].includes(key))) throw new Error("Invalid workspace request");
    // Copy caller data before the first await; later mutations cannot change authority.
    const copy = { instanceId: request.instanceId, workspace: { ...request.workspace } };
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const promise = this.#launch(copy, signal, previous);
    this.#starting.set(copy.instanceId, { controller, promise });
    try { return await promise; }
    finally { this.#starting.delete(copy.instanceId); }
  }

  list(): readonly NativeIdentity[] {
    return [...this.#owned.values()].filter((entry) => !entry.exited).map((entry) => entry.identity);
  }

  async inspect(id: string): Promise<NativeInspection | null> {
    instanceId(id);
    const entry = this.#owned.get(id);
    if (!entry || entry.exited) return null;
    if (!matchesProcessIdentity(entry.identity.pid, entry.identity.processIdentity)) entry.status = "ownership-lost";
    return Object.freeze({ ...entry.identity, status: entry.status, stderrBytes: entry.stderr.length, stderrTruncated: entry.stderrTruncated });
  }

  async stop(id: string): Promise<NativeStopResult> {
    instanceId(id);
    const starting = this.#starting.get(id);
    starting?.controller.abort();
    const entry = this.#owned.get(id);
    if (entry) return this.#stop(entry);
    if (starting) await starting.promise.catch(() => {});
    return { status: "not-owned" };
  }

  async generate(id: string, message: string): Promise<NativeGeneration> {
    instanceId(id);
    const entry = this.#owned.get(id);
    if (!entry || entry.exited || entry.status !== "ready" || entry.error) throw new Error("Instance is not ready and owned");
    if (entry.generation) throw new Error("Instance is busy");
    if (typeof message !== "string" || !message.length || Buffer.byteLength(JSON.stringify(message)) + 256 > this.#frameBytes) throw new Error("Invalid or oversized prompt");
    const generation: Generation = { ...deferred<void>(), text: "", agentEndObserved: false, settled: false, aborted: false, lastMessageFailed: false };
    entry.generation = generation; // Subscribe before prompt: even immediate events are retained.
    const timer = setTimeout(() => this.#fail(entry, new Error("Generation deadline exceeded")), this.#generationMs);
    try {
      const response = await this.#request(entry, "prompt", { message }, this.#rpcMs);
      const disposition = object(response.data) ? response.data.disposition : undefined;
      if (disposition !== "started" && disposition !== "handled") throw new Error("Unexpected prompt disposition");
      if (disposition === "started") await generation.promise;
      return { disposition, text: generation.text, agentEndObserved: generation.agentEndObserved, settled: generation.settled, aborted: generation.aborted };
    } catch (error) {
      await this.#stop(entry);
      throw error;
    } finally {
      clearTimeout(timer);
      entry.generation = undefined;
    }
  }

  async #recovery(previous: NativeIdentity, request: NativeCreateRequest, workspace: string, stateRoot: string, agentRoot: string) {
    if (!object(previous) || previous.instanceId !== request.instanceId || previous.workspace !== workspace ||
      !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.processIdentity !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(previous.processIdentity) ||
      !Number.isSafeInteger(previous.generation ?? 0) || (previous.generation ?? 0) < 0 || (previous.generation ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid private recovery identity");
    for (const [directory, parent] of [[previous.stateDir, stateRoot], [previous.agentDir, agentRoot]]) {
      if (typeof directory !== "string" || path.dirname(directory) !== parent || !path.basename(directory).startsWith(request.instanceId + "-")) throw new Error("Invalid private recovery directory");
      await privateRoot(directory);
    }
    const auditFile = previous.auditFile ?? "identity.json";
    if (auditFile !== "identity.json" && !/^identity-[a-f0-9-]{36}\.json$/.test(auditFile)) throw new Error("Invalid private recovery audit");
    const handle = await open(path.join(previous.stateDir, auditFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await handle.stat();
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 8192) throw new Error("Unsafe private recovery audit");
      const audit = JSON.parse(await handle.readFile("utf8"));
      if (!object(audit) || audit.schemaVersion !== 1 || Object.keys(audit).length !== Object.keys(previous).length + 1 ||
        Object.entries(previous).some(([k, v]) => audit[k] !== v)) throw new Error("Private recovery identity differs from audit");
    } finally { await handle.close(); }
    const observed = readProcessIdentity(previous.pid);
    if (observed === previous.processIdentity) throw new Error("Previous native generation is still active");
    if (observed === null) {
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw new ExecutionOutcomeUnknownError(); }
      throw new ExecutionOutcomeUnknownError();
    }
  }

  async #launch(request: NativeCreateRequest, signal: AbortSignal, previous?: NativeIdentity): Promise<NativeIdentity> {
    signal.throwIfAborted();
    const rootName = request.workspace.root;
    const selection = request.workspace.path;
    if (typeof rootName !== "string" || !Object.hasOwn(this.#config.workspaceRoots, rootName) || typeof selection !== "string" || path.isAbsolute(selection) || selection.includes("\0") || selection.split(/[\\/]/).includes("..")) throw new Error("Invalid workspace selection");
    const root = await realpath(this.#config.workspaceRoots[rootName]);
    const workspace = await realpath(path.resolve(root, selection));
    const relative = path.relative(root, workspace);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(workspace)).isDirectory()) throw new Error("Workspace escapes allowed root or is not a directory");
    let executable: string;
    try {
      executable = await realpath(this.#config.piExecutable);
      await access(executable, constants.X_OK);
      if (!(await stat(executable)).isFile()) throw new Error();
    } catch { throw new Error("Configured Pi executable is unavailable"); }
    const stateRoot = await privateRoot(this.#config.stateRoot);
    const agentRoot = await privateRoot(this.#config.agentRoot);
    if (previous) await this.#recovery(previous, request, workspace, stateRoot, agentRoot);
    const stateDir = previous?.stateDir ?? await mkdtemp(path.join(stateRoot, `${request.instanceId}-`));
    const agentDir = previous?.agentDir ?? await mkdtemp(path.join(agentRoot, `${request.instanceId}-`));
    const subdir = (name: string) => path.join(stateDir, name);
    for (const name of ["home", "config", "cache", "data", "state", "run", "tmp", "sessions"]) {
      if (previous) await privateRoot(subdir(name)); else await mkdir(subdir(name), { mode: 0o700 });
    }
    const args = ["--mode", "rpc", this.#config.web ? "--continue" : "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-tools", "--no-mcp", "--session-dir", subdir("sessions")];
    if (this.#config.provider) {
      const provider = this.#config.provider;
      args.push("--extension", await realpath(provider.extensionPath), "--provider", provider.name, "--model", provider.model);
    }
    let enrollment: OwnedChild["enrollment"];
    let webEnv: NodeJS.ProcessEnv = {};
    if (this.#config.web) {
      const web = this.#config.web;
      const config = readHubConfig(web.hubConfigFile);
      const credentialFile = subdir(previous ? `web-registration-${randomUUID()}.json` : "web-registration.json");
      const extension = await realpath(web.extensionPath);
      // Credential export is instance-scoped; the child never sees Hub state/config.
      const credential = issueSession(config, credentialFile, { label: request.instanceId });
      enrollment = { config, runId: credential.run_id };
      args.push("--extension", extension);
      webEnv = { PI_WEB_UI_HOST: "127.0.0.1", PI_WEB_UI_PORT: String(web.port), PI_WEB_UI_DISABLED: "false",
        PI_WEB_UI_REGISTRY_SOCKET: config.socketPath, PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: credentialFile };
    }
    signal.throwIfAborted();
    const child = spawn(executable, args, {
      cwd: workspace, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Allowlist from scratch: no NODE_OPTIONS, provider/admin secrets, proxy or project config inheritance.
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", HOME: subdir("home"), TMPDIR: subdir("tmp"),
        XDG_CONFIG_HOME: subdir("config"), XDG_CACHE_HOME: subdir("cache"), XDG_DATA_HOME: subdir("data"), XDG_STATE_HOME: subdir("state"), XDG_RUNTIME_DIR: subdir("run"),
        PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: subdir("sessions"),
        PI_MANAGER_CONFIG: subdir("manager.json"), PI_WEB_UI_HUB_CONFIG: subdir("legacy-manager.json"),
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        ...webEnv,
      },
    });
    const processIdentity = child.pid ? readProcessIdentity(child.pid) : null;
    const auditFile = previous ? `identity-${randomUUID()}.json` : "identity.json";
    const identity = Object.freeze({ instanceId: request.instanceId, pid: child.pid ?? 0, processIdentity: processIdentity ?? "", workspace, stateDir, agentDir, auditFile, generation: (previous?.generation ?? -1) + 1 });
    const entry: OwnedChild = { child, identity, status: "starting", exited: false, exit: deferred<void>(), buffer: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false, pending: new Map(), enrollment };
    this.#owned.set(request.instanceId, entry);
    child.on("error", () => { this.#fail(entry, new Error("Pi child spawn or process error")); if (!child.pid) this.#finish(entry); });
    child.once("exit", () => this.#finish(entry));
    child.stdin.on("error", () => this.#fail(entry, new Error("Pi stdin failed")));
    child.stdout.on("error", () => this.#fail(entry, new Error("Pi stdout failed")));
    child.stderr.on("error", () => this.#fail(entry, new Error("Pi stderr failed")));
    child.stdout.on("data", (chunk: Buffer) => this.#consume(entry, chunk));
    child.stdout.on("end", () => { if (!entry.stop && !entry.exited) this.#fail(entry, new Error("Pi stdout ended before shutdown")); });
    child.stderr.on("data", (chunk: Buffer) => {
      entry.stderrTruncated ||= entry.stderr.length + chunk.length > this.#stderrBytes;
      entry.stderr = Buffer.from(Buffer.concat([entry.stderr, chunk]).subarray(-this.#stderrBytes));
    });
    const abort = () => this.#fail(entry, new Error("Startup aborted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (!processIdentity) throw new Error("Child process identity unavailable");
      // Private saved-data proof only; recovery launches a new child, never adopts/signals this PID.
      await writeFile(subdir(auditFile), JSON.stringify({ schemaVersion: 1, ...identity }) + "\n", { flag: "wx", mode: 0o600 });
      const response = await this.#request(entry, "get_state", {}, this.#startupMs);
      if (!object(response.data) || typeof response.data.isStreaming !== "boolean" || typeof response.data.isCompacting !== "boolean") throw new Error("Invalid readiness state");
      if (entry.error) throw entry.error;
      signal.throwIfAborted();
      entry.status = "ready";
      return identity;
    } catch (error) {
      const cleanup = await this.#stop(entry);
      if (cleanup.status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #request(entry: OwnedChild, command: "get_state" | "prompt", fields: RecordValue, ms: number): Promise<RecordValue> {
    if (entry.error || entry.exited || entry.stop) return Promise.reject(entry.error ?? new Error("Pi child stopped"));
    const id = randomUUID();
    const pending: Pending = { ...deferred<RecordValue>(), command, timer: setTimeout(() => this.#fail(entry, new Error(`${command} RPC deadline exceeded`)), ms) };
    entry.pending.set(id, pending);
    // One bounded in-flight request. The write callback observes flush/error; no unbounded producer queue.
    entry.child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n", (error) => { if (error) this.#fail(entry, new Error("Pi command write failed")); });
    return pending.promise;
  }

  #consume(entry: OwnedChild, chunk: Buffer): void {
    if (entry.error) return; // Keep data listener attached to drain, but retain nothing after failure.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (entry.buffer.length + part.length > this.#frameBytes) return this.#fail(entry, new Error("RPC frame exceeds limit"));
      entry.buffer = Buffer.concat([entry.buffer, part]);
      if (newline < 0) return;
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(entry.buffer);
        const record: unknown = JSON.parse(line);
        if (!object(record) || typeof record.type !== "string") throw new Error();
        this.#record(entry, record);
      } catch { this.#fail(entry, new Error("Invalid UTF-8 JSON RPC frame")); }
      entry.buffer = Buffer.alloc(0);
      if (entry.error) return;
      offset = newline + 1;
    }
  }

  #record(entry: OwnedChild, record: RecordValue): void {
    if (record.type === "response") {
      const pending = typeof record.id === "string" ? entry.pending.get(record.id) : undefined;
      if (!pending) return; // Uncorrelated records never satisfy readiness or prompt acceptance.
      if (record.command !== pending.command || typeof record.success !== "boolean") return this.#fail(entry, new Error("Mismatched RPC response"));
      clearTimeout(pending.timer);
      entry.pending.delete(record.id as string);
      if (record.success) pending.resolve(record);
      else pending.reject(new Error(`${pending.command} RPC rejected`));
      return;
    }
    const generation = entry.generation;
    if (!generation) return;
    if (record.type === "agent_end") generation.agentEndObserved = true;
    if (record.type === "message_end" && object(record.message) && record.message.role === "assistant") {
      // Provider failures can be followed by automatic retries. Only settlement decides final failure.
      generation.lastMessageFailed = record.message.stopReason === "error";
      // Failed attempts are not accepted output. Preserve earlier successful turns across retries.
      if (generation.lastMessageFailed) return;
      if (Array.isArray(record.message.content)) {
        for (const part of record.message.content) {
          if (object(part) && part.type === "text" && typeof part.text === "string") {
            if (Buffer.byteLength(generation.text) + Buffer.byteLength(part.text) > this.#frameBytes) return this.#fail(entry, new Error("Generation output exceeds limit"));
            generation.text += part.text;
          }
        }
      }
    }
    if (record.type === "agent_settled") {
      if (typeof record.aborted !== "boolean") return this.#fail(entry, new Error("Invalid settled event"));
      generation.settled = true;
      generation.aborted = record.aborted;
      if (generation.lastMessageFailed && !generation.aborted) return this.#fail(entry, new Error("Pi generation failed"));
      generation.resolve();
    }
  }

  #fail(entry: OwnedChild, error: Error): void {
    entry.error ??= error;
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(entry.error); }
    entry.pending.clear();
    entry.generation?.reject(entry.error);
    entry.buffer = Buffer.alloc(0);
    if (entry.status === "ready" && !entry.stop) void this.#stop(entry).catch(() => {});
  }

  #finish(entry: OwnedChild): void {
    // A terminated process must not leave a reusable registration capability.
    // Revocation failure is retained and surfaced as unknown to an awaiting stop.
    if (entry.enrollment) {
      try { revokeSession(entry.enrollment.config, entry.enrollment.runId); }
      catch { entry.enrollment.revokeFailed = true; }
    }
    if (entry.exited) return;
    entry.exited = true;
    this.#fail(entry, new Error("Pi child exited"));
    entry.exit.resolve();
    if (this.#owned.get(entry.identity.instanceId) === entry) this.#owned.delete(entry.identity.instanceId);
    entry.child.stdin.destroy();
    entry.child.stdout.destroy();
    entry.child.stderr.destroy();
  }

  #stop(entry: OwnedChild): Promise<NativeStopResult> {
    if (entry.stop) return entry.stop;
    entry.status = "stopping";
    this.#fail(entry, new Error("Pi child stopping"));
    entry.stop = this.#shutdown(entry);
    return entry.stop;
  }

  async #shutdown(entry: OwnedChild): Promise<NativeStopResult> {
    let forced = false;
    entry.child.stdin.end();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (await exitedWithin(entry, this.#stopMs)) break;
      // Only the original ChildProcess handle is signalled. No await between observation and kill.
      // /proc + kill is not an atomic pidfd operation; this is trusted-local, not hostile-UID isolation.
      if (entry.child.pid !== entry.identity.pid || !matchesProcessIdentity(entry.identity.pid, entry.identity.processIdentity)) {
        entry.status = "ownership-lost";
        return { status: "ownership-lost" };
      }
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) break;
      forced = true;
      try { entry.child.kill(signal); }
      catch { entry.status = "ownership-lost"; return { status: "ownership-lost" }; }
    }
    if (!await exitedWithin(entry, this.#stopMs)) {
      entry.status = "ownership-lost";
      return { status: "ownership-lost" };
    }
    if (entry.enrollment?.revokeFailed) throw new ExecutionOutcomeUnknownError();
    return { status: "stopped", exitCode: entry.child.exitCode, signal: entry.child.signalCode, forced };
  }
}

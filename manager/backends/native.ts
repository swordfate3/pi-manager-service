import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchesProcessIdentity, readProcessIdentity } from "../process-identity.ts";

export interface NativeBackendConfig {
  readonly piExecutable: string;
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly stateRoot: string;
  readonly agentRoot: string;
  /** Trusted administrator code only; never exposed in a task request. */
  readonly provider?: { readonly extensionPath: string; readonly name: string; readonly model: string };
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
    });
    if (config.provider && [config.provider.name, config.provider.model].some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value))) throw new Error("Invalid administrator provider selection");
    this.#startupMs = limit(config.startupTimeoutMs, 10_000, 120_000);
    this.#rpcMs = limit(config.rpcTimeoutMs, 5000, 120_000);
    this.#generationMs = limit(config.generationTimeoutMs, 30_000, 600_000);
    this.#stopMs = limit(config.stopTimeoutMs, 1000, 30_000);
    this.#frameBytes = limit(config.maxFrameBytes, 1024 * 1024, 4 * 1024 * 1024);
    this.#stderrBytes = limit(config.maxStderrBytes, 16 * 1024, 1024 * 1024);
  }

  async create(request: NativeCreateRequest, options: { signal?: AbortSignal } = {}): Promise<NativeIdentity> {
    if (!object(request) || Object.keys(request).some((key) => !["instanceId", "workspace"].includes(key))) throw new Error("Invalid create request");
    instanceId(request.instanceId);
    if (this.#starting.has(request.instanceId) || this.#owned.has(request.instanceId)) throw new Error("Instance already owned or starting");
    if (!object(request.workspace) || Object.keys(request.workspace).some((key) => !["root", "path"].includes(key))) throw new Error("Invalid workspace request");
    // Copy caller data before the first await; later mutations cannot change authority.
    const copy = { instanceId: request.instanceId, workspace: { ...request.workspace } };
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const promise = this.#launch(copy, signal);
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

  async #launch(request: NativeCreateRequest, signal: AbortSignal): Promise<NativeIdentity> {
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
    const stateDir = await mkdtemp(path.join(stateRoot, `${request.instanceId}-`));
    const agentDir = await mkdtemp(path.join(agentRoot, `${request.instanceId}-`));
    const subdir = (name: string) => path.join(stateDir, name);
    for (const name of ["home", "config", "cache", "data", "state", "run", "tmp", "sessions"]) await mkdir(subdir(name), { mode: 0o700 });
    const args = ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-tools", "--no-mcp", "--session-dir", subdir("sessions")];
    if (this.#config.provider) {
      const provider = this.#config.provider;
      args.push("--extension", await realpath(provider.extensionPath), "--provider", provider.name, "--model", provider.model);
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
      },
    });
    const processIdentity = child.pid ? readProcessIdentity(child.pid) : null;
    const identity = Object.freeze({ instanceId: request.instanceId, pid: child.pid ?? 0, processIdentity: processIdentity ?? "", workspace, stateDir, agentDir });
    const entry: OwnedChild = { child, identity, status: "starting", exited: false, exit: deferred<void>(), buffer: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false, pending: new Map() };
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
      // Audit only. No read/import/recovery path exists, even on a later backend instance.
      await writeFile(subdir("identity.json"), JSON.stringify({ schemaVersion: 1, ...identity }) + "\n", { flag: "wx", mode: 0o600 });
      const response = await this.#request(entry, "get_state", {}, this.#startupMs);
      if (!object(response.data) || typeof response.data.isStreaming !== "boolean" || typeof response.data.isCompacting !== "boolean") throw new Error("Invalid readiness state");
      if (entry.error) throw entry.error;
      signal.throwIfAborted();
      entry.status = "ready";
      return identity;
    } catch (error) {
      const cleanup = await this.#stop(entry);
      if (cleanup.status === "ownership-lost") throw new Error("Startup failed; child ownership or exit unconfirmed, further signals refused");
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
    if (entry.status === "ready" && !entry.stop) void this.#stop(entry);
  }

  #finish(entry: OwnedChild): void {
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
    return { status: "stopped", exitCode: entry.child.exitCode, signal: entry.child.signalCode, forced };
  }
}

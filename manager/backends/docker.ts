import { createHash } from "node:crypto";
import { chmod, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue, TaskRecord } from "../contracts.ts";
import { TaskStore } from "../task-store.ts";
import { DockerEngine, DockerOperationError, DockerOutcomeUnknownError } from "./docker-engine.ts";
import { issueSession, readHubConfig, type HubConfig } from "../../hub/config.ts";
import { enrollmentConfig, EnrollmentClient, readEnrollmentAuthority, type EnrollmentConfig } from "../enrollment/client.ts";
import { runtimeProfile, runtimeProfileMounts, runtimeProfileSources, validateRuntimeSources, type RuntimeProfile } from "./runtime-profile.ts";

export interface DockerBackendConfig {
  readonly socketPath: string;
  readonly daemonId: string;
  readonly image: string;
  /** Explicit local-daemon host coordinates; container-local paths are not inferred. */
  readonly pathCoordinates: "host";
  readonly stateRoot: string;
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly protectedRoots?: readonly string[];
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly runtimeProfile?: RuntimeProfile;
  /** Administrator-fixed image entry contract, never accepted in create requests. */
  readonly entrypoint?: readonly string[];
  readonly command?: readonly string[];
  /** Explicit opt-in host network and narrow Web enrollment mounts. */
  readonly web?: { readonly packageRoot: string; readonly hubConfigFile?: string; readonly enrollment?: EnrollmentConfig; readonly port: number;
    readonly provider?: { readonly packageRoot: string; readonly name: string; readonly model: string } };
}

export interface DockerCreateRequest {
  readonly instanceId: string;
  readonly workspace: { readonly root: string; readonly path: string };
}

export interface DockerIdentity {
  readonly instanceId: string;
  readonly containerId: string;
  readonly homeVolume: string;
  readonly image: string;
}

export interface DockerInspection extends DockerIdentity {
  readonly status: "running" | "stopped" | "missing";
}

const OWNER = "cn.swordfate.pi-manager.owner";
const INSTANCE = "cn.swordfate.pi-manager.instance";
const NONCE = "cn.swordfate.pi-manager.nonce";
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
type RecordValue = Record<string, any>;
const object = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is RecordValue => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const inside = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
function absolute(v: string): string {
  if (typeof v !== "string" || !path.isAbsolute(v) || v === "/" || path.resolve(v) !== v || v.includes("\0")) throw new DockerOperationError("Invalid administrator path");
  return v;
}
function fixedArgs(v: readonly string[] | undefined, fallback: string[]) {
  const args = v ?? fallback;
  if (!Array.isArray(args) || !args.length || args.length > 64 || args.some(s => typeof s !== "string" || !s || s.includes("\0") || s.length > 8192)) throw new DockerOperationError("Invalid administrator image contract");
  return Object.freeze([...args]);
}

/**
 * Executor-only Docker lifecycle. Never pulls, builds, prunes, adopts foreign
 * containers, or deletes homes. The private TaskStore is an ownership journal,
 * not a second public approval queue. Approval is the enclosing executor's job.
 */
export class DockerBackend {
  readonly #config: DockerBackendConfig;
  readonly #engine: DockerEngine;
  readonly #journal: TaskStore;
  readonly #owner: string;
  readonly #protected: readonly string[];
  readonly #hub: HubConfig | undefined;
  readonly #enrollment: EnrollmentClient | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(config: DockerBackendConfig, journal: TaskStore, owner: string, protectedPaths: string[], hub?: HubConfig) {
    this.#config = config;
    this.#journal = journal;
    this.#owner = owner;
    this.#protected = protectedPaths;
    this.#hub = hub;
    this.#enrollment = config.web?.enrollment ? new EnrollmentClient(config.web.enrollment) : undefined;
    this.#engine = new DockerEngine(config.socketPath, { timeoutMs: config.timeoutMs });
  }

  static async open(input: DockerBackendConfig, options: { allowProtectedDescendants?: boolean } = {}): Promise<DockerBackend> {
    if (!object(input) || Object.keys(input).some(k => !["socketPath", "daemonId", "image", "pathCoordinates", "stateRoot", "workspaceRoots", "protectedRoots", "timeoutMs", "startupTimeoutMs", "runtimeProfile", "entrypoint", "command", "web"].includes(k))) throw new DockerOperationError("Invalid Docker configuration");
    if (input.startupTimeoutMs !== undefined && (!Number.isInteger(input.startupTimeoutMs) || input.startupTimeoutMs < 100 || input.startupTimeoutMs > 120000)) throw new DockerOperationError("Invalid startup limit");
    if (input.runtimeProfile !== undefined && input.web === undefined) throw new DockerOperationError("Runtime profile requires Web");
    const profile = input.runtimeProfile === undefined ? undefined : runtimeProfile(input.runtimeProfile);
    if (input.pathCoordinates !== "host" || typeof input.daemonId !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.daemonId) || typeof input.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new DockerOperationError("Pinned daemon and image identities required");
    const socketPath = absolute(input.socketPath);
    const stateRoot = absolute(input.stateRoot);
    if (!object(input.workspaceRoots) || !Object.keys(input.workspaceRoots).length || Object.keys(input.workspaceRoots).length > 32) throw new DockerOperationError("Invalid workspace policy");
    const roots: Record<string, string> = {};
    for (const [name, root] of Object.entries(input.workspaceRoots)) {
      if (!ID.test(name) || name === "__proto__") throw new DockerOperationError("Invalid workspace policy");
      const source = absolute(root);
      if (await realpath(source) !== source || !(await stat(source)).isDirectory()) throw new DockerOperationError("Canonical workspace roots required");
      const unsafe = options.allowProtectedDescendants
        ? inside(stateRoot, source) || inside(socketPath, source)
        : overlaps(source, stateRoot) || overlaps(source, socketPath);
      if (unsafe) throw new DockerOperationError("Workspace overlaps private authority");
      roots[name] = source;
    }
    if (input.protectedRoots !== undefined && (!Array.isArray(input.protectedRoots) || input.protectedRoots.length > 64)) throw new DockerOperationError("Invalid protected paths");
    let web: DockerBackendConfig["web"];
    let hub: HubConfig | undefined;
    const webProtected: string[] = [];
    if (input.web !== undefined) {
      const w = input.web;
      if (!object(w) || Object.keys(w).some(k => !["packageRoot", "hubConfigFile", "enrollment", "port", "provider"].includes(k)) || (w.hubConfigFile === undefined) === (w.enrollment === undefined) || !Number.isInteger(w.port) || w.port < 1 || w.port > 65535 || input.command !== undefined || input.entrypoint !== undefined) throw new DockerOperationError("Invalid explicit Web profile");
      for (const p of [absolute(w.packageRoot), ...(w.hubConfigFile === undefined ? [] : [absolute(w.hubConfigFile)])]) if (await realpath(p) !== p) throw new DockerOperationError("Canonical Web paths required");
      if (!(await stat(path.join(w.packageRoot, "extensions/mirror-server.ts"))).isFile() || !(await stat(path.join(w.packageRoot, "dist/index.html"))).isFile()) throw new DockerOperationError("Installed Web package required");
      webProtected.push(w.packageRoot);
      if (w.hubConfigFile !== undefined) {
        const h = hub = readHubConfig(w.hubConfigFile);
        webProtected.push(w.hubConfigFile, h.stateDir, h.runtimeDir);
      }
      if (w.enrollment !== undefined) {
        const e = enrollmentConfig(w.enrollment);
        for (const p of [path.dirname(e.socketPath), e.authorityFile]) if (await realpath(p) !== p) throw new DockerOperationError("Canonical enrollment paths required");
        await readEnrollmentAuthority(e.authorityFile);
        // Registry/export belong to chat UID1000, and are intentionally not
        // traversed by a split-identity executor. Docker resolves host sources.
        webProtected.push(path.dirname(e.socketPath), e.authorityFile, e.registryHostDirectory, e.exportHostDirectory);
      }
      if (w.provider !== undefined) {
        const p = w.provider;
        if (!exact(p, ["packageRoot", "name", "model"]) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(p.name) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(p.model) || await realpath(absolute(p.packageRoot)) !== p.packageRoot || !(await stat(path.join(p.packageRoot, "index.ts"))).isFile()) throw new DockerOperationError("Invalid explicit provider profile");
        webProtected.push(p.packageRoot);
      }
      web = Object.freeze({ ...w, ...(w.enrollment ? { enrollment: enrollmentConfig(w.enrollment) } : {}), ...(w.provider ? { provider: Object.freeze({ ...w.provider }) } : {}) });
    }
    const authorityPaths = [stateRoot, socketPath, ...(input.protectedRoots ?? []).map(absolute), ...(hub ? [hub.stateDir, hub.runtimeDir, input.web!.hubConfigFile!] : []),
      ...(web?.enrollment ? [path.dirname(web.enrollment.socketPath), web.enrollment.authorityFile, web.enrollment.registryHostDirectory, web.enrollment.exportHostDirectory] : [])];
    if (web && [web.packageRoot, ...(web.provider ? [web.provider.packageRoot] : [])].some(source => authorityPaths.some(p => overlaps(source, p)))) throw new DockerOperationError("Web source overlaps private authority");
    if (profile) {
      if (runtimeProfileSources(profile).some(source => authorityPaths.some(p => overlaps(source, p)))) throw new DockerOperationError("Runtime source overlaps private authority");
      await validateRuntimeSources(profile);
    }
    const protectedPaths = [stateRoot, socketPath, fileURLToPath(new URL("../..", import.meta.url)), ...webProtected, ...(input.protectedRoots ?? []).map(absolute), ...runtimeProfileSources(profile)];
    for (const root of Object.values(roots)) if (protectedPaths.some(p => options.allowProtectedDescendants ? inside(p, root) : overlaps(root, p))) throw new DockerOperationError("Workspace overlaps private authority");
    const config = Object.freeze({ ...input, socketPath, stateRoot, workspaceRoots: Object.freeze(roots),
      protectedRoots: Object.freeze(protectedPaths), entrypoint: fixedArgs(input.entrypoint, ["/usr/local/bin/pi-entrypoint"]),
      runtimeProfile: profile, web, command: fixedArgs(input.command, web ? ["--mode", "rpc", "--continue", ...(profile ? [] : ["--offline"]), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", ...(profile ? [] : ["--no-tools"]), "--no-mcp", "--no-approve", "--session-dir", "/home/node/.pi/manager-sessions", "--extension", "/opt/pi-web/extensions/mirror-server.ts",
        ...(web.provider ? ["--extension", "/opt/pi-provider/index.ts", "--provider", web.provider.name, "--model", web.provider.model] : []),
        ...(profile?.extensions ?? []).flatMap((e, i) => ["--extension", `/opt/pi-profile/extensions/${i}/${e.entry}`])] : ["--mode", "rpc", "--no-session", "--offline"]) });
    const owner = hash({ daemonId: config.daemonId, image: config.image, stateRoot, roots, protectedPaths, entrypoint: config.entrypoint, command: config.command, web,
      ...(profile ? { runtimeProfile: profile } : {}), ...(input.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: input.startupTimeoutMs }) });
    const journal = await TaskStore.open(stateRoot);
    try {
      for (const record of await journal.list()) {
        if (record.requester !== owner || record.action !== "docker.create") throw new DockerOperationError("Docker journal policy changed; explicit migration required");
      }
      return new DockerBackend(config, journal, owner, protectedPaths, hub);
    } catch (error) { await journal.close(); throw error; }
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new DockerOperationError("Docker backend closed"));
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #daemon(): Promise<void> {
    const info = await this.#engine.call("GET", "/info");
    if (!object(info) || info.ID !== this.#config.daemonId) throw new DockerOperationError("Docker daemon identity changed");
  }

  async #workspace(request: DockerCreateRequest): Promise<string> {
    if (!exact(request, ["instanceId", "workspace"]) || !ID.test(request.instanceId) || !exact(request.workspace, ["root", "path"])) throw new DockerOperationError("Invalid Docker create request");
    const { root: key, path: selection } = request.workspace;
    if (typeof key !== "string" || !Object.hasOwn(this.#config.workspaceRoots, key) || typeof selection !== "string" || path.isAbsolute(selection) || selection.includes("\0") || selection.includes("\\") || selection.split("/").includes("..")) throw new DockerOperationError("Invalid workspace selection");
    const root = this.#config.workspaceRoots[key];
    // Revalidate root every time: a replaced symlink cannot silently change policy.
    if (await realpath(root) !== root) throw new DockerOperationError("Workspace root changed");
    const selected = path.resolve(root, selection);
    let current = root;
    for (const segment of path.relative(root, selected).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DockerOperationError("Workspace directory changed");
    }
    const workspace = await realpath(selected);
    const relative = path.relative(root, workspace);
    if (workspace !== selected || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(workspace)).isDirectory() || this.#protected.some(p => overlaps(workspace, p))) throw new DockerOperationError("Workspace escapes policy or overlaps private authority");
    return workspace;
  }

  async #savedWorkspace(task: TaskRecord): Promise<void> {
    try {
      const payload: unknown = task.payload;
      const saved = object(payload) ? payload.workspace : undefined;
      if (typeof saved !== "string" || absolute(saved) !== saved) throw new Error();
      // Existing journals already pin the approved canonical mount source and
      // the policy hash pins these root coordinates. Recover its root+relative
      // selector without changing journal schemas or consulting a mutable alias.
      const root = Object.entries(this.#config.workspaceRoots).find(([, directory]) => inside(directory, saved));
      if (!root || await this.#workspace({ instanceId: task.target, workspace: { root: root[0], path: path.relative(root[1], saved) } }) !== saved) throw new Error();
    } catch { throw new DockerOperationError("Saved workspace no longer satisfies the approved policy"); }
  }

  /** Approval/execution preflight; inspection and stop deliberately stay independent. */
  validateStart(instanceId: string): Promise<void> {
    return this.#serial(async () => {
      const task = await this.#record(instanceId);
      if (!task) throw new DockerOperationError("Instance not owned");
      this.#identity(task);
      await this.#savedWorkspace(task);
    });
  }

  #labels(task: TaskRecord) {
    return { [OWNER]: this.#owner, [INSTANCE]: task.target, [NONCE]: task.id };
  }

  #home(task: TaskRecord): string { return `pi-manager-home-${task.id.replaceAll("-", "")}`; }

  #identity(task: TaskRecord): DockerIdentity {
    const result: unknown = task.result;
    if (task.state !== "succeeded" || !exact(result, ["containerId", "homeVolume"]) || !HEX.test(result.containerId) || result.homeVolume !== this.#home(task)) throw new DockerOperationError("Docker identity unavailable; reconciliation required");
    return Object.freeze({ instanceId: task.target, containerId: result.containerId as string, homeVolume: result.homeVolume as string, image: this.#config.image });
  }

  #webMounts(task: TaskRecord) {
    const w = this.#config.web;
    if (!w) return [];
    const h = this.#hub!;
    return [{ Type: "bind", Source: w.packageRoot, Target: "/opt/pi-web", ReadOnly: true },
      { Type: "bind", Source: w.enrollment?.registryHostDirectory ?? h.runtimeDir, Target: "/run/pi-registry", ReadOnly: true },
      { Type: "bind", Source: path.join(w.enrollment?.exportHostDirectory ?? this.#config.stateRoot, `registration-${task.id}.json`), Target: "/run/pi-web/credential.json", ReadOnly: true },
      ...(w.provider ? [{ Type: "bind", Source: w.provider.packageRoot, Target: "/opt/pi-provider", ReadOnly: true }] : [])];
  }

  #environment(): string[] {
    const web = this.#config.web;
    return ["HOME=/home/node", "PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin", ...(web ? ["PI_AGENT_DIR=/home/node/.pi/manager-agent", "PI_CODING_AGENT_DIR=/home/node/.pi/manager-agent", ...(this.#config.runtimeProfile ? [] : ["PI_OFFLINE=1"]), "PI_SKIP_VERSION_CHECK=1", "PI_WEB_UI_HOST=127.0.0.1", `PI_WEB_UI_PORT=${web.port}`, "PI_WEB_UI_DISABLED=false", "PI_WEB_UI_REGISTRY_SOCKET=/run/pi-registry/registry.sock", "PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=/run/pi-web/credential.json"] : []),
      ...Object.entries(this.#config.runtimeProfile?.environment ?? {}).map(([key, value]) => `${key}=${value}`)];
  }

  async #image(): Promise<RecordValue> {
    const image = await this.#engine.call("GET", `/images/${encodeURIComponent(this.#config.image)}/json`);
    if (!object(image) || image.Id !== this.#config.image || !object(image.Config) || (image.Config.Volumes && Object.keys(image.Config.Volumes).length)) throw new DockerOperationError("Pinned Docker image contract unavailable");
    // Docker merges image Env; neither "0" nor "" removes a key. Pi's online
    // model loader requires PI_OFFLINE to be genuinely undefined.
    if (this.#config.runtimeProfile && Array.isArray(image.Config.Env) && image.Config.Env.some((e: unknown) => typeof e === "string" && (e === "PI_OFFLINE" || e.startsWith("PI_OFFLINE=")))) throw new DockerOperationError("Pinned Docker image contract unavailable");
    // A nested file bind on a fresh /home/node volume can cause Docker to
    // create root-owned destination parents. Require an administrator-prepared
    // pinned image whose home copy-up already supplies UID1000 writable parents.
    // This label is an image-author contract, not filesystem proof from inspect.
    if (this.#config.runtimeProfile?.modelsFile && image.Config.Labels?.["cn.swordfate.pi-manager.profile-home"] !== "uid1000-v1") throw new DockerOperationError("Pinned Docker image contract unavailable");
    return image;
  }

  async #runtime(): Promise<void> {
    const p = this.#config.runtimeProfile;
    if (!p) return;
    await validateRuntimeSources(p);
    if (p.runtimeVolume) {
      const v = await this.#engine.call("GET", `/volumes/${p.runtimeVolume}`, undefined, { allowMissing: true });
      if (!object(v) || v.Name !== p.runtimeVolume || v.Driver !== "local" || (v.Options && Object.keys(v.Options).length)) throw new DockerOperationError("Existing local runtime volume required");
    }
  }

  async #ready(task: TaskRecord): Promise<void> {
    if (!this.#enrollment) return;
    const container = await this.#owned(task);
    if (container?.State?.Running !== true) throw new DockerOperationError("Pi is not running; retained identity requires approved start");
    const deadline = Date.now() + (this.#config.startupTimeoutMs ?? 20000);
    while (Date.now() < deadline) {
      let ready = false;
      try { ready = await this.#enrollment.status(task.id, task.target, deadline - Date.now()); } catch { /* bounded readiness retries, never reissue a grant */ }
      if (ready) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    throw new DockerOperationError("Pi registration readiness timed out; retained identity requires approved start");
  }

  async #record(instanceId: string): Promise<TaskRecord | undefined> {
    if (typeof instanceId !== "string" || !ID.test(instanceId)) throw new DockerOperationError("Invalid instance ID");
    return (await this.#journal.list()).find(task => task.target === instanceId);
  }

  async #owned(task: TaskRecord): Promise<RecordValue | null> {
    const identity = this.#identity(task);
    const info = await this.#engine.call("GET", `/containers/${identity.containerId}/json`, undefined, { allowMissing: true });
    if (info === null) return null;
    const expected = this.#labels(task);
    const cfg = object(info) && object(info.Config) ? info.Config : undefined;
    const host = object(info) && object(info.HostConfig) ? info.HostConfig : undefined;
    const webMounts = [...this.#webMounts(task), ...runtimeProfileMounts(this.#config.runtimeProfile)];
    if (!object(info) || info.Id !== identity.containerId || info.Image !== identity.image || !cfg || !object(cfg.Labels) || Object.entries(expected).some(([k, v]) => cfg.Labels[k] !== v) || cfg.User !== "1000:1000" || !host || host.Privileged !== false || host.ReadonlyRootfs !== true || JSON.stringify(host.CapDrop) !== '["ALL"]' || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges:true") || host.NetworkMode !== (this.#config.web ? "host" : "none") || !Array.isArray(info.Mounts) || info.Mounts.length !== 2 + webMounts.length) throw new DockerOperationError("Container ownership or safety contract mismatch");
    for (const expected of webMounts) {
      const mount = info.Mounts.find((m: any) => m.Destination === expected.Target);
      if (!mount || mount.Type !== expected.Type || (expected.Type === "volume" ? mount.Name : mount.Source) !== expected.Source || mount.RW !== false) throw new DockerOperationError("Container enrollment/profile mount mismatch");
      if (expected.Type === "volume") {
        const configured = host.Mounts?.find((m: any) => m.Target === expected.Target);
        if (configured?.VolumeOptions?.NoCopy !== true || configured?.ReadOnly !== true) throw new DockerOperationError("Container runtime volume safety contract mismatch");
      }
    }
    const image = await this.#image();
    const environment = (entries: unknown): Map<string, string> => {
      if (!Array.isArray(entries)) throw new DockerOperationError("Container environment contract mismatch");
      const result = new Map<string, string>();
      for (const entry of entries) {
        if (typeof entry !== "string" || !entry.includes("=") || entry.includes("\0")) throw new DockerOperationError("Container environment contract mismatch");
        const name = entry.slice(0, entry.indexOf("="));
        if (!name || result.has(name)) throw new DockerOperationError("Container environment contract mismatch");
        result.set(name, entry.slice(entry.indexOf("=") + 1));
      }
      return result;
    };
    const merged = environment(image.Config.Env ?? []);
    for (const [k, v] of environment(this.#environment())) merged.set(k, v);
    const actual = environment(cfg.Env);
    if (actual.size !== merged.size || [...merged].some(([k, v]) => actual.get(k) !== v) || JSON.stringify(cfg.Entrypoint) !== JSON.stringify(this.#config.entrypoint) || JSON.stringify(cfg.Cmd) !== JSON.stringify(this.#config.command) || cfg.WorkingDir !== "/workspace") throw new DockerOperationError("Container execution contract mismatch");
    const payload: unknown = task.payload;
    const workspace = object(payload) ? payload.workspace : undefined;
    const bind = info.Mounts.find((m: any) => m.Destination === "/workspace");
    const home = info.Mounts.find((m: any) => m.Destination === "/home/node");
    if (!bind || bind.Type !== "bind" || bind.Source !== workspace || bind.RW !== true || !home || home.Type !== "volume" || home.Name !== identity.homeVolume || home.RW !== true) throw new DockerOperationError("Container ownership mount mismatch");
    return info;
  }

  create(request: DockerCreateRequest, authority?: { taskId: string; requester: string }): Promise<DockerIdentity> {
    // Copy before the first await, not after a caller can mutate authority.
    let copy: DockerCreateRequest;
    try { copy = structuredClone(request); } catch { return Promise.reject(new DockerOperationError("Invalid Docker create request")); }
    // Executor-only binding, separate from the restricted workspace request.
    const binding = authority === undefined ? undefined : structuredClone(authority);
    if (binding && (!exact(binding, ["taskId", "requester"]) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(binding.taskId) || !ID.test(binding.requester))) return Promise.reject(new DockerOperationError("Invalid private task binding"));
    return this.#serial(async () => {
      const workspace = await this.#workspace(copy);
      await this.#daemon();
      const payload = { workspace, profile: this.#owner, ...(binding ? { authority: binding } : {}) };
      let task = await this.#journal.submit({ key: copy.instanceId, requester: this.#owner, target: copy.instanceId, action: "docker.create", payload });
      if (task.state === "succeeded") {
        if (!(await this.#owned(task))) throw new DockerOperationError("Owned container missing; reconciliation required");
        await this.#ready(task); return this.#identity(task);
      }
      if (task.state !== "pending_approval") throw new DockerOperationError("Prior Docker operation requires reconciliation");
      await this.#image(); await this.#runtime();
      task = await this.#journal.transition(task.id, "pending_approval", "queued", { expectedRevision: task.revision });
      task = await this.#journal.transition(task.id, "queued", "running", { expectedRevision: task.revision });
      try {
        const labels = this.#labels(task);
        const web = this.#config.web;
        const webMounts = [...this.#webMounts(task), ...runtimeProfileMounts(this.#config.runtimeProfile)];
        if (this.#enrollment) await this.#enrollment.issue(task.id, task.target);
        else if (web) {
          const h = this.#hub!;
          const credential = webMounts.find(m => m.Target === "/run/pi-web/credential.json")!.Source;
          issueSession(h, credential, { label: task.target });
          // The host's private journal directory remains 0700. The single file
          // is readable by the fixed nonroot container UID through its RO bind.
          await chmod(credential, 0o444);
        }
        const homeVolume = this.#home(task);
        const existing = await this.#engine.call("GET", `/volumes/${homeVolume}`, undefined, { allowMissing: true });
        if (existing !== null) throw new DockerOperationError("Preexisting volume requires reconciliation");
        const volume = await this.#engine.call("POST", "/volumes/create", { Name: homeVolume, Driver: "local", Labels: labels });
        if (!object(volume) || volume.Name !== homeVolume || volume.Driver !== "local" || (volume.Options && Object.keys(volume.Options).length) || !object(volume.Labels) || Object.entries(labels).some(([k,v]) => volume.Labels[k] !== v)) throw new DockerOutcomeUnknownError();
        const definition = {
          Image: this.#config.image, User: "1000:1000", WorkingDir: "/workspace", Entrypoint: [...this.#config.entrypoint!], Cmd: [...this.#config.command!],
          Env: this.#environment(), Labels: labels,
          AttachStdin: true, OpenStdin: true, StdinOnce: false, Tty: false,
          HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: web ? "host" : "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
            Memory: 1024 * 1024 * 1024, MemorySwap: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 256, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } }, Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777" },
            Mounts: [{ Type: "bind", Source: workspace, Target: "/workspace", ReadOnly: false, BindOptions: { Propagation: "rprivate" } },
              { Type: "volume", Source: homeVolume, Target: "/home/node", ReadOnly: false }, ...webMounts],
          },
        };
        const created = await this.#engine.call("POST", `/containers/create?name=pi-manager-${task.id.replaceAll("-", "")}`, definition);
        if (!object(created) || typeof created.Id !== "string" || !HEX.test(created.Id)) throw new DockerOutcomeUnknownError();
        // Persist exact identity before start; even start failure must retain it.
        task = await this.#journal.transition(task.id, "running", "succeeded", { expectedRevision: task.revision, result: { containerId: created.Id, homeVolume } });
        const info = await this.#owned(task);
        if (!info) throw new DockerOutcomeUnknownError();
        await this.#savedWorkspace(task);
        await this.#engine.call("POST", `/containers/${created.Id}/start`);
        await this.#ready(task);
        return this.#identity(task);
      } catch (error) {
        if (task.state === "running") {
          // A volume or container may already exist even if a later known step failed.
          await this.#journal.transition(task.id, "running", "unknown", { expectedRevision: task.revision, result: { reason: "docker_reconciliation_required" } });
        }
        throw error;
      }
    });
  }

  inspect(instanceId: string): Promise<DockerInspection | null> {
    return this.#serial(async () => {
      const task = await this.#record(instanceId);
      if (!task) return null;
      await this.#daemon();
      const info = await this.#owned(task);
      return { ...this.#identity(task), status: !info ? "missing" : info.State?.Running === true ? "running" : "stopped" };
    });
  }

  list(): Promise<readonly DockerIdentity[]> {
    return this.#serial(async () => (await this.#journal.list()).filter(t => t.state === "succeeded").map(t => this.#identity(t)));
  }

  boundAuthority(instanceId: string): Promise<{ taskId: string; requester: string } | null> {
    return this.#serial(async () => {
      const record = (await this.#journal.list()).find(t => t.target === instanceId && t.state === "succeeded");
      const payload: unknown = record?.payload;
      const value = object(payload) ? payload.authority : undefined;
      return object(value) && typeof value.taskId === "string" && typeof value.requester === "string" ? { taskId: value.taskId, requester: value.requester } : null;
    });
  }

  start(instanceId: string): Promise<DockerInspection> { return this.#change(instanceId, "start"); }
  stop(instanceId: string): Promise<DockerInspection> { return this.#change(instanceId, "stop"); }

  #change(instanceId: string, action: "start" | "stop"): Promise<DockerInspection> {
    return this.#serial(async () => {
      const task = await this.#record(instanceId);
      if (!task) throw new DockerOperationError("Instance not owned");
      await this.#daemon();
      const info = await this.#owned(task);
      if (!info) throw new DockerOperationError("Owned container missing");
      const running = info.State?.Running === true;
      if (action === "start") {
        await this.#savedWorkspace(task);
        await this.#runtime();
        // Recover a missing export using the same durable key, never a new run.
        if (this.#enrollment) await this.#enrollment.issue(task.id, task.target);
        // Runtime/enrollment checks cross awaits. Recheck after them, directly
        // before the start mutation, not just at approval or initial inspection.
        await this.#savedWorkspace(task);
      }
      if ((action === "start") !== running) await this.#engine.call("POST", `/containers/${this.#identity(task).containerId}/${action}${action === "stop" ? "?t=10" : ""}`);
      const after = await this.#owned(task);
      if (!after || (after.State?.Running === true) !== (action === "start")) throw new DockerOutcomeUnknownError();
      if (action === "start") await this.#ready(task);
      return { ...this.#identity(task), status: action === "start" ? "running" : "stopped" };
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    this.#engine.close();
    this.#enrollment?.close();
    await this.#journal.close();
  }
}

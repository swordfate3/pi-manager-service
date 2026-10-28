import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { privateDirectory } from "./config.ts";
import type { LocalConfig } from "./local-config.ts";
import type { WorkspaceSelection } from "./api.ts";
import { WorkspacePolicy } from "./workspaces.ts";
import { canonical, identifier, keys, record, requireThat } from "./validation.ts";
import { LocalStore, type StoredRun } from "./local-store.ts";

const exec = promisify(execFile);
export interface LocalRun {
  id: string; workspace: WorkspaceSelection; state: "starting" | "ready" | "failed" | "stopping" | "stopped" | "unknown";
  path?: string; error?: string;
}
type RunRecord = StoredRun;
interface LiveRun { child: ChildProcessWithoutNullStreams; exited: Promise<void> }
export interface LocalReadiness { sessionPath(runId: string): Promise<string | undefined> }

/** Host-only owner service. Browser input never becomes an executable, flags, or mount list. */
export class LocalLauncher {
  readonly #config: LocalConfig; readonly #policy: WorkspacePolicy; readonly #ready: LocalReadiness;
  readonly #runs = new Map<string, RunRecord>(); readonly #live = new Map<string, LiveRun>();
  readonly #inspectAfter = new Map<string, number>();
  readonly #unverifiedContainers = new Set<string>();
  readonly #stops = new Set<Promise<void>>();
  #tail: Promise<unknown> = Promise.resolve(); #poll?: ReturnType<typeof setInterval>; #closing = false;
  #polling = false;
  readonly #lock: string;
  readonly #store:LocalStore; readonly #ownsStore:boolean;
  private constructor(config: LocalConfig, policy: WorkspacePolicy, ready: LocalReadiness, store:LocalStore, ownsStore:boolean) {
    this.#config = config; this.#policy = policy; this.#ready = ready; this.#lock = path.join(config.stateRoot, "owner.lock");
    this.#store=store; this.#ownsStore=ownsStore;
  }
  static async open(config: LocalConfig, policy: WorkspacePolicy, ready: LocalReadiness, store?:LocalStore) {
    await privateDirectory(config.stateRoot); await privateDirectory(path.join(config.stateRoot, "launches"));
    const lockPath=path.join(config.stateRoot,"owner.lock");
    const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); await lock.close();
    let value:LocalLauncher|undefined;
    try {
      value = new LocalLauncher(config, policy, ready, store ?? await LocalStore.open(config.stateRoot), !store);
      const stored = value.#store.runs();
      requireThat(Array.isArray(stored) && stored.length <= 1000);
      for (const run of stored) {
        requireThat(/^pi-local-[a-f0-9]{24}$/.test(run.id));
        // Never replay a launch after service restart. Reconcile the exact container instead.
        if (["starting", "ready", "stopping"].includes(run.state)) { run.state = "unknown"; delete run.path; run.error = "服务已重启，正在核对原容器；不会重复启动。"; }
        value.#runs.set(run.id, run);
      }
      await value.#refresh();
      const owner=value;
      value.#poll = setInterval(() => {
        if (owner.#polling || owner.#closing) return; owner.#polling = true;
        void owner.#serial(() => owner.#refresh()).catch(() => {}).finally(() => { owner.#polling = false; });
      }, 750); value.#poll.unref();
      return value;
    } catch (error) { if (value && value.#ownsStore) value.#store.close(); await unlink(lockPath); throw error; }
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.#tail.then(operation); this.#tail = result.catch(() => {}); return result; }
  #view(run: RunRecord): LocalRun { return { id: run.id, workspace: structuredClone(run.workspace), state: run.state,
    ...(run.path ? { path: run.path } : {}), ...(run.error ? { error: run.error } : {}) }; }
  list(): LocalRun[] { return [...this.#runs.values()].map(run => this.#view(run)).reverse(); }
  async #save() {
    if (!this.#closed) this.#store.saveRuns([...this.#runs.values()]);
  }
  start(value: unknown): Promise<LocalRun> {
    return this.#serial(async () => {
      requireThat(!this.#closing, 503);
      const request = record(value); keys(request, ["key", "workspace"]); const key = identifier(request.key);
      const workspace = await this.#policy.resolve(request.workspace);
      const existing = [...this.#runs.values()].find(run => run.key === key);
      if (existing) { requireThat(canonical(existing.workspace) === canonical(workspace), 409); return this.#view(existing); }
      requireThat(this.#runs.size < 1000, 503);
      const id = "pi-local-" + randomBytes(12).toString("hex");
      const run: RunRecord = { id, key, workspace, state: "starting", created: Date.now() };
      this.#runs.set(id, run); await this.#save();
      // Fixed executable/argv, no shell string and no caller-supplied environment.
      const child = spawn(this.#config.launcher, ["--mode", "rpc"], { cwd: path.join(this.#config.workspaceRoots[workspace.root], workspace.path),
        env: { ...process.env, PI_PIRUN_DOCKER_NAME: id, PI_PIRUN_WEB_HUB: "on",
          PI_PIRUN_WEB_HUB_HOST_CONFIG: path.join(this.#config.stateRoot, "chat.json"), PI_PIRUN_WEB_HUB_HOST_CLI: this.#config.hubCli,
          PI_PIRUN_WEB_HUB_RUNTIME_DIR: path.join(this.#config.stateRoot, "chat-runtime"), PI_PIRUN_WEB_HUB_RUNS_DIR: path.join(this.#config.stateRoot, "launches"),
          ...(this.#config.dockerExecutable ? { PI_PIRUN_DOCKER_BIN: this.#config.dockerExecutable } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
      run.pid = child.pid;
      // Never store/return stdout or stderr: extensions can print tokens and conversation content.
      child.stdout.resume(); child.stderr.resume();
      const exited = new Promise<void>(resolve => {
        let ended = false;
        const finish = () => { if (ended) return; ended = true;
          void this.#serial(async () => { this.#live.delete(id); if (run.state !== "stopped") {
            run.state = run.state === "stopping" ? "stopped" : "failed"; delete run.path;
            if (run.state === "failed") run.error = "Pi 启动或运行进程已退出。请检查本地启动器和 Docker 状态。";
            await this.#save();
          } }).finally(resolve);
        }; child.once("error", finish); child.once("exit", finish);
      });
      this.#live.set(id, { child, exited }); await this.#save(); return this.#view(run);
    });
  }
  async #inspect(run: RunRecord): Promise<any | undefined> {
    try {
      const { stdout } = await exec(this.#config.dockerExecutable ?? "/usr/bin/docker", ["inspect", run.id], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const [container] = JSON.parse(stdout);
      const expectedWorkspace = path.join(this.#config.workspaceRoots[run.workspace.root], run.workspace.path);
      requireThat(container.Name === "/" + run.id && container.Config?.Labels?.["cn.swordfate.pi.local-id"] === run.id &&
        container.Mounts?.some((mount: any) => mount.Destination === "/workspace" && mount.Source === expectedWorkspace), 403);
      requireThat(typeof container.State?.Running === "boolean", 503);
      if (run.containerId) requireThat(container.Id === run.containerId, 403); else run.containerId = container.Id;
      return container;
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      const missing = String(failure.stderr ?? "").match(/\bno such (?:object|container):\s*(\S+)\s*$/i);
      if (failure.code === 1 && missing?.[1] === run.id) return undefined;
      throw error;
    }
  }
  async #refresh() {
    let changed = false;
    const directories = await readdir(path.join(this.#config.stateRoot, "launches"), { withFileTypes: true });
    for (const run of this.#runs.values()) {
      if (["stopped", "stopping"].includes(run.state)) continue;
      const before = JSON.stringify(run);
      if (!run.runId && run.pid) for (const directory of directories) {
        if (!directory.isDirectory() || !/^[a-f0-9]{32}$/.test(directory.name)) continue;
        try {
          const launch = JSON.parse(await readFile(path.join(this.#config.stateRoot, "launches", directory.name, "launch.json"), "utf8"));
          if (launch.pid === run.pid && launch.workspace === path.join(this.#config.workspaceRoots[run.workspace.root], run.workspace.path) && launch.run_id === directory.name) run.runId = directory.name;
        } catch { /* Atomic launch publication may still be pending. */ }
      }
      if (run.containerId && run.runId && run.state !== "failed" && !this.#unverifiedContainers.has(run.id)) {
        const target = await this.#ready.sessionPath(run.runId);
        if (target) { run.state = "ready"; run.path = target; delete run.error; }
        else if (run.state === "ready") { run.state = "starting"; delete run.path; }
      }
      if (run.state === "starting" && Date.now() - run.created > (this.#config.startupTimeoutMs ?? 90000)) {
        run.state = "unknown"; run.error = "启动等待超时，原申请已保留；请先核对状态，不要重复创建。"; delete run.path;
      }
      // A launcher exit or stale registry lease is not a liveness oracle. Probe
      // failed/uncertain/ready runs too, without spawning Docker on every tick.
      if (["starting", "failed", "unknown", "ready"].includes(run.state) && Date.now() >= (this.#inspectAfter.get(run.id) ?? 0)) {
        this.#inspectAfter.set(run.id, Date.now() + 2000);
        try {
          const container = await this.#inspect(run);
          this.#unverifiedContainers.delete(run.id);
          let mayStillLaunch = !run.containerId && run.state !== "failed" && this.#live.has(run.id);
          if (!run.containerId && run.state !== "failed" && run.pid && !mayStillLaunch) {
            try { process.kill(run.pid, 0); mayStillLaunch = true; }
            catch (error) { mayStillLaunch = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
          }
          if (container?.State.Running === false || (!container && !mayStillLaunch)) {
            run.state = "stopped"; delete run.path; delete run.error;
          } else if (!container) {
            // An early registration is not proof that Docker has finished creating
            // this container. Keep the live launch visible, but not navigable yet.
            this.#unverifiedContainers.add(run.id);
            run.state = "unknown"; delete run.path;
            run.error = "启动器仍在运行，正在等待 Docker 确认容器；请勿重复创建。";
          } else if (container && run.state === "failed") {
            run.state = "unknown"; delete run.path;
            run.error = "启动器已退出，但容器仍在运行；请刷新核对或停止该实例。";
          }
        } catch {
          // Daemon/permission/identity failures do not prove the container ended.
          this.#unverifiedContainers.add(run.id);
          run.state = "unknown"; delete run.path;
          run.error = "暂时无法核对原容器状态，请检查 Docker 后刷新；不会接管或停止替代容器。";
        }
      }
      if (JSON.stringify(run) !== before) changed = true;
    }
    if (changed) await this.#save();
  }
  stop(value: unknown): Promise<LocalRun> {
    return this.#serial(async () => {
      const request = record(value); keys(request, ["id"]); const run = this.#runs.get(identifier(request.id)); requireThat(run, 404);
      if (["stopped", "failed", "stopping"].includes(run.state)) return this.#view(run);
      const container = await this.#inspect(run);
      requireThat(container, 409); run.state = "stopping"; delete run.path; await this.#save();
      // Stop by inspected immutable ID, not a user-controlled or reusable name. No volume deletion.
      const operation = (async () => {
        try {
          await exec(this.#config.dockerExecutable ?? "/usr/bin/docker", ["stop", "--time", "10", container.Id], { timeout: 15000, maxBuffer: 8192 });
          const observed = await this.#inspect(run); requireThat(!observed || observed.State.Running === false, 409);
          await this.#serial(async () => { run.state = "stopped"; delete run.error; await this.#save(); });
        } catch {
          await this.#serial(async () => { run.state = "unknown"; run.error = "停止结果尚未确认，请刷新核对原容器。"; await this.#save(); });
        }
      })();
      this.#stops.add(operation); void operation.finally(() => this.#stops.delete(operation));
      return this.#view(run);
    });
  }
  async close() {
    this.#closing = true; if (this.#poll) clearInterval(this.#poll); await this.#tail;
    await Promise.allSettled([...this.#stops]);
    // HTTP service shutdown does not delete shared homes or replay pending work.
    // Release stdin so only children launched by this controller can exit cleanly.
    for (const live of this.#live.values()) live.child.stdin.end();
    await Promise.race([Promise.all([...this.#live.values()].map(live => live.exited)), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]);
    await this.#tail; this.#closed=true; if(this.#ownsStore) this.#store.close(); await unlink(this.#lock);
  }
  #closed=false;
}

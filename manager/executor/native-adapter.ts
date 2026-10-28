import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeBackend, type NativeIdentity } from "../backends/native.ts";
import type { ExecutorConfig } from "../config.ts";
import type { TaskRequest, TaskRecord, JsonValue } from "../contracts.ts";
import type { WorkspaceSelection } from "../api.ts";
import { requireThat, record, keys } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";
import { ExecutionOutcomeUnknownError } from "../errors.ts";
import type { WorkspacePolicy } from "../workspaces.ts";

export class NativeTaskAdapter implements TaskBackendAdapter {
  readonly actions: readonly string[];
  readonly capabilities;
  readonly policy: JsonValue;
  readonly #backend: NativeBackend;
  readonly #config: ExecutorConfig;
  readonly #workspaces: WorkspacePolicy | undefined;
  readonly #owners = new Map<string, string>();
  readonly #starting = new Map<string, AbortController>();
  readonly #saved = new Map<string, { workspace: string | WorkspaceSelection; identity: NativeIdentity }>();
  readonly #blocked = new Set<string>();
  constructor(config: ExecutorConfig, workspaces?: WorkspacePolicy) {
    requireThat(config.trustedLocalNative && config.native, 503);
    this.#config = structuredClone(config);
    this.#workspaces = workspaces;
    this.#backend = new NativeBackend(this.#config.native!);
    this.actions = Object.freeze(config.native!.web ? ["create", "stop", "start"] : ["create", "stop"]);
    this.capabilities = { native: true, docker: false, isolation: "trusted-local-development" as const, enrollment: !!config.native!.web };
    this.policy = JSON.parse(JSON.stringify({ native: config.native, workspaces: config.workspaces, trustedLocalNative: true }));
  }
  async validate(request: TaskRequest) {
    if (request.action === "stop") { requireThat(this.#owners.get(request.target) === request.requester, 403); return; }
    if (request.action === "start") {
      requireThat(this.#config.native!.web, 503);
      requireThat(this.#owners.get(request.target) === request.requester, 403);
      requireThat(this.#saved.has(request.target) && !this.#blocked.has(request.target) && !this.#starting.has(request.target), 409);
      requireThat(await this.#backend.inspect(request.target) === null, 409); return;
    }
    requireThat(request.action === "create", 503);
    requireThat(!this.#owners.has(request.target), 409);
    await this.#workspace(request);
  }
  async #workspace(request: TaskRequest): Promise<WorkspaceSelection> {
    const payload = record(request.payload); keys(payload, ["workspace"]); const selection = payload.workspace;
    if (this.#workspaces) return await this.#workspaces.resolve(selection);
    requireThat(typeof selection === "string" && Object.hasOwn(this.#config.workspaces, selection));
    const w = this.#config.workspaces[selection];
    try {
      const root = await realpath(this.#config.native!.workspaceRoots[w.root]);
      const selected = await realpath(path.resolve(root, w.path)); const relative = path.relative(root, selected);
      requireThat(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && (await stat(selected)).isDirectory());
    } catch { requireThat(false); }
    return { root: w.root, path: w.path };
  }
  async execute(task: TaskRecord) {
    if (task.action === "create") {
      // A logical name is never reused, including after an exited/stopped child.
      // Reserve synchronously, before workspace checks or process startup can yield.
      // A previously approved stop can therefore never cross resource generations.
      requireThat(!this.#owners.has(task.target), 409);
      this.#owners.set(task.target, task.requester);
      const controller = new AbortController();
      this.#starting.set(task.target, controller);
      try {
        const resolved = await this.#workspace(task);
        // A stop can arrive before the backend knows this create exists.
        // Cancellation must survive workspace resolution and prevent a later launch.
        controller.signal.throwIfAborted();
        const identity = await this.#backend.create({ instanceId: task.target, workspace: resolved }, { signal: controller.signal });
        // Backend loads only the explicitly configured thin Web and instance grant.
        // Private paths/PID must never enter the public TaskView.
        const saved = { workspace: structuredClone(record(task.payload).workspace) as string | WorkspaceSelection, identity };
        this.#saved.set(task.target, saved);
        return { status: "created", instanceId: identity.instanceId, saved: JSON.parse(JSON.stringify(saved)) as JsonValue };
      } finally { this.#starting.delete(task.target); }
    }
    if (task.action === "start") {
      // Reserve synchronously before any await, including ownership/state validation.
      requireThat(this.#config.native!.web, 503);
      requireThat(this.#owners.get(task.target) === task.requester, 403);
      requireThat(this.#saved.has(task.target) && !this.#blocked.has(task.target) && !this.#starting.has(task.target), 409);
      const controller = new AbortController(); this.#starting.set(task.target, controller);
      try {
        requireThat(await this.#backend.inspect(task.target) === null, 409);
        controller.signal.throwIfAborted();
        const saved = this.#saved.get(task.target)!;
        const resolved = this.#workspaces ? await this.#workspaces.resolve(saved.workspace) : (() => {
          requireThat(typeof saved.workspace === "string" && Object.hasOwn(this.#config.workspaces, saved.workspace), 409);
          const w = this.#config.workspaces[saved.workspace]; return { root: w.root, path: w.path };
        })();
        const identity = await this.#backend.resume({ instanceId: task.target, workspace: resolved }, saved.identity, { signal: controller.signal });
        const next = { workspace: saved.workspace, identity }; this.#saved.set(task.target, next);
        return { status: "started", instanceId: task.target, saved: JSON.parse(JSON.stringify(next)) as JsonValue };
      } catch (error) { this.#blocked.add(task.target); throw error; }
      finally { this.#starting.delete(task.target); }
    }
    await this.validate(task);
    this.#starting.get(task.target)?.abort();
    try {
      const result = await this.#backend.stop(task.target);
      if (result.status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
      return { status: result.status, instanceId: task.target };
    } catch (error) {
      // A removed child handle is not proof that revocation/termination completed.
      if (error instanceof ExecutionOutcomeUnknownError) this.#blocked.add(task.target);
      throw error;
    }
  }
  restore(records: readonly TaskRecord[]) {
    // Saved-data proofs only: never reconstruct child handles or adopt persisted PIDs.
    for (const task of records) if (task.action === "create" && ["running", "succeeded", "failed", "unknown"].includes(task.state)) this.#owners.set(task.target, task.requester);
    for (const task of records) {
      if (this.#owners.get(task.target) !== task.requester) continue;
      if (["create", "start", "stop"].includes(task.action) && ["unknown", "running"].includes(task.state)) this.#blocked.add(task.target);
      // A failed new generation may already have touched saved data. Its authoritative
      // failure tombstone must outlive this executor, even after a later approved stop.
      if (task.action === "start" && task.state === "failed") this.#blocked.add(task.target);
      if (!["create", "start"].includes(task.action) || task.state !== "succeeded") continue;
      if (task.result === undefined) continue;
      const result = record(task.result); if (result.saved === undefined) continue;
      const saved = record(result.saved), identity = record(saved.identity);
      const workspace = saved.workspace;
      const dynamic = workspace !== null && typeof workspace === "object" && !Array.isArray(workspace) ? workspace as Record<string, unknown> : undefined;
      requireThat((typeof workspace === "string" && Object.hasOwn(this.#config.workspaces, workspace)) ||
        (this.#config.workspaceBrowser !== undefined && dynamic !== undefined && Object.keys(dynamic).length === 2 &&
          typeof dynamic.root === "string" && typeof dynamic.path === "string"), 409);
      requireThat(identity.instanceId === task.target && Number.isSafeInteger(identity.generation), 409);
      const prior = this.#saved.get(task.target);
      if (!prior || (identity.generation as number) > (prior.identity.generation ?? 0)) this.#saved.set(task.target, structuredClone(saved) as unknown as { workspace: string | WorkspaceSelection; identity: NativeIdentity });
    }
  }
  resources(requester: string) { return this.#backend.list().filter(i => this.#owners.get(i.instanceId) === requester).map(i => ({ instanceId: i.instanceId })); }
  async close() {
    const results = await Promise.allSettled(this.#backend.list().map(i => this.#backend.stop(i.instanceId)));
    requireThat(results.every(r => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
  }
}

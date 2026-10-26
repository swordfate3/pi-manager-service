import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeBackend, type NativeIdentity } from "../backends/native.ts";
import type { ExecutorConfig } from "../config.ts";
import type { TaskRequest, TaskRecord, JsonValue } from "../contracts.ts";
import { requireThat, record } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";
import { ExecutionOutcomeUnknownError } from "../errors.ts";

export class NativeTaskAdapter implements TaskBackendAdapter {
  readonly actions: readonly string[];
  readonly capabilities;
  readonly policy: JsonValue;
  readonly #backend: NativeBackend;
  readonly #config: ExecutorConfig;
  readonly #owners = new Map<string, string>();
  readonly #starting = new Map<string, AbortController>();
  readonly #saved = new Map<string, { workspace: string; identity: NativeIdentity }>();
  readonly #blocked = new Set<string>();
  constructor(config: ExecutorConfig) {
    requireThat(config.trustedLocalNative && config.native, 503);
    this.#config = structuredClone(config);
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
  async #workspace(request: TaskRequest) {
    const payload = record(request.payload); const selection = payload.workspace;
    requireThat(typeof selection === "string" && Object.hasOwn(this.#config.workspaces, selection));
    const w = this.#config.workspaces[selection];
    try {
      const root = await realpath(this.#config.native!.workspaceRoots[w.root]);
      const selected = await realpath(path.resolve(root, w.path)); const relative = path.relative(root, selected);
      requireThat(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && (await stat(selected)).isDirectory());
    } catch { requireThat(false); }
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
        await this.#workspace(task);
        // A stop can arrive before the backend knows this create exists.
        // Cancellation must survive workspace resolution and prevent a later launch.
        controller.signal.throwIfAborted();
        const w = this.#config.workspaces[record(task.payload).workspace as string];
        const identity = await this.#backend.create({ instanceId: task.target, workspace: { root: w.root, path: w.path } }, { signal: controller.signal });
        // Backend loads only the explicitly configured thin Web and instance grant.
        // Private paths/PID must never enter the public TaskView.
        const saved = { workspace: record(task.payload).workspace as string, identity };
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
        const w = this.#config.workspaces[saved.workspace]; requireThat(w, 409);
        const identity = await this.#backend.resume({ instanceId: task.target, workspace: { root: w.root, path: w.path } }, saved.identity, { signal: controller.signal });
        const next = { workspace: saved.workspace, identity }; this.#saved.set(task.target, next);
        return { status: "started", instanceId: task.target, saved: JSON.parse(JSON.stringify(next)) as JsonValue };
      } catch (error) { this.#blocked.add(task.target); throw error; }
      finally { this.#starting.delete(task.target); }
    }
    await this.validate(task);
    this.#starting.get(task.target)?.abort();
    const result = await this.#backend.stop(task.target);
    if (result.status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
    return { status: result.status, instanceId: task.target };
  }
  restore(records: readonly TaskRecord[]) {
    // Saved-data proofs only: never reconstruct child handles or adopt persisted PIDs.
    for (const task of records) if (task.action === "create" && ["running", "succeeded", "failed", "unknown"].includes(task.state)) this.#owners.set(task.target, task.requester);
    for (const task of records) {
      if (this.#owners.get(task.target) !== task.requester) continue;
      if (["create", "start", "stop"].includes(task.action) && ["unknown", "running"].includes(task.state)) this.#blocked.add(task.target);
      if (!["create", "start"].includes(task.action) || task.state !== "succeeded") continue;
      if (task.result === undefined) continue;
      const result = record(task.result); if (result.saved === undefined) continue;
      const saved = record(result.saved), identity = record(saved.identity);
      requireThat(typeof saved.workspace === "string" && Object.hasOwn(this.#config.workspaces, saved.workspace) && identity.instanceId === task.target && Number.isSafeInteger(identity.generation), 409);
      const prior = this.#saved.get(task.target);
      if (!prior || (identity.generation as number) > (prior.identity.generation ?? 0)) this.#saved.set(task.target, structuredClone(saved) as unknown as { workspace: string; identity: NativeIdentity });
    }
  }
  resources(requester: string) { return this.#backend.list().filter(i => this.#owners.get(i.instanceId) === requester).map(i => ({ instanceId: i.instanceId })); }
  async close() {
    const results = await Promise.allSettled(this.#backend.list().map(i => this.#backend.stop(i.instanceId)));
    requireThat(results.every(r => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
  }
}

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeBackend } from "../backends/native.ts";
import type { ExecutorConfig } from "../config.ts";
import type { TaskRequest, TaskRecord, JsonValue } from "../contracts.ts";
import { requireThat, record } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";
import { ExecutionOutcomeUnknownError } from "../errors.ts";

export class NativeTaskAdapter implements TaskBackendAdapter {
  readonly actions = ["create", "stop"] as const;
  readonly capabilities;
  readonly policy: JsonValue;
  readonly #backend: NativeBackend;
  readonly #config: ExecutorConfig;
  readonly #owners = new Map<string, string>();
  readonly #starting = new Map<string, AbortController>();
  constructor(config: ExecutorConfig) {
    requireThat(config.trustedLocalNative && config.native, 503);
    this.#config = structuredClone(config);
    this.#backend = new NativeBackend(this.#config.native!);
    this.capabilities = { native: true, docker: false, isolation: "trusted-local-development" as const, enrollment: !!config.native!.web };
    this.policy = JSON.parse(JSON.stringify({ native: config.native, workspaces: config.workspaces, trustedLocalNative: true }));
  }
  async validate(request: TaskRequest) {
    if (request.action === "stop") { requireThat(this.#owners.get(request.target) === request.requester, 403); return; }
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
        return { status: "created", instanceId: identity.instanceId };
      } finally { this.#starting.delete(task.target); }
    }
    await this.validate(task);
    this.#starting.get(task.target)?.abort();
    const result = await this.#backend.stop(task.target);
    if (result.status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
    return { status: result.status, instanceId: task.target };
  }
  restore(records: readonly TaskRecord[]) {
    // Tombstones only: never reconstruct child handles or adopt persisted PIDs.
    for (const task of records) if (task.action === "create" && ["running", "succeeded", "failed", "unknown"].includes(task.state)) this.#owners.set(task.target, task.requester);
  }
  resources(requester: string) { return this.#backend.list().filter(i => this.#owners.get(i.instanceId) === requester).map(i => ({ instanceId: i.instanceId })); }
  async close() {
    const results = await Promise.allSettled(this.#backend.list().map(i => this.#backend.stop(i.instanceId)));
    requireThat(results.every(r => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
  }
}

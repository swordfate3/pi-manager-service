import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeBackend } from "../backends/native.ts";
import type { ExecutorConfig } from "../config.ts";
import type { TaskRequest, TaskRecord, JsonValue } from "../contracts.ts";
import { requireThat, record } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";

export class NativeTaskAdapter implements TaskBackendAdapter {
  readonly actions = ["create", "stop"] as const;
  readonly policy: JsonValue;
  readonly #backend: NativeBackend;
  readonly #config: ExecutorConfig;
  readonly #owners = new Map<string, string>();
  constructor(config: ExecutorConfig) {
    requireThat(config.trustedLocalNative && config.native, 503);
    this.#config = structuredClone(config);
    this.#backend = new NativeBackend(this.#config.native!);
    this.policy = JSON.parse(JSON.stringify({ native: config.native, workspaces: config.workspaces, trustedLocalNative: true }));
  }
  async validate(request: TaskRequest) {
    if (request.action === "stop") { requireThat(this.#owners.get(request.target) === request.requester, 403); return; }
    requireThat(request.action === "create", 503);
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
    await this.validate(task);
    if (task.action === "create") {
      const w = this.#config.workspaces[record(task.payload).workspace as string];
      const identity = await this.#backend.create({ instanceId: task.target, workspace: { root: w.root, path: w.path } });
      this.#owners.set(identity.instanceId, task.requester);
      // Enrollment seam: a future administrator-provisioned registrar can consume identity here.
      // Identity includes private paths/PID: it must never enter the public TaskView.
      return { status: "created", instanceId: identity.instanceId };
    }
    const result = await this.#backend.stop(task.target);
    requireThat(result.status !== "ownership-lost", 503);
    this.#owners.delete(task.target); return { status: result.status, instanceId: task.target };
  }
  resources(requester: string) { return this.#backend.list().filter(i => this.#owners.get(i.instanceId) === requester).map(i => ({ instanceId: i.instanceId })); }
  async close() {
    const results = await Promise.allSettled(this.#backend.list().map(i => this.#backend.stop(i.instanceId)));
    requireThat(results.every(r => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
  }
}

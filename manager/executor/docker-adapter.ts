import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DockerBackend } from "../backends/docker.ts";
import { executorConfig, privateDirectory, type ExecutorConfig } from "../config.ts";
import type { JsonValue, TaskRecord, TaskRequest } from "../contracts.ts";
import { keys, record, requireThat } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";

/** Requester authority belongs to TaskStore; exact container identity belongs to DockerBackend. */
export class DockerTaskAdapter implements TaskBackendAdapter {
  readonly actions = ["create", "stop", "start"] as const;
  readonly capabilities;
  readonly policy: JsonValue;
  readonly #config: ExecutorConfig;
  readonly #backend: DockerBackend;
  readonly #owners = new Map<string, string>();

  private constructor(config: ExecutorConfig, backend: DockerBackend) {
    this.#config = config; this.#backend = backend;
    this.capabilities = { native: false, docker: true, isolation: "fixed-container" as const, enrollment: !!config.docker?.web };
    this.policy = JSON.parse(JSON.stringify({ docker: config.docker, workspaces: config.workspaces }));
  }

  static async open(value: ExecutorConfig): Promise<DockerTaskAdapter> {
    const config = executorConfig(value);
    requireThat(config.docker, 503);
    // Pin the filesystem-resolved socket path, and check both alias and destination against the roots.
    config.docker = { ...config.docker, socketPath: await realpath(config.docker.socketPath) };
    executorConfig(config);
    // A symlinked ancestor would defeat lexical authority/workspace overlap checks.
    await privateDirectory(config.docker.stateRoot);
    config.docker = { ...config.docker, protectedRoots: [...(config.docker.protectedRoots ?? []),
      config.stateRoot, path.dirname(config.submitSocket), path.dirname(config.adminSocket)] };
    return new DockerTaskAdapter(config, await DockerBackend.open(config.docker));
  }

  async restore(records: readonly TaskRecord[]) {
    // Unknown creates reserve the logical name even when the backend has no usable identity.
    for (const task of records) {
      if (task.action !== "create" || !["succeeded", "unknown", "failed"].includes(task.state)) continue;
      if (task.state === "failed") {
        // A failed start can follow a durably committed exact container identity.
        // Only the backend's original task binding grants partial-success recovery;
        // duplicate/pre-mutation failed creates must not acquire someone else's target.
        const binding = await this.#backend.boundAuthority(task.target);
        if (binding?.taskId !== task.id || binding.requester !== task.requester) continue;
      }
      requireThat(!this.#owners.has(task.target), 409);
      this.#owners.set(task.target, task.requester);
    }
  }

  async #workspace(request: TaskRequest) {
    const payload = record(request.payload); keys(payload, ["workspace"]);
    requireThat(typeof payload.workspace === "string" && Object.hasOwn(this.#config.workspaces, payload.workspace));
    const w = this.#config.workspaces[payload.workspace];
    const root = this.#config.docker!.workspaceRoots[w.root];
    try {
      requireThat(await realpath(root) === root);
      const selected = await realpath(path.resolve(root, w.path)); const relative = path.relative(root, selected);
      requireThat(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && (await stat(selected)).isDirectory());
    } catch { requireThat(false); }
    return w;
  }

  async validate(request: TaskRequest) {
    if (request.action === "create") {
      requireThat(!this.#owners.has(request.target), 409);
      // A journal entry without an authoritative owner must never be adopted by a new create.
      requireThat(!(await this.#backend.list()).some(i => i.instanceId === request.target), 409);
      await this.#workspace(request); return;
    }
    requireThat(request.action === "stop" || request.action === "start", 503);
    keys(record(request.payload), []);
    requireThat(this.#owners.get(request.target) === request.requester, 403);
    const owned = await this.#backend.inspect(request.target);
    requireThat(owned && owned.status !== "missing", 409);
  }

  async execute(task: TaskRecord) {
    if (task.action === "create") {
      // Reserve before the first await: independent approved creates cannot race into the same name.
      requireThat(!this.#owners.has(task.target), 409);
      this.#owners.set(task.target, task.requester);
      requireThat(!(await this.#backend.list()).some(i => i.instanceId === task.target), 409);
      const w = await this.#workspace(task);
      const identity = await this.#backend.create({ instanceId: task.target, workspace: { root: w.root, path: w.path } }, { taskId: task.id, requester: task.requester });
      return { status: "created", instanceId: identity.instanceId };
    }
    await this.validate(task);
    const result = task.action === "start" ? await this.#backend.start(task.target) : await this.#backend.stop(task.target);
    return { status: result.status, instanceId: task.target };
  }

  async resources(requester: string) {
    return (await this.#backend.list()).filter(i => this.#owners.get(i.instanceId) === requester).map(i => ({ instanceId: i.instanceId }));
  }
  close() { return this.#backend.close(); }
}

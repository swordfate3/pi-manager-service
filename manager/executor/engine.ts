import { TaskStore, TaskStoreConflictError } from "../task-store.ts";
import type { TaskRecord, TaskRequest } from "../contracts.ts";
import type { ExecutorConfig } from "../config.ts";
import { canonical, digest, equalHash, identifier, keys, ManagerError, record, requireThat, revision, taskId, token } from "../validation.ts";
import type { TaskBackendAdapter } from "./adapter.ts";
import type { ApprovalBinding, TaskView, VersionCatalogPage, VersionQueryOptions } from "../api.ts";
import { DockerOutcomeUnknownError } from "../backends/docker-engine.ts";
import { ExecutionOutcomeUnknownError } from "../errors.ts";
import { CatalogError, PI_PACKAGE, ReleaseCatalog } from "../updates/catalog.ts";

type Principal = ExecutorConfig["principals"][number];
interface TaskEngineOptions { readonly catalog?: ReleaseCatalog }
const MAX_VERSION_QUERIES = 16;
function requestHash(t: TaskRequest) { return digest(canonical({ key: t.key, requester: t.requester, target: t.target, action: t.action, payload: t.payload })); }
function view(t: TaskRecord): TaskView {
  const { result, ...rest } = t;
  // Never project arbitrary backend data, errors, private paths or process identities.
  const r = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
  return { ...rest, ...(r && typeof r.status === "string" ? { result: { status: r.status, ...(typeof r.instanceId === "string" ? { instanceId: r.instanceId } : {}) } } : {}) };
}

export class TaskEngine {
  readonly #config: ExecutorConfig;
  readonly #store: TaskStore;
  readonly #adapter: TaskBackendAdapter | undefined;
  readonly #policyHash: string;
  readonly #adapterPolicy: string;
  readonly #approvals = new Map<string, ApprovalBinding>();
  readonly #running = new Set<Promise<void>>();
  readonly #catalog: ReleaseCatalog;
  readonly #catalogQueries = new Set<Promise<VersionCatalogPage>>();
  readonly #shutdown = new AbortController();
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  #closePromise?: Promise<void>;
  private constructor(config: ExecutorConfig, store: TaskStore, adapter: TaskBackendAdapter | undefined, options: TaskEngineOptions) {
    this.#config = structuredClone(config); this.#store = store; this.#adapter = adapter;
    this.#catalog = options.catalog ?? new ReleaseCatalog({ metadataDeadlineMs: 2500 });
    this.#adapterPolicy = canonical({ policy: adapter?.policy ?? null, actions: adapter?.actions ?? [] });
    this.#policyHash = digest(canonical({ workspaces: config.workspaces, principals: config.principals.map(p => ({ id: p.id, role: p.role })), adapter: this.#adapterPolicy }));
  }
  static async open(config: ExecutorConfig, adapter?: TaskBackendAdapter, options: TaskEngineOptions = {}) {
    const store = await TaskStore.open(config.stateRoot, { recoverStaleLock: config.recoverStaleLock });
    const engine = new TaskEngine(config, store, adapter, options);
    try {
      for (const task of await store.list()) {
        if (task.state === "running" || task.state === "waiting_idle") await store.transition(task.id, task.state, "unknown", { expectedRevision: task.revision });
      }
      await adapter?.restore?.(await store.list());
      return engine;
    } catch (error) { await store.close(); throw error; }
  }
  async dispatch(transport: "submit" | "admin", credential: string, message: unknown): Promise<unknown> {
    requireThat(!this.#closing, 503);
    // Authentication is repeated inside the executor, including direct socket callers.
    const h = digest(token(credential));
    const principal = this.#config.principals.find(p => equalHash(p.tokenHash, h));
    requireThat(principal, 401);
    requireThat(transport === "admin" ? principal.role === "admin" : principal.role === "submitter", 403);
    const m = record(message);
    const admin = transport === "admin";
    if (["review", "approve", "execute"].includes(m.op as string)) requireThat(admin, 403);
    // Freeze attacker-controlled data before queueing any asynchronous operation.
    const copy = structuredClone(m);
    if (copy.op === "versions") return await this.#versions(copy);
    const pending = this.#tail.then(() => this.#handle(principal, admin, copy));
    this.#tail = pending.catch(() => {});
    try { return await pending; } catch (e) { if (e instanceof TaskStoreConflictError) throw new ManagerError(409); throw e; }
  }
  async #versions(message: Record<string, unknown>): Promise<VersionCatalogPage> {
    keys(message, ["op", "options"]);
    const options = record(message.options); keys(options, [], ["query", "cursor", "limit"]);
    const copy = structuredClone(options) as VersionQueryOptions;
    requireThat(this.#catalogQueries.size < MAX_VERSION_QUERIES, 503);
    const operation = this.#catalog.list(PI_PACKAGE, copy).catch(error => {
      if (error instanceof CatalogError && error.code === "invalid-query") throw new ManagerError(400);
      throw new ManagerError(503);
    });
    this.#catalogQueries.add(operation);
    try { return await operation; } finally { this.#catalogQueries.delete(operation); }
  }
  async #task(id: unknown, p: Principal, admin: boolean) {
    const task = await this.#store.get(taskId(id));
    requireThat(task && (admin || task.requester === p.id), 404); return task;
  }
  #assertPolicy() {
    requireThat(canonical({ policy: this.#adapter?.policy ?? null, actions: this.#adapter?.actions ?? [] }) === this.#adapterPolicy, 409);
  }
  async #handle(p: Principal, admin: boolean, m: Record<string, unknown>): Promise<unknown> {
    if (m.op === "capabilities") {
      keys(m, ["op"]);
      const capabilities = this.#adapter?.capabilities;
      return { native: capabilities?.native ?? false, docker: capabilities?.docker ?? false,
        isolation: capabilities?.isolation ?? "unavailable", enrollment: capabilities?.enrollment ?? false, updates: false, approval: admin };
    }
    if (m.op === "workspaces") { keys(m, ["op"]); return Object.entries(this.#config.workspaces).map(([id, w]) => ({ id, label: w.label })); }
    if (m.op === "resources") { keys(m, ["op"]); return await this.#adapter?.resources(p.id) ?? []; }
    if (m.op === "list") {
      keys(m, ["op"]); const list = await this.#store.list();
      return list.filter((t): t is TaskRecord => !!t && (admin || t.requester === p.id)).map(view);
    }
    if (m.op === "submit") {
      keys(m, ["op", "request"]); const r = record(m.request);
      requireThat(r.action === "create" || r.action === "stop" || r.action === "start", 503);
      keys(r, r.action === "create" ? ["key", "action", "target", "workspace"] : ["key", "action", "target"]);
      const request: TaskRequest = { key: identifier(r.key), requester: p.id, target: identifier(r.target), action: r.action, payload: r.action === "create" ? { workspace: identifier(r.workspace) } : {} };
      if (r.action === "create") requireThat(Object.hasOwn(this.#config.workspaces, r.workspace as string));
      requireThat(this.#adapter?.actions.includes(r.action), 503);
      // Idempotency must work even after a stop/restart removed the live resource.
      const existing = (await this.#store.list()).find(t => t.requester === p.id && t.key === r.key);
      if (!existing) await this.#adapter!.validate(request);
      const task = await this.#store.submit(request); return view(task);
    }
    if (m.op === "get" || m.op === "review") {
      keys(m, ["op", "taskId"]); const t = await this.#task(m.taskId, p, admin);
      if (m.op === "get") return view(t);
      return { task: view(t), binding: { taskId: t.id, revision: t.revision, requestHash: requestHash(t), policyHash: this.#policyHash }, requiresFreshApproval: !this.#approvals.has(t.id) };
    }
    if (m.op === "approve") {
      keys(m, ["op", "taskId", "revision", "requestHash", "policyHash"]);
      const t = await this.#task(m.taskId, p, admin);
      requireThat(t.requester !== p.id, 403);
      requireThat(t.revision === revision(m.revision) && ["pending_approval", "queued"].includes(t.state) && !this.#approvals.has(t.id), 409);
      requireThat(m.requestHash === requestHash(t) && m.policyHash === this.#policyHash, 409);
      this.#assertPolicy();
      requireThat(this.#adapter?.actions.includes(t.action), 503); await this.#adapter!.validate(t);
      this.#assertPolicy();
      const approved = t.state === "pending_approval" ? await this.#store.transition(t.id, "pending_approval", "queued", { expectedRevision: t.revision }) : t;
      this.#approvals.set(t.id, { taskId: t.id, revision: approved.revision, requestHash: requestHash(t), policyHash: this.#policyHash });
      return view(approved);
    }
    if (m.op === "execute") {
      keys(m, ["op", "taskId", "revision"]); const t = await this.#task(m.taskId, p, admin);
      requireThat(t.revision === revision(m.revision) && ["pending_approval", "queued"].includes(t.state), 409);
      const approval = this.#approvals.get(t.id);
      requireThat(approval && t.state === "queued" && approval.revision === t.revision && approval.requestHash === requestHash(t) && approval.policyHash === this.#policyHash, 403);
      this.#assertPolicy();
      requireThat(this.#adapter?.actions.includes(t.action), 503); await this.#adapter!.validate(t);
      this.#assertPolicy();
      const started = await this.#store.transition(t.id, "queued", this.#adapter!.waitForIdle ? "waiting_idle" : "running", { expectedRevision: t.revision });
      this.#approvals.delete(t.id);
      // Backend work belongs to the executor, never the HTTP client lifetime.
      const operation = this.#execute(started); this.#running.add(operation);
      void operation.finally(() => this.#running.delete(operation)); return view(started);
    }
    throw new ManagerError(400);
  }
  async #execute(task: TaskRecord) {
    let executionStarted = false;
    try {
      if (task.state === "waiting_idle") {
        await this.#waitForIdle(task);
        this.#shutdown.signal.throwIfAborted(); this.#assertPolicy();
        await this.#adapter!.validate(structuredClone(task));
        this.#shutdown.signal.throwIfAborted(); this.#assertPolicy();
        task = await this.#store.transition(task.id, "waiting_idle", "running", { expectedRevision: task.revision });
      }
      this.#shutdown.signal.throwIfAborted();
      executionStarted = true;
      const result = await this.#adapter!.execute(structuredClone(task));
      await this.#store.transition(task.id, "running", "succeeded", { expectedRevision: task.revision, result });
    } catch (error) {
      // If persistence is uncertain TaskStore poisons writes. Restart turns any remaining running task unknown.
      const unknown = error instanceof DockerOutcomeUnknownError || error instanceof ExecutionOutcomeUnknownError;
      const stopping = !executionStarted && this.#shutdown.signal.aborted && error === this.#shutdown.signal.reason;
      await this.#store.transition(task.id, task.state, unknown ? "unknown" : stopping ? "cancelled" : "failed", {
        expectedRevision: task.revision, result: { status: unknown ? "execution-outcome-unknown" : stopping ? "executor-stopping" : "execution-failed" },
      }).catch(() => {});
    }
  }
  async #waitForIdle(task: TaskRecord) {
    const signal = this.#shutdown.signal; signal.throwIfAborted();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // The abandoned observation cannot write task state or authorize execution.
      await Promise.race([this.#adapter!.waitForIdle!(structuredClone(task), signal), aborted]);
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  close() {
    this.#closing = true;
    this.#shutdown.abort();
    return this.#closePromise ??= (async () => {
      await this.#tail; await Promise.all(this.#running); await Promise.allSettled([...this.#catalogQueries]);
      // Close store even when child ownership cannot be confirmed; report failure, never claim clean exit.
      try { await this.#adapter?.close(); } finally { this.#approvals.clear(); await this.#store.close(); }
    })();
  }
}

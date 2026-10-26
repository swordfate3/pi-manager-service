import { request } from "node:http";
import { ManagerError, requireThat, token } from "../validation.ts";
import type { TaskClient, TaskSubmission, TaskView, WorkspaceChoice, Capabilities, VersionCatalogPage, VersionQueryOptions } from "../api.ts";

/** No TaskStore, backend, admin credential, subprocess or policy dependency. */
export class ExecutorClient implements TaskClient {
  readonly #socketPath: string;
  readonly #credential: string;
  constructor(options: { socketPath: string; credential: string }) { this.#socketPath = options.socketPath; this.#credential = token(options.credential); }
  protected call(message: unknown): Promise<any> {
    const data = JSON.stringify(message); requireThat(Buffer.byteLength(data) <= 8192, 413);
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.#socketPath, path: "/rpc", method: "POST", agent: false, headers: { Host: "executor", Authorization: `Bearer ${this.#credential}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        res.on("error", () => reject(new ManagerError(503)));
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) return reject(new ManagerError([400,401,403,404,409,413,503].includes(res.statusCode!) ? res.statusCode! : 503));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new ManagerError(503)); }
        });
      });
      const timer = setTimeout(() => req.destroy(), 4000);
      req.on("error", () => { clearTimeout(timer); reject(new ManagerError(503)); }); req.end(data);
    });
  }
  submitTask(request: TaskSubmission): Promise<TaskView> { return this.call({ op: "submit", request }); }
  getTask(taskId: string): Promise<TaskView> { return this.call({ op: "get", taskId }); }
  listTasks(): Promise<TaskView[]> { return this.call({ op: "list" }); }
  versions(options: VersionQueryOptions = {}): Promise<VersionCatalogPage> { return this.call({ op: "versions", options }); }
  workspaces(): Promise<WorkspaceChoice[]> { return this.call({ op: "workspaces" }); }
  capabilities(): Promise<Capabilities> { return this.call({ op: "capabilities" }); }
  resources(): Promise<{ instanceId: string }[]> { return this.call({ op: "resources" }); }
}

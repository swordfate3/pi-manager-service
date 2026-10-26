import { serviceConfig } from "./config.ts";
import { ExecutorClient } from "./executor/client.ts";
import { bearer, boundary, jsonBody, listen, reply } from "./http.ts";
import { ManagerError, requireThat, taskId } from "./validation.ts";
import type { TaskSubmission, VersionQueryOptions } from "./api.ts";
import { renderPage, renderScript } from "./ui.ts";
import { createMcpHandler } from "./mcp/server.ts";

/** Public process: no TaskStore, native backend, spawn, policy or admin client. */
export async function startService(value: unknown) {
  const config = serviceConfig(value);
  const mcp = createMcpHandler(config);
  return listen(async (req, res) => {
    // MCP's native clients do not send browser Origin. Its own authenticated
    // boundary checks supplied Origin and exact Host before protocol parsing.
    if (req.url === "/mcp") { await mcp(req, res); return; }
    boundary(req, config.origin);
    if (req.method === "GET" && req.url === "/") {
      renderPage(res, false, config.chatOrigin); return;
    }
    if (req.method === "GET" && req.url === "/app.js") { renderScript(res); return; }
    const client = new ExecutorClient({ socketPath: config.socketPath, credential: bearer(req) });
    if (/\/(approve|execute|review)(\/|$)/.test(req.url!)) throw new ManagerError(403);
    if (req.method === "POST" && req.url === "/api/manager/versions") { reply(res, 200, await client.versions(await jsonBody(req) as VersionQueryOptions)); return; }
    if (req.method === "POST" && req.url === "/api/manager/tasks") { reply(res, 202, await client.submitTask(await jsonBody(req) as TaskSubmission)); return; }
    requireThat(req.method === "GET", 404);
    if (req.url === "/api/manager/tasks") reply(res, 200, await client.listTasks());
    else if (req.url === "/api/manager/workspaces") reply(res, 200, await client.workspaces());
    else if (req.url === "/api/manager/capabilities") reply(res, 200, await client.capabilities());
    else if (req.url === "/api/manager/resources") reply(res, 200, await client.resources());
    else if (req.url?.startsWith("/api/manager/tasks/")) reply(res, 200, await client.getTask(taskId(req.url.slice("/api/manager/tasks/".length))));
    else throw new ManagerError(404);
  }, config.port);
}

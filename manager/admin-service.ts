import { randomBytes } from "node:crypto";
import { serviceConfig } from "./config.ts";
import { AdminClient } from "./executor/admin-client.ts";
import { bearer, boundary, jsonBody, listen, reply } from "./http.ts";
import { keys, ManagerError, record, requireThat, taskId, token } from "./validation.ts";
import { renderPage, renderScript } from "./ui.ts";
import type { ApprovalBinding, TaskSubmission } from "./api.ts";

/** Run privately, with only the separately provisioned admin socket accessible.
 * Credentials are typed into this origin, exchanged for short-lived memory-only bearer,
 * never embedded in HTML, URL, logs, shared HOME or the public proxy process.
 */
export async function startAdminService(value: unknown) {
  const config = serviceConfig(value);
  const sessions = new Map<string, { expires: number; client: AdminClient }>();
  let attempts = 0; let windowEnds = Date.now() + 60_000;
  const server = await listen(async (req, res) => {
    boundary(req, config.origin);
    if (req.method === "GET" && req.url === "/") { renderPage(res, true, config.chatOrigin); return; }
    if (req.method === "GET" && req.url === "/app.js") { renderScript(res); return; }
    for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
    if (req.method === "POST" && req.url === "/api/manager/login") {
      if (Date.now() > windowEnds) { attempts = 0; windowEnds = Date.now() + 60_000; }
      requireThat(++attempts <= 20 && sessions.size < 64, 403);
      const b = record(await jsonBody(req)); keys(b, ["credential"]);
      const client = new AdminClient({ socketPath: config.socketPath, credential: token(b.credential) });
      requireThat((await client.capabilities()).approval, 403);
      const id = randomBytes(32).toString("hex"); sessions.set(id, { client, expires: Date.now() + 900_000 });
      // Cookies ignore ports, so even HttpOnly cookies would leak authority to
      // a public/chat service on the same hostname. Never set an ambient cookie.
      reply(res, 200, { authenticated: true, sessionToken: id }); return;
    }
    const id = bearer(req); const session = sessions.get(id); requireThat(session, 401);
    const client = session.client;
    if (req.method === "POST") {
      const body = await jsonBody(req);
      if (req.url === "/api/manager/logout") { keys(record(body), []); sessions.delete(id); reply(res, 200, { authenticated: false }); }
      else if (req.url === "/api/manager/approve") {
        const b = record(body); keys(b, ["taskId", "revision", "requestHash", "policyHash"]);
        const approved = await client.approveTask(b as unknown as ApprovalBinding);
        reply(res, 200, await client.executeTask({ taskId: approved.id, revision: approved.revision }));
      } else if (req.url === "/api/manager/execute") {
        const b = record(body); keys(b, ["taskId", "revision"]);
        reply(res, 200, await client.executeTask(b as { taskId: string; revision: number }));
      } else if (req.url === "/api/manager/tasks") reply(res, 202, await client.submitTask(body as TaskSubmission));
      else throw new ManagerError(404);
      return;
    }
    requireThat(req.method === "GET", 404);
    if (req.url === "/api/manager/tasks") reply(res, 200, await client.listTasks());
    else if (req.url === "/api/manager/workspaces") reply(res, 200, await client.workspaces());
    else if (req.url === "/api/manager/capabilities") reply(res, 200, await client.capabilities());
    else if (/^\/api\/manager\/tasks\/[^/]+\/review$/.test(req.url!)) reply(res, 200, await client.reviewTask(taskId(req.url!.split("/")[4])));
    else if (req.url?.startsWith("/api/manager/tasks/")) reply(res, 200, await client.getTask(taskId(req.url.slice("/api/manager/tasks/".length))));
    else throw new ManagerError(404);
  }, config.port);
  return { port: server.port, close: async () => { sessions.clear(); await server.close(); } };
}

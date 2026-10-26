import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";
import { absolute, origin as validatedOrigin } from "../config.ts";
import { ExecutorClient } from "../executor/client.ts";
import { bearer, header, jsonBody, reply } from "../http.ts";
import { ManagerError, requireThat } from "../validation.ts";
import type { TaskSubmission } from "../api.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const submission = z.object({ key: id, action: z.enum(["create", "stop", "start"]), target: id, workspace: id.optional() }).strict().superRefine((v, ctx) => {
  if ((v.action === "create") !== (v.workspace !== undefined)) ctx.addIssue({ code: "custom", message: "Create requires workspace; stop/start forbid it" });
});
const getTask = z.object({ taskId: z.string().uuid() }).strict();
const noArguments = z.object({}).strict();

function tools(client: ExecutorClient): McpServer {
  const server = new McpServer({ name: "pi-manager", version: "0.1.0" }, { instructions: "Submit and query persistent Pi Manager tasks. Submission does not authorize execution. Administrator approval is independent and cannot be performed through MCP." });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  // Keep errors categorical: never return socket paths, policy, backend errors or credentials.
  const run = async (operation: () => Promise<unknown>) => {
    try { return result(await operation()); }
    catch (e) { return { ...result({ error: e instanceof ManagerError ? e.message : "Manager unavailable" }), isError: true }; }
  };
  server.registerTool("manager_submit_task", { description: "Submit an idempotent create/stop/start request; returns a persistent task ID pending independent administrator approval. Start restores only an already owned Docker container.", inputSchema: submission,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    args => run(() => client.submitTask(args as TaskSubmission)));
  server.registerTool("manager_get_task", { description: "Query one of this credential's own tasks by ID.", inputSchema: getTask,
    annotations: { readOnlyHint: true, openWorldHint: false } },
    args => run(() => client.getTask(args.taskId)));
  server.registerTool("manager_list_tasks", { description: "List persistent tasks visible to this credential; no administrator approval tools are exposed.", inputSchema: noArguments,
    annotations: { readOnlyHint: true, openWorldHint: false } },
    () => run(() => client.listTasks()));
  return server;
}

/**
 * Official stateless Streamable HTTP. This low-privilege handler owns no backend,
 * task files or admin capability. Every credential is rechecked by the executor.
 * Browser Origin, when present, must match; non-browser Pi clients omit Origin.
 */
export function createMcpHandler(options: { socketPath: string; origin: string }) {
  const socketPath = absolute(options.socketPath);
  const origin = validatedOrigin(options.origin);
  let active = 0;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let server: McpServer | undefined;
    let timer: NodeJS.Timeout | undefined;
    let counted = false;
    try {
      requireThat(req.url === "/mcp", 404);
      requireThat(header(req, "host") === new URL(origin).host, 403);
      const from = header(req, "origin");
      requireThat(from === undefined || from === origin, 403);
      const credential = bearer(req);
      header(req, "cookie"); header(req, "content-type");
      requireThat(req.method === "POST", 405);
      requireThat(active < 16, 503);
      active++; counted = true;
      timer = setTimeout(() => { if (!res.writableEnded) res.destroy(); }, 5000);
      const client = new ExecutorClient({ socketPath, credential });
      // Authenticate before initialize/tools-list as well as before task calls.
      // Admin credentials are rejected on the submit transport.
      await client.capabilities();
      const body = await jsonBody(req);
      server = tools(client);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const completed = new Promise<void>(resolve => {
        const done = () => { res.off("finish", done); res.off("close", done); resolve(); };
        res.once("finish", done); res.once("close", done);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      if (!res.writableEnded && !res.destroyed) await completed;
    } catch (e) {
      const status = e instanceof ManagerError ? e.status : 503;
      if (status === 401 && !res.headersSent) res.setHeader("WWW-Authenticate", 'Bearer realm="pi-manager"');
      reply(res, status, { error: e instanceof ManagerError ? e.message : "Manager unavailable" });
    } finally {
      clearTimeout(timer);
      if (counted) active--;
      await server?.close().catch(() => {});
    }
  };
}

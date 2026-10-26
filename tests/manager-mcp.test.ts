import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { request } from "node:http";
import { harness } from "./helpers/native-harness.ts";
import { digest } from "../manager/validation.ts";
import { listen } from "../manager/http.ts";
import { startExecutor } from "../manager/executor/main.ts";
import { startService } from "../manager/service.ts";
import { ExecutorClient } from "../manager/executor/client.ts";

const credential = "synthetic-mcp-submitter-000000000001";
const administrator = "synthetic-mcp-administrator-00000001";
const requireSdk = createRequire(new URL("../manager/mcp/server.ts", import.meta.url));

async function fixture(t: any) {
  const cleanups: (() => Promise<void>)[] = [];
  const native = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any);
  const config = { stateRoot: path.join(native.parent, "mcp-tasks"), submitSocket: path.join(native.parent, "submit", "rpc.sock"), adminSocket: path.join(native.parent, "admin", "rpc.sock"),
    principals: [{ id: "mcp-agent", role: "submitter" as const, tokenHash: digest(credential) }, { id: "operator", role: "admin" as const, tokenHash: digest(administrator) }],
    trustedLocalNative: true, native: native.config, workspaces: { project: { label: "Synthetic project", root: "work", path: "project" } } };
  for (const n of ["submit", "admin"]) await mkdir(path.join(native.parent, n), { mode: 0o700 });
  let executor = await startExecutor(config);
  let module: typeof import("../manager/mcp/server.ts") | undefined;
  try { module = await import("../manager/mcp/server.ts"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  t.after(async () => { await executor.close(); for (const cleanup of cleanups) await cleanup(); });
  assert.ok(module, "official MCP task transport must exist");
  let handler: ReturnType<typeof module.createMcpHandler>;
  const service = await listen((req, res) => handler(req, res), 0);
  const origin = `http://127.0.0.1:${service.port}`;
  handler = module.createMcpHandler({ socketPath: config.submitSocket, origin });
  t.after(() => service.close());
  const sdk = await import(pathToFileURL(requireSdk.resolve("@modelcontextprotocol/client")).href);
  const client = new sdk.Client({ name: "manager-acceptance", version: "1.0.0" });
  const transport = new sdk.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), { requestInit: { headers: { Host: new URL(origin).host, Authorization: `Bearer ${credential}` } } });
  t.after(() => client.close());
  return { ...native, config, client, transport, service, origin, restart: async () => { await executor.close(); executor = await startExecutor(config); } };
}

test("official MCP client submits the same persistent scoped task as HTTP; disconnect cannot erase it", async t => {
  const f = await fixture(t);
  await f.client.connect(f.transport);
  const tools = await f.client.listTools();
  assert.deepEqual(tools.tools.map((x: any) => x.name).sort(), ["manager_get_task", "manager_list_tasks", "manager_submit_task"]);
  const result = await f.client.callTool({ name: "manager_submit_task", arguments: { key: "mcp-request", action: "create", target: "mcp-pi", workspace: "project" } });
  assert.equal(result.isError, undefined);
  const task = JSON.parse(result.content[0].text);
  assert.equal(task.state, "pending_approval");
  assert.equal(task.requester, "mcp-agent");
  await f.client.close();
  const http = new ExecutorClient({ socketPath: f.config.submitSocket, credential });
  assert.equal((await http.getTask(task.id)).id, task.id);
  await f.restart();
  assert.equal((await http.getTask(task.id)).state, "pending_approval");
  assert.equal((await http.submitTask({ key: "mcp-request", action: "create", target: "mcp-pi", workspace: "project" })).id, task.id);
});

test("MCP tool surface denies self-approval and extra authority fields", async t => {
  const f = await fixture(t);
  await f.client.connect(f.transport);
  await assert.rejects(f.client.callTool({ name: "manager_approve_task", arguments: { taskId: "anything" } }));
  const forged = await f.client.callTool({ name: "manager_submit_task", arguments: { key: "forged", action: "create", target: "mcp-pi", workspace: "project", requester: "operator", command: "sh" } });
  assert.equal(forged.isError, true);
  const http = new ExecutorClient({ socketPath: f.config.submitSocket, credential });
  assert.deepEqual(await http.listTasks(), []);
});

test("MCP checks bearer, Host and supplied Origin before protocol handling", async t => {
  const f = await fixture(t);
  const origin = f.origin;
  const url = `http://127.0.0.1:${f.service.port}/mcp`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const [headers, expected] of [
    [{ Host: new URL(origin).host }, 401],
    [{ Host: "evil.invalid", Authorization: `Bearer ${credential}` }, 403],
    [{ Host: new URL(origin).host, Origin: "https://evil.invalid", Authorization: `Bearer ${credential}` }, 403],
    [{ Host: new URL(origin).host, Authorization: `Bearer ${administrator}` }, 403],
  ] as const) {
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.on("error", reject); req.end(body);
    });
    assert.equal(result.status, expected);
    assert.ok(!result.text.includes(credential)); assert.ok(!result.text.includes(administrator));
  }
});

test("the actual public service exposes MCP to a native client without browser Origin", async t => {
  const f = await fixture(t);
  const probe = await listen(async (_req, res) => { res.end(); }, 0);
  const port = probe.port; await probe.close();
  const origin = `http://127.0.0.1:${port}`;
  const service = await startService({ socketPath: f.config.submitSocket, port, origin, chatOrigin: "http://127.0.0.1:1" });
  t.after(() => service.close());
  const sdk = await import(pathToFileURL(requireSdk.resolve("@modelcontextprotocol/client")).href);
  const client = new sdk.Client({ name: "real-service", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new sdk.StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
  }));
  assert.equal((await client.listTools()).tools.length, 3);
});

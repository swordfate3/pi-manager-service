import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startExecutor } from "../manager/executor/main.ts";
import { startService } from "../manager/service.ts";
import { listen } from "../manager/http.ts";
import { digest } from "../manager/validation.ts";

test("actual isolated Pi CLI connects to the Manager MCP service", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "manager-pi-mcp-"));
  const credential = "synthetic-pi-mcp-requester-0000000000";
  const agent = path.join(directory, "agent");
  await mkdir(agent, { mode: 0o700 });
  let executor: Awaited<ReturnType<typeof startExecutor>> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => {
    await service?.close(); await executor?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const socketPath = path.join(directory, "submit", "rpc.sock");
  executor = await startExecutor({ stateRoot: path.join(directory, "tasks"), submitSocket: socketPath,
    adminSocket: path.join(directory, "admin", "rpc.sock"), principals: [
      { id: "pi-agent", role: "submitter", tokenHash: digest(credential) },
      { id: "operator", role: "admin", tokenHash: digest("synthetic-other-plane-operator-00000000") },
    ], trustedLocalNative: false, native: null, workspaces: {} });
  const probe = await listen(async (_req, res) => { res.end(); }, 0);
  const port = probe.port; await probe.close();
  const origin = `http://127.0.0.1:${port}`;
  service = await startService({ port, origin, socketPath, chatOrigin: "http://127.0.0.1:1" });
  await writeFile(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { manager: {
    url: `${origin}/mcp`, headers: { Authorization: "Bearer ${MANAGER_TEST_TOKEN}" },
  } } }), { mode: 0o600 });
  const { stdout, stderr } = await promisify(execFile)(path.resolve("node_modules/.bin/pi"), ["mcp", "list", "--json"], {
    cwd: directory, timeout: 15_000, maxBuffer: 128 * 1024,
    env: { PATH: process.env.PATH, HOME: directory, PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
      PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", MANAGER_TEST_TOKEN: credential },
  });
  assert.equal(stderr, "");
  assert.ok(!stdout.includes(credential));
  assert.match(stdout, /manager_submit_task/);
  assert.match(stdout, /manager_get_task/);
  assert.match(stdout, /manager_list_tasks/);
  assert.doesNotMatch(stdout, /manager_approve_task/);
});

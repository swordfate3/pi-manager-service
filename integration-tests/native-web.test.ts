import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startExecutor } from "../manager/executor/main.ts";
import { startService } from "../manager/service.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { digest } from "../manager/validation.ts";
import { initializeHub, readHubConfig, readGrant } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { listen } from "../manager/http.ts";
import { waitFor } from "../tests/helpers/native-harness.ts";

test("real Pi loads a packed thin Web, registers, chats through Hub and revokes on stop", {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT,
  timeout: 40_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "manager-native-web-"));
  let executor: Awaited<ReturnType<typeof startExecutor>> | undefined;
  let publicService: Awaited<ReturnType<typeof startService>> | undefined;
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let ws: WebSocket | undefined;
  t.after(async () => {
    ws?.terminate();
    await publicService?.close(); await executor?.close();
    await hub?.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = promisify(execFile);
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", root], {
    cwd: process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"), NPM_CONFIG_CACHE: path.join(root, "npm-cache") },
  });
  // npm also emits this package's integrity-check lifecycle notice before JSON.
  const jsonStart = stdout.indexOf("["); assert.ok(jsonStart >= 0);
  const [{ filename }] = JSON.parse(stdout.slice(jsonStart));
  await run("tar", ["-xzf", path.join(root, filename), "-C", root]);
  const installedWeb = path.join(root, "package");
  await access(path.join(installedWeb, "dist", "index.html"));
  // Only declared Web runtime/peer dependencies are supplied by the selected
  // installed Pi SDK; the extension itself comes exclusively from the archive.
  await mkdir(path.join(installedWeb, "node_modules", "@earendil-works"), { recursive: true });
  await symlink(path.resolve("node_modules/ws"), path.join(installedWeb, "node_modules", "ws"));
  for (const name of ["pi-coding-agent", "pi-ai"]) await symlink(path.resolve(`node_modules/@earendil-works/${name}`), path.join(installedWeb, "node_modules", "@earendil-works", name));
  const configFile = path.join(root, "hub.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  hub = await startHub(config, { versions: { source: async () => ({}) } });
  const probe = await listen(async (_req, res) => { res.end(); }, 0);
  const webPort = probe.port; await probe.close();
  const workspace = path.join(root, "projects", "one"); await mkdir(workspace, { recursive: true });
  const native = { piExecutable: path.resolve("node_modules/.bin/pi"), workspaceRoots: { projects: path.dirname(workspace) },
    stateRoot: path.join(root, "native-state"), agentRoot: path.join(root, "native-agent"),
    provider: { extensionPath: path.resolve("integration-tests/fixtures/native-provider.ts"), name: "native-fixture", model: "deterministic" },
    web: { extensionPath: path.join(installedWeb, "extensions", "mirror-server.ts"), hubConfigFile: configFile, port: webPort },
    startupTimeoutMs: 15_000, stopTimeoutMs: 3000 };
  const requester = "synthetic-native-web-agent-00000000001", administrator = "synthetic-native-web-admin-00000000001";
  const submitSocket = path.join(root, "submit", "rpc.sock"), adminSocket = path.join(root, "admin", "rpc.sock");
  executor = await startExecutor({ stateRoot: path.join(root, "tasks"), submitSocket, adminSocket,
    principals: [{ id: "agent", role: "submitter", tokenHash: digest(requester) }, { id: "operator", role: "admin", tokenHash: digest(administrator) }],
    trustedLocalNative: true, native, workspaces: { one: { label: "Test project", root: "projects", path: "one" } } });
  const reserve = await listen(async (_req, res) => { res.end(); }, 0);
  const managementPort = reserve.port; await reserve.close();
  const managementOrigin = `http://127.0.0.1:${managementPort}`;
  publicService = await startService({ socketPath: submitSocket, origin: managementOrigin, chatOrigin: new URL(hub.url).origin, port: managementPort });
  const submitted = await fetch(`${managementOrigin}/api/manager/tasks`, { method: "POST", headers: {
    Authorization: `Bearer ${requester}`, Origin: managementOrigin, "Content-Type": "application/json",
  }, body: JSON.stringify({ key: "first", action: "create", target: "web-native", workspace: "one" }) });
  assert.equal(submitted.status, 202);
  const created = await submitted.json() as any;
  assert.equal(created.state, "pending_approval");
  assert.deepEqual(await readdir(native.stateRoot).catch(() => []), []);
  const operator = new AdminClient({ socketPath: adminSocket, credential: administrator });
  const client = new ExecutorClient({ socketPath: submitSocket, credential: requester });
  async function approve(id: string) {
    const approved = await operator.approveTask((await operator.reviewTask(id)).binding);
    await operator.executeTask({ taskId: id, revision: approved.revision });
    await waitFor(async () => (await client.getTask(id)).state === "succeeded", 15_000);
  }
  await approve(created.id);
  let session: { path: string } | undefined;
  await waitFor(async () => {
    const list = await (await fetch(`${hub!.url}api/sessions`)).json() as any;
    session = list.sessions[0]; return !!session;
  }, 10_000);
  const url = new URL(session!.path, hub.url);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /<html/);
  ws = new WebSocket(new URL("ws", url).href.replace(/^http/, "ws"), { origin: new URL(hub.url).origin });
  const messages: any[] = [];
  ws.on("message", value => { messages.push(JSON.parse(value.toString())); });
  await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
  await waitFor(async () => messages.some(m => m.event === "state_sync" || m.event === "state_snapshot"));
  ws.send(JSON.stringify({ type: "req", id: "web-chat", method: "prompt", params: { message: "synthetic Web acceptance" } }));
  await waitFor(async () => JSON.stringify(messages).includes("NATIVE_PI_GENERATION_OK"), 10_000);
  const [stateDirectory] = await readdir(native.stateRoot);
  const credential = JSON.parse(await readFile(path.join(native.stateRoot, stateDirectory, "web-registration.json"), "utf8"));
  const stopped = await client.submitTask({ key: "stop", action: "stop", target: "web-native" });
  await approve(stopped.id);
  assert.equal(readGrant(config, credential.run_id).revoked, true);
  assert.equal((await fetch(url)).status, 410);
  assert.deepEqual(await client.resources(), []);
  assert.equal((await fetch(managementOrigin)).status, 200);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { packedWeb } from "./fixtures/packed-web.ts";

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
  const installedWeb = await packedWeb(root, process.env.PI_MANAGER_TEST_WEB_ROOT!);
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
  const executorConfiguration = { stateRoot: path.join(root, "tasks"), submitSocket, adminSocket,
    principals: [{ id: "agent", role: "submitter", tokenHash: digest(requester) }, { id: "operator", role: "admin", tokenHash: digest(administrator) }],
    trustedLocalNative: true, native, workspaces: { one: { label: "Test project", root: "projects", path: "one" } } };
  executor = await startExecutor(executorConfiguration);
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
  ws.terminate();
  await executor.close(); executor = await startExecutor(executorConfiguration);
  const resumed = await client.submitTask({ key: "resume", action: "start", target: "web-native" });
  await approve(resumed.id);
  await waitFor(async () => {
    const list = await (await fetch(`${hub!.url}api/sessions`)).json() as any;
    session = list.sessions[0]; return !!session;
  }, 10_000).catch(async error => {
    const events = (await readFile(path.join(native.stateRoot, stateDirectory, "home", "acceptance.jsonl"), "utf8"))
      .trim().split("\n").map(line => { const event = JSON.parse(line); return { event: event.event, version: event.version }; });
    throw Error(`Resumed Web registration did not appear; provider lifecycle=${JSON.stringify(events)}; files=${JSON.stringify(await readdir(path.join(native.stateRoot, stateDirectory)))}`, { cause: error });
  });
  const resumedUrl = new URL(session!.path, hub.url);
  ws = new WebSocket(new URL("ws", resumedUrl).href.replace(/^http/, "ws"), { origin: new URL(hub.url).origin });
  const restored: any[] = [];
  ws.on("message", value => restored.push(JSON.parse(value.toString())));
  await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
  await waitFor(async () => restored.some(m => m.event === "state_sync"));
  assert.ok(JSON.stringify(restored).includes("synthetic Web acceptance"), "native resume must load the previous user turn");
  assert.ok(JSON.stringify(restored).includes("NATIVE_PI_GENERATION_OK"), "native resume must load the previous assistant turn");
  const finalStop = await client.submitTask({ key: "stop-restored", action: "stop", target: "web-native" });
  await approve(finalStop.id);
  assert.equal((await fetch(resumedUrl)).status, 410);
  assert.deepEqual(await client.resources(), []);
});

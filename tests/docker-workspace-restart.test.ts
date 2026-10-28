import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DockerBackend } from "../manager/backends/docker.ts";
import { DockerEngine } from "../manager/backends/docker-engine.ts";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { startExecutor } from "../manager/executor/main.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";
import { digest } from "../manager/validation.ts";
import type { TaskSubmission } from "../manager/api.ts";
import { dockerDaemon } from "./helpers/docker-daemon.ts";

const requester = "workspace-restart-requester-credential";
const administrator = "workspace-restart-admin-credential";
async function fixture(t: TestContext) {
  const f = await dockerDaemon(t);
  const selected = path.join(f.work, "project", "nested"); await mkdir(selected);
  const outside = path.join(f.root, "outside"); await mkdir(outside);
  const protectedPath = path.join(f.root, "secrets"); await mkdir(protectedPath);
  const packageRoot = path.join(f.root, "web");
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true }); await mkdir(path.join(packageRoot, "dist"));
  await writeFile(path.join(packageRoot, "extensions/mirror-server.ts"), "export default () => {};");
  await writeFile(path.join(packageRoot, "dist/index.html"), "html");
  const hubConfigFile = path.join(f.root, "hub.json"); initializeHub(hubConfigFile, { port: 0 });
  const hub = readHubConfig(hubConfigFile); await mkdir(hub.runtimeDir, { mode: 0o700 });
  const config = { socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state,
    workspaceRoots: { projects: f.work }, protectedRoots: [protectedPath], pathCoordinates: "host" as const,
    web: { packageRoot, hubConfigFile, port: 18310 } };
  const request = { instanceId: "one", workspace: { root: "projects", path: "project/nested" } };
  const mutations = () => f.calls.filter(c => c.method === "POST");
  const grants = async () => Promise.all((await readdir(path.join(hub.stateDir, "grants"))).sort().map(async name => [name, await readFile(path.join(hub.stateDir, "grants", name), "utf8")]));
  return { ...f, selected, outside, protectedPath, config, request, mutations, grants };
}

for (const replacement of ["selected-outside", "selected-protected", "selected-inside", "ancestor", "root", "deleted"] as const) {
  test(`start rejects saved workspace ${replacement} drift without affecting stop, identity or grants`, async t => {
    const f = await fixture(t); let backend = await DockerBackend.open(f.config); f.cleanups.push(() => backend.close());
    const identity = await backend.create(f.request); await backend.stop("one");
    const grants = await f.grants();
    // Nested drift also has to fail after reopening the original private journal.
    if (replacement === "ancestor") { await backend.close(); backend = await DockerBackend.open(f.config); }
    const target = replacement === "root" ? f.work : replacement === "ancestor" ? path.dirname(f.selected) : f.selected;
    const saved = `${target}-retained`; await rename(target, saved);
    if (replacement !== "deleted") {
      const destination = replacement === "selected-protected" ? f.protectedPath : replacement === "selected-inside" ? saved : f.outside;
      await symlink(destination, target);
    }
    const count = f.mutations().length;
    await assert.rejects(backend.start("one"));
    assert.equal(f.mutations().length, count, "no start or replacement mutation after drift");
    assert.equal((await backend.inspect("one"))?.containerId, identity.containerId);
    assert.deepEqual(await backend.list(), [identity]);
    assert.deepEqual(await f.grants(), grants); assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
    // Stopping a currently running owned container must remain available even
    // if a workspace changes while it runs. Fake daemon supplies that state.
    f.containers.get(identity.containerId)!.State.Running = true;
    assert.equal((await backend.stop("one")).status, "stopped");
    if (replacement !== "deleted") await rm(target); await rename(saved, target);
    assert.equal((await backend.start("one")).containerId, identity.containerId);
    const restoredCount = f.mutations().length; await backend.start("one");
    assert.equal(f.mutations().length, restoredCount, "unchanged running start stays idempotent");
  });
}

async function terminal(client: ExecutorClient, id: string) {
  for (let i = 0; i < 200; i++) {
    const task = await client.getTask(id);
    if (["succeeded", "failed", "unknown"].includes(task.state)) return task;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail("task did not finish");
}
for (const timing of ["before-approval", "after-approval", "reopened"] as const) {
  test(`executor rejects original workspace drift ${timing} without a Docker start`, async t => {
    const f = await fixture(t);
    const config = { stateRoot: path.join(f.root, "tasks"), submitSocket: path.join(f.root, "submit/rpc.sock"), adminSocket: path.join(f.root, "admin/rpc.sock"),
      principals: [{ id: "requester", role: "submitter" as const, tokenHash: digest(requester) }, { id: "administrator", role: "admin" as const, tokenHash: digest(administrator) }],
      native: null, trustedLocalNative: false, docker: f.config,
      workspaces: { original: { label: "Original", root: "projects", path: "project//nested/." } }, workspaceBrowser: { home: f.root, defaultRoot: "projects" } };
    let executor = await startExecutor(config); f.cleanups.push(() => executor.close());
    const client = new ExecutorClient({ socketPath: config.submitSocket, credential: requester });
    const admin = new AdminClient({ socketPath: config.adminSocket, credential: administrator });
    const run = async (request: TaskSubmission) => {
      const task = await client.submitTask(request); const approved = await admin.approveTask((await admin.reviewTask(task.id)).binding);
      await admin.executeTask({ taskId: task.id, revision: approved.revision }); assert.equal((await terminal(client, task.id)).state, "succeeded");
    };
    await run({ key: "create", action: "create", target: "one", workspace: timing === "reopened" ? "original" : { root: "projects", path: "project/nested" } });
    await run({ key: "stop", action: "stop", target: "one" });
    const task = await client.submitTask({ key: "start", action: "start", target: "one" });
    let binding = (await admin.reviewTask(task.id)).binding;
    const queued = timing === "after-approval" ? await admin.approveTask(binding) : undefined;
    const grants = await f.grants(); const count = f.mutations().length;
    await rename(path.dirname(f.selected), path.join(f.work, "retained")); await symlink(f.protectedPath, path.dirname(f.selected));
    if (timing === "reopened") { await executor.close(); executor = await startExecutor(config); binding = (await admin.reviewTask(task.id)).binding; }
    if (queued) await assert.rejects(admin.executeTask({ taskId: task.id, revision: queued.revision }));
    else await assert.rejects(admin.approveTask(binding));
    assert.equal(f.mutations().length, count); assert.deepEqual(await f.grants(), grants);
    assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
    await run({ key: "stop-again", action: "stop", target: "one" });
  });
}

test("final backend start rechecks drift introduced during asynchronous runtime preflight", async t => {
  const f = await fixture(t); f.volumes.set("runtime", { Name: "runtime", Driver: "local", Options: null });
  const backend = await DockerBackend.open({ ...f.config, runtimeProfile: { runtimeVolume: "runtime" } }); f.cleanups.push(() => backend.close());
  const identity = await backend.create(f.request); await backend.stop("one"); const count = f.mutations().length;
  // Delegate every request to the real Unix fake daemon. Only inject a real
  // filesystem replacement when the asynchronous runtime preflight completes.
  const call = DockerEngine.prototype.call; let replaced = false;
  t.mock.method(DockerEngine.prototype, "call", async function(this: DockerEngine, ...args: Parameters<typeof call>) {
    const result = await call.apply(this, args);
    if (args[1] === "/volumes/runtime" && !replaced) {
      replaced = true; await rename(f.selected, `${f.selected}-retained`); await symlink(f.outside, f.selected);
    }
    return result;
  });
  await assert.rejects(backend.start("one")); assert.equal(replaced, true);
  assert.equal(f.mutations().length, count); assert.equal((await backend.inspect("one"))?.containerId, identity.containerId);
});

test("create rechecks saved workspace after container setup before its initial start and retains identity", async t => {
  const f = await fixture(t); const backend = await DockerBackend.open(f.config); f.cleanups.push(() => backend.close());
  const call = DockerEngine.prototype.call; let replaced = false;
  t.mock.method(DockerEngine.prototype, "call", async function(this: DockerEngine, ...args: Parameters<typeof call>) {
    const result = await call.apply(this, args);
    // This is the image inspection inside post-create ownership verification,
    // after grant/home/container setup and before the initial Docker start.
    if (args[1].startsWith("/images/") && f.containers.size === 1 && !replaced) {
      replaced = true; await rename(f.selected, `${f.selected}-retained`); await symlink(f.protectedPath, f.selected);
    }
    return result;
  });
  await assert.rejects(backend.create(f.request)); assert.equal(replaced, true);
  assert.equal(f.calls.some(c => c.method === "POST" && c.route.endsWith("/start")), false);
  const identity = (await backend.list())[0]; assert.ok(identity);
  assert.equal((await backend.inspect("one"))?.status, "stopped");
  const grants = await f.grants(); assert.equal(grants.length, 1);
  assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
  await rm(f.selected); await rename(`${f.selected}-retained`, f.selected);
  assert.equal((await backend.start("one")).containerId, identity.containerId);
  assert.deepEqual(await f.grants(), grants); assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
});

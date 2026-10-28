import assert from "node:assert/strict";
import { mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { executorConfig, type ExecutorConfig } from "../manager/config.ts";
import { digest } from "../manager/validation.ts";
import { dockerDaemon } from "./helpers/docker-daemon.ts";
import { startExecutor } from "../manager/executor/main.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";
import { TaskEngine } from "../manager/executor/engine.ts";
import { TaskStore } from "../manager/task-store.ts";
import { ExecutionOutcomeUnknownError } from "../manager/errors.ts";
import type { TaskBackendAdapter } from "../manager/executor/adapter.ts";
import type { TaskSubmission } from "../manager/api.ts";
import { DockerTaskAdapter } from "../manager/executor/docker-adapter.ts";

const alice = "docker-alice-credential-000000000001";
const bob = "docker-bob-credential-0000000000002";
const admin = "docker-admin-credential-000000000001";

async function fixture(t: TestContext) {
  const f = await dockerDaemon(t);
  const config = {
    stateRoot: path.join(f.root, "tasks"),
    submitSocket: path.join(f.root, "submit", "rpc.sock"),
    adminSocket: path.join(f.root, "admin", "rpc.sock"),
    principals: [
      { id: "alice", role: "submitter" as const, tokenHash: digest(alice) },
      { id: "bob", role: "submitter" as const, tokenHash: digest(bob) },
      { id: "operator", role: "admin" as const, tokenHash: digest(admin) },
    ],
    native: null, trustedLocalNative: false,
    docker: { socketPath: f.socketPath, daemonId: f.daemonId, image: f.image,
      stateRoot: f.state, workspaceRoots: { projects: f.work }, pathCoordinates: "host" as const, timeoutMs: 200 },
    workspaces: { project: { label: "Project", root: "projects", path: "project" } },
  };
  return { ...f, config };
}

test("executor config accepts explicit Docker and preserves legacy disabled profiles", async t => {
  const f = await fixture(t);
  assert.deepEqual(executorConfig(f.config), f.config);
  const { docker: _, ...legacy } = f.config;
  assert.deepEqual(executorConfig({ ...legacy, workspaces: {} }), { ...legacy, workspaces: {} });
  assert.throws(() => executorConfig({ ...f.config, native: {
    piExecutable: "/usr/bin/pi", workspaceRoots: { projects: f.work }, stateRoot: "/tmp/native-state", agentRoot: "/tmp/native-agent",
  }, trustedLocalNative: true }));
  assert.throws(() => executorConfig({ ...f.config, workspaces: { project: { label: "Project", root: "other", path: "project" } } }));
});

test("trusted native Web config accepts only explicit absolute files and a bounded integer port", async t => {
  const f = await fixture(t);
  const { docker: _, ...base } = f.config;
  const web = { extensionPath: "/opt/pi/web.ts", hubConfigFile: "/private/registrar.json", port: 18190 };
  const native = { piExecutable: "/usr/bin/pi", workspaceRoots: { projects: f.work }, stateRoot: "/tmp/native-state",
    agentRoot: "/tmp/native-agent", provider: { extensionPath: "/opt/pi/provider.ts", name: "test", model: "test" }, web };
  const config = { ...base, trustedLocalNative: true, native };
  assert.deepEqual(executorConfig(config).native, native);
  for (const invalid of [{ extensionPath: "relative" }, { hubConfigFile: "relative" }, { port: 0 }, { port: 65536 },
    { port: 1.5 }, { port: "18190" }, { command: ["sh"] }]) {
    assert.throws(() => executorConfig({ ...config, native: { ...native, web: { ...web, ...invalid } } }));
  }
  assert.throws(() => executorConfig({ ...config, native: { ...native, web: { extensionPath: web.extensionPath, port: web.port } } }));
  assert.throws(() => executorConfig({ ...config, trustedLocalNative: false }));
});

test("executor Docker configuration rejects loose identities, paths, limits and arbitrary options", async t => {
  const f = await fixture(t);
  for (const invalid of [
    { image: "pi:latest" }, { daemonId: "" }, { socketPath: "relative" }, { pathCoordinates: "container" },
    { stateRoot: "/" }, { workspaceRoots: {} }, { workspaceRoots: { projects: "/" } }, { protectedRoots: ["relative"] },
    { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: "200" }, { entrypoint: [] }, { command: ["bad\0arg"] },
    { privileged: true }, { mounts: [] }, { environment: { TOKEN: "secret" } },
  ]) assert.throws(() => executorConfig({ ...f.config, docker: { ...f.config.docker, ...invalid } }), JSON.stringify(invalid));
});

test("executor Docker roots cannot expose task authority, either IPC directory, journal, socket or source", async t => {
  const f = await fixture(t);
  for (const protectedPath of [f.config.stateRoot, path.dirname(f.config.submitSocket), path.dirname(f.config.adminSocket),
    f.state, f.socketPath, process.cwd()]) {
    for (const root of [protectedPath, path.join(protectedPath, "nested"), path.dirname(protectedPath)]) {
      assert.throws(() => executorConfig({ ...f.config, docker: { ...f.config.docker, workspaceRoots: { projects: root } } }), root);
    }
  }
  for (const stateRoot of [f.config.stateRoot, path.join(f.config.stateRoot, "journal"), f.root]) {
    assert.throws(() => executorConfig({ ...f.config, docker: { ...f.config.docker, stateRoot } }));
  }
  assert.throws(() => executorConfig({ ...f.config, docker: { ...f.config.docker, protectedRoots: [f.work] } }));
});

const create = { key: "create-one", action: "create" as const, target: "one", workspace: "project" };
async function managed(t: TestContext) {
  const f = await fixture(t);
  let executor = await startExecutor(f.config);
  f.cleanups.push(() => executor.close());
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: alice });
  const other = new ExecutorClient({ socketPath: f.config.submitSocket, credential: bob });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: admin });
  return { ...f, client, other, operator, restart: async () => { await executor.close(); executor = await startExecutor(f.config); } };
}
async function terminal(client: ExecutorClient, id: string) {
  for (let i = 0; i < 300; i++) {
    const task = await client.getTask(id);
    if (["succeeded", "unknown", "failed"].includes(task.state)) return task;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail("task did not reach a terminal state");
}
async function run(f: Awaited<ReturnType<typeof managed>>, request: TaskSubmission) {
  const task = await f.client.submitTask(request);
  const queued = await f.operator.approveTask((await f.operator.reviewTask(task.id)).binding);
  await f.operator.executeTask({ taskId: task.id, revision: queued.revision });
  return terminal(f.client, task.id);
}

test("real executor reports fixed Docker isolation and rejects frontend Docker authority", async t => {
  const f = await managed(t);
  assert.deepEqual(await f.client.capabilities(), { native: false, docker: true, isolation: "fixed-container", enrollment: false, updates: false, approval: false });
  assert.deepEqual(await f.client.workspaces(), [{ id: "project", label: "Project" }]);
  assert.deepEqual(await f.client.resources(), []);
  for (const extra of [{ image: f.image }, { path: f.work }, { mounts: [] }, { argv: ["sh"] }, { docker: {} }, { requester: "bob" }]) {
    await assert.rejects(f.client.submitTask({ ...create, ...extra } as any), { status: 400 });
  }
  await assert.rejects(f.client.submitTask({ key: "start", action: "start", target: "one", workspace: "project" } as any), { status: 400 });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("Docker adapter accepts an approved dynamic workspace only under explicit browser policy", async t => {
  const f = await fixture(t);
  Object.assign(f.config, { workspaceBrowser: { home: f.root, defaultRoot: "projects" } });
  const executor = await startExecutor(f.config); f.cleanups.push(() => executor.close());
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: alice });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: admin });
  const task = await client.submitTask({ key: "dynamic-docker", action: "create", target: "dynamic-docker", workspace: { root: "projects", path: "project" } });
  assert.deepEqual(task.payload, { workspace: { root: "projects", path: "project" } });
  const approved = await operator.approveTask((await operator.reviewTask(task.id)).binding);
  await operator.executeTask({ taskId: task.id, revision: approved.revision });
  assert.equal((await terminal(client, task.id)).state, "succeeded");
});

test("real executor owns create-stop-start across restart without cross-requester control or target reuse", async t => {
  const f = await managed(t);
  const created = await run(f, create);
  assert.equal(created.state, "succeeded");
  assert.deepEqual(created.result, { status: "created", instanceId: "one" });
  const [identity] = f.containers.keys();
  assert.ok(identity);
  await f.restart();
  assert.deepEqual(await f.client.resources(), [{ instanceId: "one" }]);
  assert.deepEqual(await f.other.resources(), []);
  for (const action of ["stop", "start"] as const) {
    await assert.rejects(f.other.submitTask({ key: `other-${action}`, action, target: "one" }), { status: 403 });
    await assert.rejects(f.client.submitTask({ key: `foreign-${action}`, action, target: "foreign" }), { status: 403 });
  }
  for (const client of [f.client, f.other]) {
    await assert.rejects(client.submitTask({ ...create, key: "takeover" }), { status: 409 });
  }
  assert.equal((await run(f, { key: "stop", action: "stop", target: "one" })).state, "succeeded");
  assert.equal(f.containers.get(identity).State.Running, false);
  await f.restart();
  assert.deepEqual(await f.client.resources(), [{ instanceId: "one" }]);
  assert.equal((await run(f, { key: "restore", action: "start", target: "one" })).state, "succeeded");
  assert.equal(f.containers.get(identity).State.Running, true);
  assert.equal(f.containers.size, 1);
  const publicData = JSON.stringify([await f.client.resources(), await f.client.listTasks(), await f.client.capabilities()]);
  for (const secret of [f.root, f.socketPath, f.image, identity, "homeVolume", "containerId"]) assert.ok(!publicData.includes(secret), secret);
});

test("lost create reply stays authoritative unknown; idempotency and restart never mutate twice or adopt labels", async t => {
  const f = await managed(t);
  f.behavior.loseCreateReply = true;
  const unknown = await run(f, create);
  assert.equal(unknown.state, "unknown");
  assert.deepEqual(unknown.result, { status: "execution-outcome-unknown" });
  f.behavior.loseCreateReply = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const repeated = await f.client.submitTask(create);
    assert.equal(repeated.id, unknown.id); assert.equal(repeated.state, "unknown");
    await assert.rejects(f.operator.executeTask({ taskId: unknown.id, revision: unknown.revision }), { status: 409 });
    await assert.rejects(f.operator.approveTask((await f.operator.reviewTask(unknown.id)).binding), { status: 409 });
    for (const client of [f.client, f.other]) await assert.rejects(client.submitTask({ ...create, key: "reuse" }), { status: 409 });
    await assert.rejects(f.client.submitTask({ key: "restore", action: "start", target: "one" }));
    assert.deepEqual(await f.client.resources(), []);
    await f.restart();
  }
  assert.equal(f.calls.filter(c => c.route.startsWith("/containers/create?")).length, 1);
  assert.equal(f.containers.size, 1);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 2); // volume + ambiguous create only
});

test("known Docker operation rejection becomes generic failed and cannot grant another requester ownership", async t => {
  const f = await managed(t);
  f.behavior.failStart = true;
  const failed = await run(f, create);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.result, { status: "execution-failed" });
  f.behavior.failStart = false;
  await f.restart();
  await assert.rejects(f.other.submitTask({ ...create, key: "steal" }), { status: 409 });
  await assert.rejects(f.other.submitTask({ key: "steal-start", action: "start", target: "one" }), { status: 403 });
  assert.deepEqual(await f.other.resources(), []);
  assert.deepEqual(await f.client.resources(), [{ instanceId: "one" }]);
  const container = [...f.containers.keys()][0];
  assert.equal((await run(f, { key: "recover-start", action: "start", target: "one" })).state, "succeeded");
  assert.equal((await run(f, { key: "recover-stop", action: "stop", target: "one" })).state, "succeeded");
  assert.equal([...f.containers.keys()][0], container);
  assert.equal(f.calls.filter(c => c.route.startsWith("/containers/create?")).length, 1);
});

test("approval binding and CAS remain independent for Docker and expire on executor reopen", async t => {
  const f = await managed(t);
  const task = await f.client.submitTask(create);
  const bypass = new AdminClient({ socketPath: f.config.submitSocket, credential: alice });
  const review = await f.operator.reviewTask(task.id);
  await assert.rejects(bypass.approveTask(review.binding), { status: 403 });
  await assert.rejects(f.operator.executeTask({ taskId: task.id, revision: 1 }), { status: 403 });
  for (const changed of [{ requestHash: "0".repeat(64) }, { policyHash: "0".repeat(64) }, { revision: 99 }]) {
    await assert.rejects(f.operator.approveTask({ ...review.binding, ...changed }), { status: 409 });
  }
  const approvals = await Promise.allSettled([f.operator.approveTask(review.binding), f.operator.approveTask(review.binding)]);
  assert.equal(approvals.filter(r => r.status === "fulfilled").length, 1);
  await f.restart();
  const queued = await f.client.getTask(task.id);
  await assert.rejects(f.operator.executeTask({ taskId: queued.id, revision: queued.revision }), { status: 403 });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  await f.operator.approveTask((await f.operator.reviewTask(task.id)).binding);
  const executions = await Promise.allSettled([f.operator.executeTask({ taskId: queued.id, revision: queued.revision }), f.operator.executeTask({ taskId: queued.id, revision: queued.revision })]);
  assert.equal(executions.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await terminal(f.client, task.id)).state, "succeeded");
  assert.equal(f.calls.filter(c => c.route.startsWith("/containers/create?")).length, 1);
});

test("two approved creates sharing a target cannot mutate twice or transfer ownership", async t => {
  const f = await managed(t);
  const a = await f.client.submitTask(create);
  const b = await f.other.submitTask({ ...create, key: "racing" });
  const aq = await f.operator.approveTask((await f.operator.reviewTask(a.id)).binding);
  const bq = await f.operator.approveTask((await f.operator.reviewTask(b.id)).binding);
  await Promise.allSettled([f.operator.executeTask({ taskId: a.id, revision: aq.revision }), f.operator.executeTask({ taskId: b.id, revision: bq.revision })]);
  assert.equal((await terminal(f.client, a.id)).state, "succeeded");
  assert.notEqual((await f.other.getTask(b.id)).state, "succeeded");
  assert.equal(f.calls.filter(c => c.route.startsWith("/containers/create?")).length, 1);
  assert.deepEqual(await f.other.resources(), []);
});

test("ExecutionOutcomeUnknownError persists unknown across TaskStore and engine reopen without fresh approval or replay", async t => {
  const f = await fixture(t);
  let executions = 0;
  const adapter: TaskBackendAdapter = { policy: {}, actions: ["create"], validate: async () => {},
    execute: async () => { executions++; throw new ExecutionOutcomeUnknownError(); }, resources: () => [], close: async () => {} };
  const engine = await TaskEngine.open(f.config, adapter); f.cleanups.push(() => engine.close());
  const capabilities = await engine.dispatch("submit", alice, { op: "capabilities" });
  const task: any = await engine.dispatch("submit", alice, { op: "submit", request: create });
  const review: any = await engine.dispatch("admin", admin, { op: "review", taskId: task.id });
  const queued: any = await engine.dispatch("admin", admin, { op: "approve", ...review.binding });
  await engine.dispatch("admin", admin, { op: "execute", taskId: task.id, revision: queued.revision });
  await engine.close();
  const store = await TaskStore.open(f.config.stateRoot); f.cleanups.push(() => store.close());
  assert.equal((await store.get(task.id))?.state, "unknown");
  assert.deepEqual((await store.get(task.id))?.result, { status: "execution-outcome-unknown" });
  assert.deepEqual(capabilities, { native: false, docker: false, isolation: "unavailable", enrollment: false, updates: false, approval: false });
  const persisted = await store.get(task.id);
  await store.close();
  for (let restart = 0; restart < 2; restart++) {
    const reopened = await TaskEngine.open(f.config, adapter); f.cleanups.push(() => reopened.close());
    assert.deepEqual(await reopened.dispatch("submit", alice, { op: "get", taskId: task.id }), persisted);
    assert.deepEqual(await reopened.dispatch("submit", alice, { op: "submit", request: create }), persisted);
    const freshReview: any = await reopened.dispatch("admin", admin, { op: "review", taskId: task.id });
    await assert.rejects(reopened.dispatch("admin", admin, { op: "approve", ...freshReview.binding }), { status: 409 });
    await assert.rejects(reopened.dispatch("admin", admin, { op: "execute", taskId: task.id, revision: freshReview.task.revision }), { status: 409 });
    assert.equal(executions, 1);
    await reopened.close();
  }
});

test("Docker journal rejects symlinked ancestors that hide overlap with workspace authority", async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  await symlink(f.work, alias);
  f.config.docker.stateRoot = path.join(alias, "journal");
  // Lexically separate paths are insufficient: the journal would actually be writable from /workspace.
  const opened = await DockerTaskAdapter.open(f.config).then(adapter => { f.cleanups.push(() => adapter.close()); return true; }, () => false);
  assert.equal(opened, false);
  assert.equal(f.calls.length, 0);
});

test("Docker socket aliases cannot hide a daemon socket inside an allowed workspace", async t => {
  const f = await fixture(t);
  const hidden = path.join(f.work, "project", "daemon.sock");
  await rename(f.socketPath, hidden);
  await symlink(hidden, f.socketPath);
  const opened = await DockerTaskAdapter.open(f.config).then(adapter => { f.cleanups.push(() => adapter.close()); return true; }, () => false);
  assert.equal(opened, false);
  assert.equal(f.calls.length, 0);
});

test("workspace symlink escape is rejected before approval or Docker mutation", async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateRoot, { mode: 0o700 });
  await symlink(f.config.stateRoot, path.join(f.work, "escape"));
  f.config.workspaces.project.path = "escape";
  const executor = await startExecutor(f.config); f.cleanups.push(() => executor.close());
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: alice });
  await assert.rejects(client.submitTask(create), { status: 400 });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("Docker task policy drift and changed restart policy reject stale review hashes", async t => {
  const f = await fixture(t);
  let adapter = await DockerTaskAdapter.open(f.config);
  let engine = await TaskEngine.open(f.config, adapter); f.cleanups.push(() => engine.close());
  const task: any = await engine.dispatch("submit", alice, { op: "submit", request: create });
  const oldReview: any = await engine.dispatch("admin", admin, { op: "review", taskId: task.id });
  (adapter.policy as any).unexpected = "changed";
  await assert.rejects(engine.dispatch("admin", admin, { op: "approve", ...oldReview.binding }), { status: 409 });
  await engine.close();
  f.config.workspaces.project.label = "Updated administrator choice";
  adapter = await DockerTaskAdapter.open(f.config); engine = await TaskEngine.open(f.config, adapter);
  const fresh: any = await engine.dispatch("admin", admin, { op: "review", taskId: task.id });
  assert.notEqual(fresh.binding.policyHash, oldReview.binding.policyHash);
  await assert.rejects(engine.dispatch("admin", admin, { op: "approve", ...oldReview.binding }), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("stranded running create restores an unknown reservation before executor serves requests", async t => {
  const f = await fixture(t);
  const store = await TaskStore.open(f.config.stateRoot);
  const task = await store.submit({ key: create.key, action: "create", requester: "alice", target: "one", payload: { workspace: "project" } });
  await store.transition(task.id, "pending_approval", "queued", { expectedRevision: 1 });
  await store.transition(task.id, "queued", "running", { expectedRevision: 2 });
  await store.close();
  const executor = await startExecutor(f.config); f.cleanups.push(() => executor.close());
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: alice });
  const other = new ExecutorClient({ socketPath: f.config.submitSocket, credential: bob });
  const result = await client.submitTask(create);
  assert.equal(result.id, task.id); assert.equal(result.state, "unknown");
  await assert.rejects(other.submitTask({ ...create, key: "steal" }), { status: 409 });
  await assert.rejects(client.submitTask({ key: "restore", action: "start", target: "one" }), { status: 409 });
  assert.deepEqual(await client.resources(), []);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});

test("foreign labels or missing exact container identity cannot authorize stop/start", async t => {
  const f = await managed(t);
  await run(f, create);
  const [identity] = f.containers.keys();
  const container = f.containers.get(identity);
  const calls = f.calls.filter(c => c.method === "POST").length;
  container.Config.Labels["cn.swordfate.pi-manager.owner"] = "foreign";
  await assert.rejects(f.client.submitTask({ key: "tampered", action: "stop", target: "one" }));
  // Even a clone with apparently correct labels under another ID cannot replace the journal identity.
  f.containers.delete(identity); f.containers.set("b".repeat(64), { ...container, Id: "b".repeat(64) });
  await assert.rejects(f.client.submitTask({ key: "missing", action: "start", target: "one" }), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === "POST").length, calls);
});

test("Docker journal policy drift fails closed and startup failure releases its writer lock", async t => {
  const f = await managed(t);
  await run(f, create);
  f.config.docker.image = `sha256:${"2".repeat(64)}`;
  await assert.rejects(f.restart(), /policy changed/);
  f.config.docker.image = f.image;
  await f.restart();
  assert.deepEqual(await f.client.resources(), [{ instanceId: "one" }]);
});

test("executor failure to acquire the authoritative store closes the newly opened Docker journal", async t => {
  const f = await fixture(t);
  const store = await TaskStore.open(f.config.stateRoot);
  try { await assert.rejects(startExecutor(f.config), /lock|writer/i); }
  finally { await store.close(); }
  const executor = await startExecutor(f.config); f.cleanups.push(() => executor.close());
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: alice });
  assert.equal((await client.capabilities()).docker, true);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NativeBackend } from "../manager/backends/native.ts";
import { ExecutionOutcomeUnknownError } from "../manager/errors.ts";
import { NativeTaskAdapter } from "../manager/executor/native-adapter.ts";
import { TaskEngine } from "../manager/executor/engine.ts";
import { TaskStore } from "../manager/task-store.ts";
import type { ExecutorConfig } from "../manager/config.ts";
import type { TaskView, TaskReview } from "../manager/api.ts";
import { assertDead, harness, waitFor } from "./helpers/native-harness.ts";

/** Real child/state proof and authoritative task journal; only the failing backend operation is injected. */
async function recoveryEngine(t: TestContext) {
  const cleanup: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanup.push(fn) } as unknown as TestContext);
  let engine: TaskEngine | undefined;
  t.after(async () => { await engine?.close(); for (const action of cleanup) await action(); });
  const identity = await f.backend.create(f.request);
  await f.backend.stop(f.request.instanceId); assertDead(identity.pid);
  const tokens = { submit: "synthetic-recovery-requester-000000000", admin: "synthetic-recovery-administrator-000000" };
  const config: ExecutorConfig = { stateRoot: path.join(f.parent, "tasks"), submitSocket: path.join(f.parent, "submit/rpc.sock"),
    adminSocket: path.join(f.parent, "admin/rpc.sock"), trustedLocalNative: true,
    native: { ...f.config, web: { extensionPath: path.join(f.parent, "web.ts"), hubConfigFile: path.join(f.parent, "chat.json"), port: 18881 } },
    principals: [ { id: "alice", role: "submitter", tokenHash: createHash("sha256").update(tokens.submit).digest("hex") },
      { id: "operator", role: "admin", tokenHash: createHash("sha256").update(tokens.admin).digest("hex") } ],
    workspaces: { project: { label: "Project", root: "work", path: "project" } } };
  const store = await TaskStore.open(config.stateRoot);
  try {
    let created = await store.submit({ key: "original-create", action: "create", target: f.request.instanceId, requester: "alice", payload: { workspace: "project" } });
    created = await store.transition(created.id, "pending_approval", "queued", { expectedRevision: created.revision });
    created = await store.transition(created.id, "queued", "running", { expectedRevision: created.revision });
    await store.transition(created.id, "running", "succeeded", { expectedRevision: created.revision,
      result: JSON.parse(JSON.stringify({ status: "created", instanceId: f.request.instanceId, saved: { workspace: "project", identity } })) });
  } finally { await store.close(); }
  const reopen = async () => {
    await engine?.close();
    engine = await TaskEngine.open(config, new NativeTaskAdapter(config));
  };
  await reopen();
  const call = (plane: "submit" | "admin", message: unknown) => engine!.dispatch(plane, tokens[plane], message);
  const submit = (action: string, key: string) => call("submit", { op: "submit", request: { key, action, target: f.request.instanceId } }) as Promise<TaskView>;
  const execute = async (action: string, key: string) => {
    const pending = await submit(action, key);
    const review = await call("admin", { op: "review", taskId: pending.id }) as TaskReview;
    const approved = await call("admin", { op: "approve", ...review.binding }) as TaskView;
    await call("admin", { op: "execute", taskId: approved.id, revision: approved.revision });
    let terminal: TaskView;
    await waitFor(async () => {
      terminal = await call("submit", { op: "get", taskId: pending.id }) as TaskView;
      return ["failed", "unknown", "succeeded"].includes(terminal.state);
    });
    return terminal!;
  };
  return { ...f, identity, config, call, submit, execute, reopen };
}

test("a failed native recovery touching saved data remains blocked after executor reopen", async t => {
  const f = await recoveryEngine(t);
  const partial = path.join(f.identity.stateDir, "sessions", "failed-generation");
  const fault = t.mock.method(NativeBackend.prototype, "resume", async () => {
    await writeFile(partial, "partially touched retained state");
    throw new Error("injected resume failure");
  });
  const failed = await f.execute("start", "failed-recovery");
  assert.equal(failed.state, "failed"); assert.equal(failed.result?.status, "execution-failed");
  assert.ok(!JSON.stringify(failed).includes(f.identity.stateDir), "saved identity stays private");
  assert.equal(await readFile(partial, "utf8"), "partially touched retained state");
  fault.mock.restore();
  await assert.rejects(f.submit("start", "blocked-current"), { status: 409 });
  await f.reopen();
  await assert.rejects(f.submit("start", "blocked-reopened"), { status: 409 });
  assert.equal((await f.execute("stop", "later-approved-stop")).state, "succeeded");
  await assert.rejects(f.submit("start", "still-blocked-after-stop"), { status: 409 });
  await f.reopen();
  await assert.rejects(f.submit("start", "still-blocked-after-second-reopen"), { status: 409 });
});

for (const failure of ["typed-unknown", "ownership-lost"] as const) {
  test(`native stop ${failure} blocks recovery before and after executor reopen`, async t => {
    const f = await recoveryEngine(t);
    // The old child is already gone: model failure at the remaining revocation/ownership boundary.
    const fault = t.mock.method(NativeBackend.prototype, "stop", async () => {
      if (failure === "typed-unknown") throw new ExecutionOutcomeUnknownError();
      return { status: "ownership-lost" as const };
    });
    const stopped = await f.execute("stop", "uncertain-stop");
    assert.equal(stopped.state, "unknown"); assert.equal(stopped.result?.status, "execution-outcome-unknown");
    fault.mock.restore();
    await assert.rejects(f.submit("start", "blocked-current"), { status: 409 });
    await f.reopen();
    await assert.rejects(f.submit("start", "blocked-reopened"), { status: 409 });
    assert.equal((await f.execute("stop", "later-approved-stop")).state, "succeeded");
    await assert.rejects(f.submit("start", "still-blocked"), { status: 409 });
  });
}

test("ordinary native stop failures remain failures without inventing an unknown-outcome block", async t => {
  const f = await recoveryEngine(t);
  const fault = t.mock.method(NativeBackend.prototype, "stop", async () => { throw new Error("known pre-mutation failure"); });
  const stopped = await f.execute("stop", "known-failure");
  fault.mock.restore();
  assert.equal(stopped.state, "failed"); assert.equal(stopped.result?.status, "execution-failed");
  assert.equal((await f.submit("start", "allowed-current")).state, "pending_approval");
  await f.reopen();
  assert.equal((await f.submit("start", "allowed-reopened")).state, "pending_approval");
});

test("explicit native resume launches a fresh owned child with the exact retained private state", async t => {
  const f = await harness(t);
  assert.equal(typeof (f.backend as any).resume, "function", "native resume is not implemented");
  const first = await f.backend.create(f.request);
  await assert.rejects((f.backend as any).resume(f.request, first), /owned|starting|active/i);
  const cannotAdopt = new NativeBackend(f.config);
  await assert.rejects(cannotAdopt.resume(f.request, first), /active/i);
  assert.deepEqual(cannotAdopt.list(), []);
  await writeFile(path.join(first.stateDir, "sessions", "retained-marker"), "retained conversation");
  await f.backend.stop(f.request.instanceId); assertDead(first.pid);
  const fresh = new NativeBackend(f.config);
  t.after(async () => { await fresh.stop(f.request.instanceId); });
  const resumed = await (fresh as any).resume(f.request, first);
  assert.notEqual(resumed.pid, first.pid);
  assert.equal(resumed.stateDir, first.stateDir); assert.equal(resumed.agentDir, first.agentDir);
  assert.equal(await readFile(path.join(resumed.stateDir, "sessions", "retained-marker"), "utf8"), "retained conversation");
  assert.equal((await fresh.inspect(f.request.instanceId))?.status, "ready");
});

test("native recovery is data-only authority and uncertain generations remain blocked", async t => {
  const f = await harness(t);
  const { NativeTaskAdapter } = await import("../manager/executor/native-adapter.ts");
  const identity = await f.backend.create(f.request);
  await f.backend.stop(f.request.instanceId);
  const cfg = { stateRoot: path.join(f.parent,"tasks"), submitSocket:path.join(f.parent,"submit","rpc.sock"), adminSocket:path.join(f.parent,"admin","rpc.sock"), principals:[], trustedLocalNative:true,
    native:{...f.config,web:{extensionPath:path.join(f.parent,"web.ts"),hubConfigFile:path.join(f.parent,"chat.json"),port:18881}},
    workspaces:{project:{label:"Project",root:"work",path:"project"}} };
  const saved = { workspace:"project", identity };
  const base = {id:"11111111-1111-4111-8111-111111111111",key:"create",action:"create",target:f.request.instanceId,requester:"alice",payload:{workspace:"project"},state:"succeeded",revision:4,
    createdAt:"2026-10-26T00:00:00.000Z",updatedAt:"2026-10-26T00:00:00.000Z",result:{status:"created",instanceId:f.request.instanceId,saved}} as any;
  const adapter = new NativeTaskAdapter(cfg);
  t.after(()=>adapter.close()); adapter.restore([base]);
  const start = { ...base, action:"start",payload:{} };
  await adapter.validate(start);
  await assert.rejects(adapter.validate({...start,requester:"bob"}),{status:403});
  assert.deepEqual(adapter.resources("alice"),[],"recovery never adopts an audit PID");
  const uncertain = new NativeTaskAdapter(cfg);
  t.after(()=>uncertain.close());
  uncertain.restore([base,{...start,id:"22222222-2222-4222-8222-222222222222",state:"unknown",result:undefined}]);
  await assert.rejects(uncertain.validate(start),{status:409});
});

test("native resume refuses forged audit identities and cannot select a different workspace", async t => {
  const f = await harness(t);
  assert.equal(typeof (f.backend as any).resume, "function", "native resume is not implemented");
  const first = await f.backend.create(f.request);
  await f.backend.stop(f.request.instanceId);
  const fresh = new NativeBackend(f.config);
  for (const change of [{ pid: process.pid }, { stateDir: f.workspace }, { agentDir: first.stateDir }, { workspace: f.parent }, { auditFile: "../identity.json" }]) {
    await assert.rejects((fresh as any).resume(f.request, { ...first, ...change }));
    assert.deepEqual(fresh.list(), []);
  }
  await writeFile(path.join(first.stateDir, "identity.json"), "{}");
  await assert.rejects((fresh as any).resume(f.request, first));
  assert.deepEqual(fresh.list(), []);
});

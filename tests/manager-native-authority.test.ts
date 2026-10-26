import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskRecord } from "../manager/contracts.ts";
import { NativeTaskAdapter } from "../manager/executor/native-adapter.ts";
import { assertDead, harness, observation, waitFor } from "./helpers/native-harness.ts";

function task(action: string, requester = "alice"): TaskRecord {
  return { id: "11111111-1111-4111-8111-111111111111", key: action, action, target: "owned-name", requester,
    payload: action === "create" ? { workspace: "project" } : {}, state: "running", revision: 3, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" } as TaskRecord;
}
async function adapter(t: any, scenario = "normal") {
  const cleanups: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any, scenario);
  const a = new NativeTaskAdapter({ stateRoot: path.join(f.parent, "tasks"), submitSocket: path.join(f.parent, "submit.sock"), adminSocket: path.join(f.parent, "admin.sock"),
    trustedLocalNative: true, native: f.config, principals: [], workspaces: { project: { label: "Project", root: "work", path: "project" } } });
  t.after(async () => { await a.close(); for (const cleanup of cleanups) await cleanup(); });
  return { ...f, adapter: a };
}

test("a native target is reserved before await and cannot be reused by another principal", async t => {
  const f = await adapter(t);
  const create = f.adapter.execute(task("create"));
  try { await assert.rejects(f.adapter.validate(task("create", "bob")), { status: 409 }); }
  finally { await create; }
  await f.adapter.execute(task("stop"));
  await assert.rejects(f.adapter.validate(task("create", "bob")), { status: 409 });
  assert.deepEqual(f.adapter.resources("alice"), []);
});

function delayWorkspace(t: TestContext, root: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const realpath = fs.realpath;
  const mock = t.mock.method(fs, "realpath", async (...args: Parameters<typeof realpath>) => {
    if (args[0] === root) { enter(); await released; }
    return realpath(...args);
  });
  syncBuiltinESMExports();
  return { entered, release: () => {
    release(); mock.mock.restore(); syncBuiltinESMExports();
  } };
}

test("a successful stop during workspace resolution prevents any later native launch", async t => {
  const f = await adapter(t);
  const gate = delayWorkspace(t, f.config.workspaceRoots.work);
  const create = f.adapter.execute(task("create"));
  const settled = Promise.allSettled([create]);
  try {
    await gate.entered;
    const stops = await Promise.all([f.adapter.execute(task("stop")), f.adapter.execute(task("stop"))]);
    for (const stop of stops) assert.equal(stop.status, "not-owned");
  } finally {
    gate.release();
    await settled;
  }
  assert.deepEqual(f.adapter.resources("alice"), [], "acknowledged stop must not be followed by a live child");
  await assert.rejects(fs.access(path.join(f.workspace, "observed.json")), { code: "ENOENT" });
  assert.equal((await settled)[0].status, "rejected");
  await assert.rejects(f.adapter.execute(task("create")), { status: 409 });
  await assert.rejects(f.adapter.validate(task("create", "bob")), { status: 409 });
});

test("another principal cannot cancel a native create pending workspace resolution", async t => {
  const f = await adapter(t);
  const gate = delayWorkspace(t, f.config.workspaceRoots.work);
  const create = f.adapter.execute(task("create"));
  const settled = Promise.allSettled([create]);
  try {
    await gate.entered;
    await assert.rejects(f.adapter.execute(task("stop", "bob")), { status: 403 });
  } finally {
    gate.release();
    await settled;
  }
  assert.deepEqual(await create, { status: "created", instanceId: "owned-name" });
  const { pid } = await observation(f.workspace);
  assert.deepEqual(f.adapter.resources("alice"), [{ instanceId: "owned-name" }]);
  assert.deepEqual(f.adapter.resources("bob"), []);
  assert.equal((await f.adapter.execute(task("stop"))).status, "stopped");
  assertDead(pid);
});

test("stop after native launch cancels startup and reaps the owned child", async t => {
  const f = await adapter(t, "hung");
  const create = f.adapter.execute(task("create"));
  const rejected = assert.rejects(create);
  await waitFor(() => fs.access(path.join(f.workspace, "observed.json")).then(() => true, () => false));
  const { pid } = await observation(f.workspace);
  assert.equal((await f.adapter.execute(task("stop"))).status, "stopped");
  await rejected;
  assertDead(pid);
  assert.deepEqual(f.adapter.resources("alice"), []);
});

test("restored native tombstones deny reuse and never adopt a previous adapter's child", async t => {
  const f = await adapter(t);
  await f.adapter.execute(task("create"));
  const { pid } = await observation(f.workspace);
  const fresh = new NativeTaskAdapter({ stateRoot: path.join(f.parent, "tasks"), submitSocket: path.join(f.parent, "submit.sock"), adminSocket: path.join(f.parent, "admin.sock"),
    trustedLocalNative: true, native: f.config, principals: [], workspaces: { project: { label: "Project", root: "work", path: "project" } } });
  for (const state of ["running", "succeeded", "failed", "unknown"] as const) {
    const prior = { ...task("create"), target: `restored-${state}`, state };
    fresh.restore([prior]);
    await assert.rejects(fresh.execute(prior), { status: 409 });
    await assert.rejects(fresh.validate({ ...prior, requester: "bob" }), { status: 409 });
  }
  fresh.restore([{ ...task("create"), state: "succeeded" }]);
  await assert.rejects(fresh.execute(task("stop", "bob")), { status: 403 });
  assert.equal((await fresh.execute(task("stop"))).status, "not-owned");
  assert.deepEqual(fresh.resources("alice"), []);
  await fresh.close();
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await f.adapter.execute(task("stop"))).status, "stopped");
  assertDead(pid);
});

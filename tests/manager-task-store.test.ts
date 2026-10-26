import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../manager/task-store.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const childFixture = path.join(repositoryRoot, "tests/fixtures/task-store-child.mjs");

type ChildMessage =
  | { status: "ready"; taskId?: string }
  | { status: "error"; name: string; message: string };

async function temporaryStore(t: test.TestContext): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-manager-task-store-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root: path.join(parent, "state") };
}

async function startStoreChild(
  parent: string,
  root: string,
  options: { mode?: "hold" | "running"; recoverStaleLock?: boolean } = {},
): Promise<{ child: ChildProcessWithoutNullStreams; message: ChildMessage }> {
  const environmentRoot = path.join(parent, `child-${randomUUID()}`);
  const home = path.join(environmentRoot, "home");
  const xdg = path.join(environmentRoot, "xdg");
  const fallback = path.join(environmentRoot, "fallback");
  await Promise.all([home, xdg, fallback].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const {
    HOME: _home,
    XDG_CONFIG_HOME: _xdgConfig,
    XDG_CACHE_HOME: _xdgCache,
    XDG_DATA_HOME: _xdgData,
    XDG_STATE_HOME: _xdgState,
    PI_AGENT_DIR: _legacyPiAgent,
    PI_CODING_AGENT_DIR: _piAgent,
    PI_MANAGER_CONFIG: _managerConfig,
    PI_WEB_UI_HUB_CONFIG: _legacyManagerConfig,
    ...inherited
  } = process.env;
  const child = spawn(process.execPath, ["--import", "./tests/register-ts.mjs", childFixture], {
    cwd: repositoryRoot,
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      PI_AGENT_DIR: path.join(environmentRoot, "legacy-pi-agent"),
      PI_CODING_AGENT_DIR: path.join(environmentRoot, "pi-agent"),
      PI_MANAGER_CONFIG: path.join(fallback, "manager.json"),
      PI_WEB_UI_HUB_CONFIG: path.join(fallback, "legacy-manager.json"),
      TASK_STORE_ROOT: root,
      TASK_STORE_MODE: options.mode ?? "hold",
      TASK_STORE_RECOVER: options.recoverStaleLock ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const message = await new Promise<ChildMessage>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => fail("Task store child did not report readiness"), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const onError = () => fail("Task store child failed to start");
    const onExit = () => fail("Task store child exited before reporting status");
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 16 * 1024) return fail("Task store child status exceeded its limit");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(output.slice(0, newline)) as ChildMessage;
        if (value.status !== "ready" && value.status !== "error") return fail("Task store child returned invalid status");
        cleanup();
        child.stdout.resume();
        resolve(value);
      } catch {
        fail("Task store child returned invalid JSON");
      }
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return { child, message };
}

async function stopStoreChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin.end("close\n");
  await exited;
}

async function crashStoreChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function readStoredState(root: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root, "tasks.json"), "utf8")) as Record<string, any>;
}

async function writeStoredState(root: string, state: Record<string, any>): Promise<void> {
  await writeFile(path.join(root, "tasks.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function addFillerTask(state: Record<string, any>, index: number, padding: string): Record<string, any> {
  const id = `review-filler-${index}`;
  const key = `review-filler-key-${index}`;
  const now = "2026-10-26T00:00:00.000Z";
  const task = {
    id,
    revision: 1,
    state: "pending_approval",
    createdAt: now,
    updatedAt: now,
    key,
    requester: "review-filler",
    target: `pi:filler-${index}`,
    action: "inspect",
    payload: { padding },
  };
  state.tasks[id] = task;
  (state.idempotency[task.requester] ??= {})[key] = id;
  return task;
}

function fillStateToExactLimit(state: Record<string, any>, limit: number): void {
  for (let index = 0; index < 16; index += 1) addFillerTask(state, index, "x".repeat(60 * 1024));
  const adjustable = addFillerTask(state, 16, "");
  const currentBytes = Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf8");
  const needed = limit - currentBytes;
  assert.ok(needed > 0 && needed < 60 * 1024, `expected adjustable padding below 60 KiB, got ${needed}`);
  adjustable.payload.padding = "x".repeat(needed);
  assert.equal(Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf8"), limit);
}

test("requester-scoped idempotency returns the persisted task and rejects changed content", async (t) => {
  const { root } = await temporaryStore(t);
  const request = {
    key: "create-alpha",
    requester: "operator-a",
    target: "pi:alpha",
    action: "create",
    payload: { workspace: "projects/alpha", source: "stable" },
  };

  const store = await TaskStore.open(root);
  const first = await store.submit(request);
  assert.equal((await store.submit(request)).id, first.id);
  await assert.rejects(store.submit({ ...request, action: "stop" }), /idempotency/i);
  const secondRequester = await store.submit({ ...request, requester: "operator-b" });
  assert.notEqual(secondRequester.id, first.id);
  await store.close();

  const reopened = await TaskStore.open(root);
  assert.equal((await reopened.get(first.id))?.state, "pending_approval");
  assert.equal((await reopened.get(secondRequester.id))?.requester, "operator-b");
  await reopened.close();
});

test("submitted request content is immutable and only bounded JSON values are accepted", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const payload = { nested: { secretReference: "credential-file-a" }, values: [1, 2] };
  const task = await store.submit({
    key: "immutable",
    requester: "operator-a",
    target: "pi:alpha",
    action: "create",
    payload,
  });
  payload.nested.secretReference = "changed-after-submit";
  payload.values.push(3);
  (task.payload as typeof payload).nested.secretReference = "changed-return-value";
  assert.deepEqual((await store.get(task.id))?.payload, {
    nested: { secretReference: "credential-file-a" },
    values: [1, 2],
  });

  await assert.rejects(
    store.submit({
      key: "bigint",
      requester: "operator-a",
      target: "pi:alpha",
      action: "create",
      payload: { invalid: 1n } as never,
    }),
    /JSON/i,
  );
  await assert.rejects(
    store.submit({
      key: "oversized",
      requester: "operator-a",
      target: "pi:alpha",
      action: "create",
      payload: { value: "x".repeat(70 * 1024) },
    }),
    /size/i,
  );
  await assert.rejects(
    store.submit({
      key: "unexpected-field",
      requester: "operator-a",
      target: "pi:alpha",
      action: "create",
      payload: null,
      approvalCredential: "must-not-be-ignored",
    } as never),
    /field|request/i,
  );
  const sparse = Array<string>(1);
  await assert.rejects(
    store.submit({
      key: "sparse-array",
      requester: "operator-a",
      target: "pi:alpha",
      action: "create",
      payload: sparse,
    }),
    /JSON/i,
  );
  await store.close();
});

test("idempotency safely treats prototype-like requester and key strings as data", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const prototypePayload = JSON.parse('{"__proto__":{"preserved":true}}') as { __proto__: { preserved: boolean } };
  const request = {
    key: "__proto__",
    requester: "__proto__",
    target: "pi:prototype",
    action: "inspect",
    payload: prototypePayload,
  };
  const first = await store.submit(request);
  assert.equal((await store.submit(request)).id, first.id);
  const second = await store.submit({ ...request, key: "constructor", requester: "constructor" });
  assert.notEqual(second.id, first.id);
  await store.close();

  const reopened = await TaskStore.open(root);
  assert.equal((await reopened.get(first.id))?.requester, "__proto__");
  const reopenedPayload = (await reopened.get(first.id))?.payload;
  assert.equal(typeof reopenedPayload === "object" && reopenedPayload !== null && Object.hasOwn(reopenedPayload, "__proto__"), true);
  assert.deepEqual(reopenedPayload, prototypePayload);
  assert.equal((await reopened.get(second.id))?.key, "constructor");
  await reopened.close();
});

test("concurrent submissions are serialized without losing persisted tasks", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const tasks = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.submit({
        key: `task-${index}`,
        requester: "operator-a",
        target: `pi:${index}`,
        action: "create",
        payload: { index },
      }),
    ),
  );
  await store.close();

  const reopened = await TaskStore.open(root);
  for (const task of tasks) assert.equal((await reopened.get(task.id))?.id, task.id);
  await reopened.close();
});

test("a persistence failure poisons queued and later writes until the store is reopened", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const request = (key: string) => ({
    key,
    requester: "operator-a",
    target: "pi:alpha",
    action: "inspect",
    payload: null,
  });

  await chmod(root, 0o500);
  const attempts = await Promise.allSettled([store.submit(request("write-failure-a")), store.submit(request("write-failure-b"))]);
  await chmod(root, 0o700);
  assert.equal(attempts.every((attempt) => attempt.status === "rejected"), true);
  await assert.rejects(store.submit(request("write-after-failure")), /close.*reopen|durability|persistence/i);
  await assert.rejects(store.get("missing"), /close.*reopen|durability|persistence/i);
  await store.close();

  const reopened = await TaskStore.open(root);
  const reconciled = await reopened.submit(request("write-failure-a"));
  assert.equal((await reopened.submit(request("write-failure-a"))).id, reconciled.id);
  assert.equal((await reopened.submit(request("write-failure-b"))).state, "pending_approval");
  await reopened.close();
});

test("transitions enforce the state graph and compare-and-set revision", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const first = await store.submit({
    key: "transition",
    requester: "operator-a",
    target: "pi:alpha",
    action: "create",
    payload: { workspace: "projects/alpha" },
  });
  await assert.rejects(store.transition(first.id, "pending_approval", "succeeded"), /transition/i);
  const mutableOptions = { expectedRevision: 1 };
  const queuedPromise = store.transition(first.id, "pending_approval", "queued", mutableOptions);
  mutableOptions.expectedRevision = 999;
  const queued = await queuedPromise;
  assert.equal(queued.revision, 2);
  await assert.rejects(
    store.transition(first.id, "queued", "running", { expectedRevision: 1 }),
    /revision/i,
  );
  const running = await store.transition(first.id, "queued", "running", { expectedRevision: 2 });
  const result = { instanceId: "managed-alpha", exitCode: 0 };
  const succeeded = await store.transition(first.id, "running", "succeeded", {
    expectedRevision: running.revision,
    result,
  });
  result.instanceId = "changed-after-transition";
  assert.equal(succeeded.revision, 4);
  assert.deepEqual((await store.get(first.id))?.result, { instanceId: "managed-alpha", exitCode: 0 });
  await assert.rejects(store.transition(first.id, "running", "failed"), /state/i);
  await store.close();
});

test("state directories and files remain private", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  await store.submit({
    key: "permissions",
    requester: "operator-a",
    target: "pi:alpha",
    action: "inspect",
    payload: null,
  });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, "tasks.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(root, ".task-store.lock"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, ".task-store.lock", "owner.json"))).mode & 0o777, 0o600);
  await store.close();
});

test("a live independent writer is rejected even when stale recovery is requested", async (t) => {
  const { parent, root } = await temporaryStore(t);
  const owner = await startStoreChild(parent, root);
  t.after(() => stopStoreChild(owner.child));
  assert.equal(owner.message.status, "ready");
  await assert.rejects(TaskStore.open(root), /locked/i);
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /locked|ambiguous/i);
  await stopStoreChild(owner.child);
});

test("explicit crash recovery marks running work unknown and never replays it", async (t) => {
  const { parent, root } = await temporaryStore(t);
  const owner = await startStoreChild(parent, root, { mode: "running" });
  assert.equal(owner.message.status, "ready");
  assert.ok(owner.message.taskId);
  await crashStoreChild(owner.child);

  await assert.rejects(TaskStore.open(root), /recovery/i);
  const recovered = await TaskStore.open(root, { recoverStaleLock: true });
  const task = await recovered.get(owner.message.taskId);
  assert.equal(task?.state, "unknown");
  assert.equal(task?.revision, 4);
  await recovered.close();

  const reopened = await TaskStore.open(root);
  assert.equal((await reopened.get(owner.message.taskId))?.state, "unknown");
  await reopened.close();
});

test("failed recovery state loading leaves durable evidence for a later explicit recovery", async (t) => {
  const { parent, root } = await temporaryStore(t);
  const owner = await startStoreChild(parent, root, { mode: "running" });
  assert.equal(owner.message.status, "ready");
  const taskId = owner.message.taskId;
  assert.ok(taskId);
  await crashStoreChild(owner.child);
  const validState = await readFile(path.join(root, "tasks.json"), "utf8");

  await writeFile(path.join(root, "tasks.json"), '{"secret":"recovery-load-failure"', { mode: 0o600 });
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /invalid task store data/i);
  await writeFile(path.join(root, "tasks.json"), validState, { mode: 0o600 });
  await assert.rejects(TaskStore.open(root), /recovery/i);

  const recovered = await TaskStore.open(root, { recoverStaleLock: true });
  assert.equal((await recovered.get(taskId))?.state, "unknown");
  await recovered.close();
});

test("failed recovery persistence leaves durable evidence and cannot reopen a crashed task as running", async (t) => {
  const { parent, root } = await temporaryStore(t);
  const owner = await startStoreChild(parent, root, { mode: "running" });
  assert.equal(owner.message.status, "ready");
  const taskId = owner.message.taskId;
  assert.ok(taskId);
  await crashStoreChild(owner.child);

  const state = await readStoredState(root);
  state.tasks[taskId].revision = 9;
  fillStateToExactLimit(state, 1024 * 1024);
  await writeStoredState(root, state);
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /size/i);

  for (const id of Object.keys(state.tasks)) {
    if (id.startsWith("review-filler-")) delete state.tasks[id];
  }
  delete state.idempotency["review-filler"];
  await writeStoredState(root, state);
  await assert.rejects(TaskStore.open(root), /recovery/i);

  const recovered = await TaskStore.open(root, { recoverStaleLock: true });
  const task = await recovered.get(taskId);
  assert.equal(task?.state, "unknown");
  assert.equal(task?.revision, 10);
  await recovered.close();
});

test("requesting recovery without taking over a stale lock does not rewrite running work", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const submitted = await store.submit({
    key: "clean-reopen",
    requester: "operator-a",
    target: "pi:alpha",
    action: "create",
    payload: null,
  });
  const queued = await store.transition(submitted.id, "pending_approval", "queued", {
    expectedRevision: submitted.revision,
  });
  const running = await store.transition(submitted.id, "queued", "running", {
    expectedRevision: queued.revision,
  });
  await store.close();

  const reopened = await TaskStore.open(root, { recoverStaleLock: true });
  assert.equal((await reopened.get(running.id))?.state, "running");
  assert.equal((await reopened.get(running.id))?.revision, running.revision);
  await reopened.close();
});

test("two stale-lock recoverers cannot remove the replacement live owner's lock", async (t) => {
  const { parent, root } = await temporaryStore(t);
  const staleOwner = await startStoreChild(parent, root);
  assert.equal(staleOwner.message.status, "ready");
  await crashStoreChild(staleOwner.child);

  const [left, right] = await Promise.all([
    startStoreChild(parent, root, { recoverStaleLock: true }),
    startStoreChild(parent, root, { recoverStaleLock: true }),
  ]);
  const contenders = [left, right];
  const winners = contenders.filter(({ message }) => message.status === "ready");
  const losers = contenders.filter(({ message }) => message.status === "error");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  t.after(() => stopStoreChild(winners[0].child));
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /locked|ambiguous/i);
  await stopStoreChild(winners[0].child);
});

test("malformed or identity-ambiguous locks fail closed without exposing raw content", async (t) => {
  const { root } = await temporaryStore(t);
  await mkdir(path.join(root, ".task-store.lock"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, ".task-store.lock", "owner.json"), '{"credential":"do-not-log"', {
    mode: 0o600,
  });
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), (error: unknown) => {
    assert.doesNotMatch(String(error), /do-not-log/);
    return true;
  });

  await rm(path.join(root, ".task-store.lock"), { recursive: true });
  await mkdir(path.join(root, ".task-store.lock"), { mode: 0o700 });
  await writeFile(
    path.join(root, ".task-store.lock", "owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processIdentity: null,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /locked|ambiguous/i);
  assert.equal((await stat(path.join(root, ".task-store.lock"))).isDirectory(), true);

  await rm(path.join(root, ".task-store.lock"), { recursive: true });
  await mkdir(path.join(root, ".task-store.lock"), { mode: 0o700 });
  await writeFile(
    path.join(root, ".task-store.lock", "owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processIdentity: "garbage",
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(TaskStore.open(root, { recoverStaleLock: true }), /locked|ambiguous|malformed/i);
  assert.equal((await stat(path.join(root, ".task-store.lock"))).isDirectory(), true);
});

test("reopen rejects oversized results and results attached to nonterminal states", async (t) => {
  const { root } = await temporaryStore(t);
  const store = await TaskStore.open(root);
  const task = await store.submit({
    key: "persisted-result",
    requester: "operator-a",
    target: "pi:alpha",
    action: "inspect",
    payload: null,
  });
  await store.close();
  const original = await readStoredState(root);

  const nonterminal = structuredClone(original);
  nonterminal.tasks[task.id].result = { impossible: true };
  await writeStoredState(root, nonterminal);
  await assert.rejects(TaskStore.open(root), /invalid task store data/i);

  const oversized = structuredClone(original);
  oversized.tasks[task.id].state = "succeeded";
  oversized.tasks[task.id].result = { value: "x".repeat(70 * 1024) };
  await writeStoredState(root, oversized);
  await assert.rejects(TaskStore.open(root), /invalid task store data|size/i);
});

test("malformed persisted JSON is rejected with a bounded sanitized error and releases the lock", async (t) => {
  const { root } = await temporaryStore(t);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(path.join(root, "tasks.json"), '{"secret":"do-not-log"', { mode: 0o600 });
  await assert.rejects(TaskStore.open(root), (error: unknown) => {
    assert.match(String(error), /invalid task store data/i);
    assert.doesNotMatch(String(error), /do-not-log/);
    return true;
  });

  await writeFile(path.join(root, "tasks.json"), "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(TaskStore.open(root), /size/i);
});

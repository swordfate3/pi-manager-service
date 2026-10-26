import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertDead, harness, observation, waitFor } from "./helpers/native-harness.ts";

test("owned lifecycle requires readiness and closes stdin without terminating manager", async (t) => {
  const { backend, request, workspace } = await harness(t);
  assert.deepEqual(backend.list(), []);
  const identity = await backend.create(request);
  assert.ok(identity.pid > 0 && identity.pid !== process.pid);
  assert.equal((await backend.inspect(request.instanceId))?.status, "ready");
  const stopped = await backend.stop(request.instanceId);
  assert.deepEqual(stopped, { status: "stopped", exitCode: 0, signal: null, forced: false });
  assert.equal(await readFile(path.join(workspace, "orderly-exit"), "utf8"), "stdin closed");
  assertDead(identity.pid);
  assert.deepEqual(backend.list(), []);
  assert.equal(await backend.inspect(request.instanceId), null);
  assert.equal((await backend.stop(request.instanceId)).status, "not-owned");
});

test("concurrent duplicate creates and stops never launch or signal a second child", async (t) => {
  const { backend, request } = await harness(t, "stubborn");
  const creating = backend.create(request);
  await assert.rejects(backend.create(request), /already/);
  const identity = await creating;
  const [first, second] = await Promise.all([backend.stop(request.instanceId), backend.stop(request.instanceId)]);
  assert.deepEqual(first, second);
  assert.equal(first.forced, true);
  assert.equal(first.signal, "SIGKILL");
  assertDead(identity.pid);
});

test("launch strips inherited secrets and pins arguments plus private child roots", async (t) => {
  const names = ["OPENAI_API_KEY", "ADMIN_EXECUTOR_TOKEN", "NODE_OPTIONS", "PI_MANAGER_CONFIG", "PI_WEB_UI_HUB_CONFIG"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "do-not-inherit";
  t.after(() => { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } });
  const { backend, request, workspace, parent } = await harness(t);
  const identity = await backend.create(request);
  const seen = await observation(workspace);
  for (const name of names.slice(0, 3)) assert.equal(seen.env[name], undefined);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_MANAGER_CONFIG", "PI_WEB_UI_HUB_CONFIG"]) {
    assert.ok(seen.env[name].startsWith(parent + path.sep), name);
  }
  assert.equal(seen.env.PI_OFFLINE, "1");
  assert.equal(seen.cwd, workspace);
  assert.deepEqual(seen.argv.slice(0, 4), ["--mode", "rpc", "--no-session", "--offline"]);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-tools", "--no-mcp"]) assert.ok(seen.argv.includes(flag));
  assert.equal((await stat(identity.agentDir)).mode & 0o777, 0o700);
  assert.equal((await stat(identity.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(identity.stateDir, "identity.json"))).mode & 0o777, 0o600);
});

test("workspace traversal, absolute paths, unknown roots and symlink escapes are rejected before spawn", async (t) => {
  const { backend, request, parent, workspace } = await harness(t);
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(path.dirname(workspace), "escape"));
  for (const candidate of ["../outside", "project/../../outside", outside, "escape"]) {
    await assert.rejects(backend.create({ ...request, workspace: { root: "work", path: candidate } }), /workspace/i);
  }
  await assert.rejects(backend.create({ ...request, workspace: { root: "__proto__", path: "project" } }), /workspace/i);
  await assert.rejects(access(path.join(workspace, "observed.json")));
  assert.deepEqual(backend.list(), []);
});

test("callers cannot override executable, arguments, agent root or inject path-like instance IDs", async (t) => {
  const { backend, request } = await harness(t);
  for (const extra of [{ piExecutable: process.execPath }, { args: ["-e", "bad"] }, { agentDir: "/tmp" }, { shell: true }]) {
    await assert.rejects(backend.create({ ...request, ...extra }), /request/i);
  }
  await assert.rejects(backend.create({ ...request, instanceId: "../escape" }), /instance/i);
});

test("forged audit PID and identity cannot redirect control or be adopted by a new backend", async (t) => {
  const { backend, config, request } = await harness(t);
  const identity = await backend.create(request);
  const { NativeBackend } = await import("../manager/backends/native.ts");
  const { readProcessIdentity, matchesProcessIdentity } = await import("../manager/process-identity.ts");
  assert.ok(matchesProcessIdentity(identity.pid, identity.processIdentity));
  assert.equal(matchesProcessIdentity(identity.pid, `${identity.processIdentity}0`), false);
  assert.equal(readProcessIdentity(-1), null);
  assert.throws(() => Object.assign(identity, { pid: process.pid }));
  await writeFile(path.join(identity.stateDir, "identity.json"), JSON.stringify({ ...identity, pid: process.pid, processIdentity: readProcessIdentity(process.pid) }));
  const fresh = new NativeBackend(config);
  assert.deepEqual(fresh.list(), []);
  assert.equal(await fresh.inspect(request.instanceId), null);
  assert.equal((await fresh.stop(request.instanceId)).status, "not-owned");
  await assert.rejects(backend.stop({ ...identity, pid: process.pid } as never), /instance/i);
  assert.equal((await backend.stop(request.instanceId)).status, "stopped");
  assertDead(identity.pid);
});

test("missing executable fails explicitly with empty inventory", async (t) => {
  const { backend, request } = await harness(t, "normal", { piExecutable: "/nonexistent/pi-native-test" });
  await assert.rejects(backend.create(request), /executable/i);
  assert.deepEqual(backend.list(), []);
});

for (const scenario of ["early-exit", "failed-start", "hung", "wrong-id", "wrong-command", "oversize", "invalid-utf8", "bad-json"]) {
  test(`${scenario} startup fails within deadline and reaps its owned child`, async (t) => {
    const { backend, request, workspace } = await harness(t, scenario, { startupTimeoutMs: 400 });
    const start = Date.now();
    await assert.rejects(backend.create(request));
    assert.ok(Date.now() - start < 3000);
    assertDead((await observation(workspace)).pid);
    assert.deepEqual(backend.list(), []);
  });
}

test("startup cancellation and stop during startup clean up the same owned child", async (t) => {
  const { backend, request, workspace } = await harness(t, "hung");
  const controller = new AbortController();
  const result = backend.create(request, { signal: controller.signal });
  const rejected = assert.rejects(result, /abort|cancel|stopp/i);
  await waitFor(async () => access(path.join(workspace, "observed.json")).then(() => true, () => false));
  controller.abort();
  await backend.stop(request.instanceId);
  await rejected;
  assertDead((await observation(workspace)).pid);
});

test("LF framing preserves split UTF-8 and Unicode separators while waiting for settled", async (t) => {
  const { backend, request } = await harness(t);
  await backend.create(request);
  const result = await backend.generate(request.instanceId, "hello");
  assert.deepEqual(result, { disposition: "started", text: "答复🙂\u2028line\u2029end", agentEndObserved: true, settled: true, aborted: false });
});

test("stderr is continuously drained and bounded separately from RPC", async (t) => {
  const { backend, request } = await harness(t, "stderr");
  await backend.create(request);
  await waitFor(async () => (await backend.inspect(request.instanceId))!.stderrBytes === 512);
  assert.equal((await backend.generate(request.instanceId, "hello")).settled, true);
  const inspected = await backend.inspect(request.instanceId);
  assert.equal(inspected?.stderrBytes, 512);
  assert.equal(inspected?.stderrTruncated, true);
});

for (const scenario of ["end-only", "rpc-timeout"]) {
  test(`${scenario} generation deadline rejects and cleans up rather than treating agent_end as settled`, async (t) => {
    const { backend, request } = await harness(t, scenario, { generationTimeoutMs: 200 });
    const identity = await backend.create(request);
    await assert.rejects(backend.generate(request.instanceId, "hello"), /deadline|timeout/i);
    assertDead(identity.pid);
    assert.deepEqual(backend.list(), []);
  });
}

test("handled prompt does not wait for a nonexistent settled event", async (t) => {
  const { backend, request } = await harness(t, "handled");
  await backend.create(request);
  assert.deepEqual(await backend.generate(request.instanceId, "/fixture"), { disposition: "handled", text: "", agentEndObserved: false, settled: false, aborted: false });
});

test("stop rejects pending generation and duplicate generation cannot cross-correlate events", async (t) => {
  const { backend, request } = await harness(t, "end-only");
  const identity = await backend.create(request);
  const generation = backend.generate(request.instanceId, "hello");
  const rejected = assert.rejects(generation, /stopp|exit/i);
  await assert.rejects(backend.generate(request.instanceId, "second"), /busy/i);
  await backend.stop(request.instanceId);
  await rejected;
  assertDead(identity.pid);
});

test("a transient provider error followed by a successful retry waits for session settlement", async (t) => {
  const { backend, request } = await harness(t, "retry");
  await backend.create(request);
  const result = await backend.generate(request.instanceId, "retry this");
  assert.equal(result.text, "答复🙂\u2028line\u2029end");
  assert.equal(result.settled, true);
  assert.equal((await backend.inspect(request.instanceId))?.status, "ready");
});

for (const scenario of ["final-error", "prompt-overflow", "output-overflow"]) {
  test(`${scenario} after readiness rejects generation and reaps the child`, async (t) => {
    const { backend, request } = await harness(t, scenario);
    const identity = await backend.create(request);
    await assert.rejects(backend.generate(request.instanceId, "hello"), /failed|limit/);
    assertDead(identity.pid);
  });
}

test("private root symlinks and group-readable roots are rejected without launching", async (t) => {
  const { backend, config, request, parent, workspace } = await harness(t);
  const outside = path.join(parent, "outside-private");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, config.stateRoot);
  await assert.rejects(backend.create(request), /private|canonical/);
  const { NativeBackend } = await import("../manager/backends/native.ts");
  await chmod(outside, 0o750);
  const other = new NativeBackend({ ...config, stateRoot: outside });
  await assert.rejects(other.create(request), /private/);
  await assert.rejects(access(path.join(workspace, "observed.json")));
});

test("pre-aborted startup does not spawn and a later launch uses fresh independent roots", async (t) => {
  const { backend, request, workspace } = await harness(t);
  await assert.rejects(backend.create(request, { signal: AbortSignal.abort() }));
  await assert.rejects(access(path.join(workspace, "observed.json")));
  const first = await backend.create(request);
  await backend.stop(request.instanceId);
  const second = await backend.create(request);
  assert.notEqual(first.stateDir, second.stateDir);
  assert.notEqual(first.agentDir, second.agentDir);
  assert.notEqual(first.pid, second.pid);
  assertDead(first.pid);
});

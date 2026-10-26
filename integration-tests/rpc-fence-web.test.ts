import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { listen } from "../manager/http.ts";
import { waitFor } from "../tests/helpers/native-harness.ts";
import { packedWeb } from "./fixtures/packed-web.ts";

async function rpcFenceFixture(t: any, preflight = false, correlatedWeb = false) {
  const root = await mkdtemp(path.join(tmpdir(), "manager-rpc-fence-"));
  let child: ChildProcessWithoutNullStreams | undefined, ws: WebSocket | undefined;
  let errors = "";
  t.after(async () => {
    ws?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit"); child.kill("SIGTERM");
      const force = setTimeout(() => child?.kill("SIGKILL"), 3000);
      try { await exit; } finally { clearTimeout(force); }
    }
    await rm(root, { recursive: true, force: true });
  });
  const web = await packedWeb(root, process.env.PI_MANAGER_TEST_WEB_ROOT!);
  for (const name of ["home", "agent", "run", "workspace", "sessions", "probe"]) await mkdir(path.join(root, name), { mode: 0o700 });
  const probe = path.join(root, "probe");
  const reserve = await listen(async (_req, res) => { res.end(); }, 0);
  const port = reserve.port; await reserve.close();
  const token = "a".repeat(64), operation = "b".repeat(32), socketPath = path.join(root, "run", "control.sock");
  const cli = await realpath(path.resolve("node_modules/.bin/pi"));
  child = spawn(process.execPath, ["--import", path.resolve("runtime/pi_rpc_guard.mjs"), cli,
    "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-tools", "--no-mcp",
    // The pausing input hook must run AFTER Web's actual input gate.
    "--session-dir", path.join(root, "sessions"), "--extension", path.join(web, "extensions", "mirror-server.ts"),
    "--extension", path.resolve("integration-tests/fixtures/rpc-fence-provider.ts"), "--provider", "rpc-fence-fixture", "--model", "deterministic"], {
    cwd: path.join(root, "workspace"), stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(root, "home"), LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_AGENT_DIR: path.join(root, "agent"),
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_RUNTIME_PROBE_STATE: probe,
      ...(preflight ? { PI_RUNTIME_PROBE_PREFLIGHT: "1" } : {}),
      ...(correlatedWeb ? { PI_RUNTIME_RPC_WEB_INPUT: "correlated-text-v1" } : {}),
      PI_RUNTIME_RUN_ID: "c".repeat(32), PI_RUNTIME_CHILD_TOKEN: token, PI_RUNTIME_EXTENSION_SOCKET: socketPath,
      PI_WEB_UI_HOST: "127.0.0.1", PI_WEB_UI_PORT: String(port), PI_WEB_UI_DISABLED: "false",
    },
  });
  child.stderr.on("data", data => { errors = (errors + data.toString()).slice(-16_384); });
  const rpc: any[] = []; let buffered = "";
  child.stdout.on("data", data => {
    buffered += data.toString(); assert.ok(buffered.length < 4 * 1024 * 1024);
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) { const frame = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); rpc.push(JSON.parse(frame)); }
  });
  const write = (frame: unknown) => new Promise<void>((resolve, reject) => child!.stdin.write(`${JSON.stringify(frame)}\n`, error => error ? reject(error) : resolve()));
  const control = (fields: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const peer = net.createConnection(socketPath); let data = "";
    peer.setTimeout(2000, () => peer.destroy(Error("Control deadline"))); peer.on("error", reject);
    peer.on("connect", () => peer.end(`${JSON.stringify({ token, ...fields })}\n`));
    peer.on("data", chunk => { data += chunk.toString(); if (data.length > 16384) peer.destroy(Error("Control bound")); });
    peer.on("end", () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  });
  const snapshot = async () => { const value = await control({ action: "snapshot" }); assert.equal(value.ok, true); return value.result; };
  const prepare = (state: any) => control({ action: "prepare", operation_id: operation,
    expected: { runtime_id: state.runtime_id, session_id: state.session_id, leaf_id: state.leaf_id } });
  const trace = async () => (await readFile(path.join(probe, "observations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  await waitFor(async () => (await trace().catch(error => { if (error.code === "ENOENT") return []; throw error; })).some(frame => frame.event === "rpc_ready"), 15_000);
  await write({ id: "ready", type: "get_state" });
  await waitFor(async () => rpc.some(frame => frame.type === "response" && frame.id === "ready"), 15_000)
    .catch(error => { throw Error(`RPC readiness failed (exit ${child?.exitCode}, signal ${child?.signalCode}): ${errors}; frames=${JSON.stringify(rpc)}`, { cause: error }); });
  assert.equal(rpc.find(frame => frame.id === "ready").success, true, errors);
  assert.equal((await snapshot()).busy, false, `Guard must be eligible after readiness: ${JSON.stringify(await trace())}; frames=${JSON.stringify(rpc)}`);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const messages: any[] = [];
  ws.on("message", data => messages.push(JSON.parse(data.toString())));
  await once(ws, "open");
  await waitFor(async () => messages.some(frame => frame.event === "state_sync"));
  const webRequest = async (id: string, method: string, params: unknown) => {
    ws!.send(JSON.stringify({ type: "req", id, method, params }));
    await waitFor(async () => messages.some(frame => frame.type === "res" && frame.id === id));
    return messages.find(frame => frame.type === "res" && frame.id === id);
  };
  return { probe, operation, rpc, write, control, snapshot, prepare, trace, webRequest, errors: () => errors };
}

// Removing the preload, admitting an unknown guard, releasing before settled,
// or bypassing the Web mutation barrier must each break this real-runtime test.
test("real RPC Pi and packed Web freeze both input channels only after generation settles", {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const { probe, operation, rpc, write, control, snapshot, prepare, trace, webRequest, errors } = await rpcFenceFixture(t);
  // Correlated stdin has completion evidence; Web's void dispatch does not.
  await write({ id: "generation", type: "prompt", message: "PROBE_GENERATION" });
  await waitFor(async () => (await trace()).some(frame => frame.event === "provider_call"));
  const busy = await snapshot(); assert.equal(busy.idle, false);
  assert.equal((await prepare(busy)).ok, false, "generating Pi must not be prepared");
  await writeFile(path.join(probe, "release-generation"), "release");
  await waitFor(async () => rpc.some(frame => frame.type === "agent_settled"), 10_000);
  const idle = await snapshot();
  assert.equal(idle.idle, true); assert.equal(idle.busy, false); assert.ok(idle.session_file);
  assert.equal((await prepare(idle)).ok, true);
  assert.equal((await webRequest("blocked-web", "prompt", { message: "PROBE_BOOTSTRAP_ONCE" })).ok, false);
  assert.equal((await webRequest("blocked-thinking", "set_thinking_level", { level: "low" })).ok, false);
  assert.equal((await trace()).filter(frame => frame.event === "provider_call").length, 1);
  assert.equal((await control({ action: "cancel", operation_id: operation })).ok, true);
  await write({ id: "second-generation", type: "prompt", message: "PROBE_BOOTSTRAP_ONCE" });
  await waitFor(async () => rpc.filter(frame => frame.type === "agent_settled").length === 2, 10_000);
  const secondIdle = await snapshot(); assert.equal((await prepare(secondIdle)).ok, true);
  const delivered = (await trace()).filter(frame => frame.event === "stdin").length;
  await write({ id: "blocked-terminal", type: "prompt", message: "PROBE_BOOTSTRAP_ONCE" });
  // An attempted parent write cannot be silently replayed after cancel. It
  // permanently removes update eligibility even though Web can resume normally.
  await waitFor(async () => (await snapshot()).busy === true);
  assert.equal((await trace()).filter(frame => frame.event === "stdin").length, delivered);
  assert.equal((await control({ action: "cancel", operation_id: operation })).ok, true);
  assert.equal((await prepare(await snapshot())).ok, false);
  assert.equal((await webRequest("released-web", "prompt", { message: "PROBE_BOOTSTRAP_ONCE" })).ok, true);
  await waitFor(async () => rpc.filter(frame => frame.type === "agent_settled").length === 3, 10_000);
  assert.equal((await webRequest("final-read", "get_state", {})).ok, true);
  assert.equal((await trace()).filter(frame => frame.event === "provider_call").length, 3);
  assert.equal(rpc.some(frame => frame.id === "blocked-terminal"), false);
  assert.equal(errors(), "");
});

test('opt-in correlated packed Web prompt holds preflight and restores update eligibility after real settlement', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const f = await rpcFenceFixture(t, true, true);
  await f.write({ id: 'bootstrap', type: 'prompt', message: 'PROBE_BOOTSTRAP_ONCE' });
  await waitFor(async () => f.rpc.some(frame => frame.type === 'agent_settled'));
  assert.equal((await f.webRequest('correlated', 'prompt', { message: 'PROBE_PREFLIGHT_input' })).ok, true);
  await waitFor(async () => (await f.trace()).some(frame => frame.event === 'preflight_paused'));
  const held = await f.snapshot();
  assert.equal(held.idle, true, 'Authoritative input guard must cover SDK idle during preflight');
  assert.equal((await f.prepare(held)).ok, false);
  await writeFile(path.join(f.probe, 'release-input'), 'release');
  await waitFor(async () => f.rpc.filter(frame => frame.type === 'agent_settled').length === 2);
  const completed = await f.snapshot();
  assert.equal(completed.busy, false, 'Ordinary Web chat must not permanently prevent managed updates');
  assert.equal((await f.prepare(completed)).ok, true);
  assert.equal((await f.webRequest('held-web', 'prompt', { message: 'PROBE_BOOTSTRAP_ONCE' })).ok, false);
  assert.equal((await f.control({ action: 'cancel', operation_id: f.operation })).ok, true);
  assert.equal((await f.webRequest('next', 'prompt', { message: 'PROBE_BOOTSTRAP_ONCE' })).ok, true);
  await waitFor(async () => f.rpc.filter(frame => frame.type === 'agent_settled').length === 3);
  assert.equal((await f.trace()).filter(frame => frame.event === 'provider_call').length, 3);
  assert.equal((await f.prepare(await f.snapshot())).ok, true);
  assert.equal((await f.control({ action: 'cancel', operation_id: f.operation })).ok, true);
  assert.equal(f.errors(), '');
});

test('opt-in correlated Web handled preflight remains ineligible after unrelated settlement', {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const f = await rpcFenceFixture(t, true, true);
  await f.write({ id: 'bootstrap', type: 'prompt', message: 'PROBE_BOOTSTRAP_ONCE' });
  await waitFor(async () => f.rpc.some(frame => frame.type === 'agent_settled'));
  assert.equal((await f.webRequest('oversized', 'prompt', { message: 'x'.repeat(65537) })).ok, false);
  assert.equal((await f.snapshot()).busy, false, 'Refused dispatch must not taint or fall back to SDK');
  assert.equal((await f.webRequest('handled', 'prompt', { message: 'PROBE_HANDLED' })).ok, true);
  await waitFor(async () => (await f.trace()).some(frame => frame.event === 'handled_pending'));
  assert.equal((await f.prepare(await f.snapshot())).ok, false);
  await writeFile(path.join(f.probe, 'release-handled'), 'release');
  await waitFor(async () => f.rpc.some(frame => frame.type === 'response' && frame.command === 'prompt' && frame.data?.disposition === 'handled'));
  await f.write({ id: 'unrelated', type: 'prompt', message: 'PROBE_BOOTSTRAP_ONCE' });
  await waitFor(async () => f.rpc.filter(frame => frame.type === 'agent_settled').length === 2);
  assert.equal((await f.prepare(await f.snapshot())).ok, false, 'An unrelated generation cannot clear handled-work uncertainty');
  assert.equal((await f.trace()).filter(frame => frame.event === 'provider_call').length, 2);
  assert.equal(f.errors(), '');
});

// These new tests run the installed archive and real guard. Restoring Web's
// untracked void dispatch must let prepare succeed during the held preflight.
for (const [method, stage] of [["prompt", "input"], ["steer", "input"], ["follow_up", "input"], ["prompt", "before_agent_start"]]) {
  test(`RPC preflight ${method} remains ineligible after Web input gate during ${stage}`, {
    skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
  }, async t => {
    const f = await rpcFenceFixture(t, true);
    // Persist a session so a missing session file cannot mask unsafe admission.
    await f.write({ id: "bootstrap", type: "prompt", message: "PROBE_BOOTSTRAP_ONCE" });
    await waitFor(async () => f.rpc.some(frame => frame.type === "agent_settled"));
    assert.equal((await f.trace()).find(frame => frame.event === "rpc_ready").version, "1.1.0");
    assert.equal((await f.prepare(await f.snapshot())).ok, true);
    assert.equal((await f.webRequest("denied", method, { message: "PROBE_BOOTSTRAP_ONCE" })).ok, false);
    assert.equal((await f.control({ action: "cancel", operation_id: f.operation })).ok, true);
    assert.equal((await f.snapshot()).busy, false, "Rejected input must not taint a later accepted dispatch");

    assert.equal((await f.webRequest("accepted", method, { message: `PROBE_PREFLIGHT_${stage}` })).ok, true);
    await waitFor(async () => (await f.trace()).some(frame => frame.event === "preflight_paused" && frame.stage === stage));
    assert.equal(f.rpc.filter(frame => frame.type === "agent_start").length, 1, "No new generation before release");
    const held = await f.snapshot();
    assert.equal(held.idle, true, "Pi still reports idle in the deferred interval");
    assert.equal(held.pending, false);
    const prepared = await f.prepare(held);
    // On RED, release any accidentally granted lease before fixture cleanup.
    if (prepared.ok) await f.control({ action: "cancel", operation_id: f.operation });
    assert.equal(prepared.ok, false, "Accepted Web preflight must reject prepare before agent_start");
    await writeFile(path.join(f.probe, `release-${stage}`), "release");
    await waitFor(async () => f.rpc.filter(frame => frame.type === "agent_settled").length === 2);
    assert.equal((await f.trace()).filter(frame => frame.event === "provider_call").length, 2);
    assert.equal((await f.prepare(await f.snapshot())).ok, false, "Uncorrelated settlement cannot clear void dispatch uncertainty");
    assert.equal((await f.webRequest("later", "prompt", { message: "PROBE_BOOTSTRAP_ONCE" })).ok, true);
    await waitFor(async () => f.rpc.filter(frame => frame.type === "agent_settled").length === 3);
    assert.equal((await f.webRequest("read", "get_state", {})).ok, true);
    assert.equal(f.errors(), "");
  });
}

test("RPC preflight handled Web input stays ineligible across an unrelated generation settlement", {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const f = await rpcFenceFixture(t, true);
  await f.write({ id: "bootstrap", type: "prompt", message: "PROBE_BOOTSTRAP_ONCE" });
  await waitFor(async () => f.rpc.some(frame => frame.type === "agent_settled"));
  assert.equal((await f.webRequest("handled", "prompt", { message: "PROBE_HANDLED" })).ok, true);
  await waitFor(async () => (await f.trace()).some(frame => frame.event === "handled_pending"));
  const prepared = await f.prepare(await f.snapshot());
  if (prepared.ok) await f.control({ action: "cancel", operation_id: f.operation });
  assert.equal(prepared.ok, false, "Handled input owns deferred work without agent_start");
  await f.write({ id: "unrelated", type: "prompt", message: "PROBE_BOOTSTRAP_ONCE" });
  await waitFor(async () => f.rpc.filter(frame => frame.type === "agent_settled").length === 2);
  assert.equal((await f.prepare(await f.snapshot())).ok, false);
  await writeFile(path.join(f.probe, "release-handled"), "release");
  await waitFor(async () => (await f.trace()).some(frame => frame.event === "handled_finished"));
  assert.equal((await f.prepare(await f.snapshot())).ok, false);
  assert.equal((await f.trace()).filter(frame => frame.event === "provider_call").length, 2);
  assert.equal(f.errors(), "");
});

test("RPC preflight queued Web follow-up cannot regain eligibility after generation settles", {
  skip: !process.env.PI_MANAGER_TEST_WEB_ROOT, timeout: 45_000,
}, async t => {
  const f = await rpcFenceFixture(t, true);
  await f.write({ id: "generation", type: "prompt", message: "PROBE_GENERATION" });
  await waitFor(async () => (await f.trace()).some(frame => frame.event === "provider_call"));
  assert.equal((await f.webRequest("queued", "follow_up", { message: "PROBE_BOOTSTRAP_ONCE" })).ok, true);
  await waitFor(async () => (await f.snapshot()).pending === true);
  assert.equal((await f.prepare(await f.snapshot())).ok, false);
  await writeFile(path.join(f.probe, "release-generation"), "release");
  await waitFor(async () => f.rpc.some(frame => frame.type === "agent_settled"));
  assert.equal((await f.trace()).filter(frame => frame.event === "provider_call").length, 2);
  assert.equal((await f.prepare(await f.snapshot())).ok, false, "Queued void dispatch has no correlated completion");
  assert.equal(f.errors(), "");
});

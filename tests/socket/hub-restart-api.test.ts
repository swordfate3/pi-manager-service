import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

const runRuntime = {
  runtimeId: "runtime-old",
  sessionId: "session-saved",
  leafId: "branch-leaf",
  version: "1.0.0",
  managed: true,
};
const key = "a".repeat(32);

async function fixture(t: test.TestContext, managed = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-restart-"));
  const configFile = path.join(dir, "hub.json");
  initializeHub(configFile, { port: 0, leaseMs: 300000, management: { port: 0 } });
  const config = readHubConfig(configFile);
  const token = "e".repeat(64);
  let runId = "";
  let job: Record<string, unknown> = { id: key, status: "pending", stage: "pending" };
  let posts = 0;
  let loseReply = false;
  const gate = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method === "POST") {
      posts++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      assert.equal(value.run_id, runId);
      assert.equal(value.idempotency_key, key);
      if (loseReply) {
        req.socket.destroy();
        return;
      }
    }
    const value = req.url?.includes("/runs/")
      ? {
          managed: true,
          run_id: runId,
          runtime_id: runRuntime.runtimeId,
          session_id: runRuntime.sessionId,
          leaf_id: runRuntime.leafId,
          version: "1.0.0",
          idle: true,
          pending: false,
          busy: false,
          mode: "auto",
          container_id: "secret-container",
          session_file: "/private/session",
        }
      : { ...job, run_id: runId, session_file: "/private/session" };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  if (managed) {
    const credentialFile = path.join(dir, "lifecycle.json");
    writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
    config.lifecycle = { endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`, credentialFile };
  }
  let hub = await startHub(config);
  const credential = issueSession(config, path.join(dir, "run.json"), { label: "Isolated test" });
  runId = credential.run_id;
  let generation = "1".repeat(32);
  let hold: ((release: () => void) => void) | undefined;
  const proof = (value: string) => createHmac("sha256", credential.token).update(value).digest("hex");
  const backend = http.createServer((req, res) => {
    const challenge = req.headers["x-pi-web-challenge"] as string;
    const answer = JSON.stringify({ generation, proof: proof(`${challenge}:${generation}`) });
    const release = () => res.writeHead(200).end(answer);
    if (hold) {
      const callback = hold;
      hold = undefined;
      callback(release);
    } else release();
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ server: backend });
  const register = async (next: string, runtime: unknown = runRuntime, action = "register") => {
    generation = next;
    return await new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath, () =>
        socket.write(
          `${JSON.stringify({
            action,
            ...credential,
            generation,
            port: (backend.address() as net.AddressInfo).port,
            runtime,
          })}\n`,
        ),
      );
      let raw = "";
      socket.on("data", (chunk) => {
        raw += chunk;
        if (raw.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(raw));
        }
      });
      socket.on("error", reject);
    });
  };
  assert.equal((await register(generation)).ok, true);
  let cookie = "";
  let csrf = "";
  const request = async (
    route: string,
    value?: unknown,
    authorized = true,
    origin = hub.managementUrl!.slice(0, -1),
  ) => {
    return fetch(`${hub.managementUrl}api/management/${route}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(authorized ? { Cookie: cookie, "X-Pi-Hub-Csrf": csrf } : {}),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  };
  const unlock = async () => {
    const code = issueManagementCode(config).code;
    const response = await request("unlock", { code });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    csrf = (await response.json()).csrf;
  };
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await hub.close();
    backend.closeAllConnections();
    gate.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => backend.close(() => r())),
      new Promise<void>((r) => gate.close(() => r())),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
  const payload = {
    generation,
    runtimeId: runRuntime.runtimeId,
    sessionId: runRuntime.sessionId,
    leafId: runRuntime.leafId,
    idempotencyKey: key,
  };
  return {
    request,
    unlock,
    register,
    config,
    runId,
    payload,
    get url() {
      return hub.url;
    },
    reopen: async () => {
      await hub.close();
      hub = await startHub(config);
    },
    backendDisconnected: () =>
      Promise.all(
        [...wss.clients].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))),
      ),
    holdProof: () =>
      new Promise<() => void>((resolve) => {
        hold = resolve;
      }),
    receiptExists: () => existsSync(path.join(config.stateDir, "restarts", `${key}.json`)),
    delayedBody: () => {
      let finish!: () => void;
      const response = new Promise<number>((resolve, reject) => {
        const raw = JSON.stringify(payload);
        const req = http.request(
          `${hub.managementUrl}api/management/restarts`,
          {
            method: "POST",
            headers: {
              Origin: new URL(hub.managementUrl!).origin,
              Cookie: cookie,
              "X-Pi-Hub-Csrf": csrf,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(raw),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
        req.write(raw.slice(0, 1));
        finish = () => req.end(raw.slice(1));
      });
      return { response, finish };
    },
    posts: () => posts,
    setJob: (value: Record<string, unknown>) => {
      job = value;
    },
    loseReply: () => {
      loseReply = true;
    },
  };
}

test("inbox management does not grant a restart provider and loopback alone cannot authorize", async (t) => {
  const f = await fixture(t, false);
  assert.deepEqual(await (await f.request("status")).json(), {
    available: true,
    authorized: false,
    interactionsAvailable: true,
    restartAvailable: false,
  });
  assert.equal((await f.request(`targets/${f.payload.generation}`)).status, 401);
  await f.unlock();
  assert.equal((await f.request("restarts", f.payload)).status, 503);
  assert.equal(f.posts(), 0);
});

test("receipt admission shares the byte quota and never submits after refusal", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  writeFileSync(path.join(f.config.stateDir, "foreign-retained-state"), Buffer.alloc(8 * 1024 * 1024), { mode: 0o600 });
  assert.equal((await f.request("restarts", f.payload)).status, 409);
  assert.equal(f.receiptExists(), false);
  assert.equal(f.posts(), 0);
});

test("receipt clocks use the writer fence and preserve existing idempotency evidence", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  assert.equal((await f.request("restarts", f.payload)).status, 202);
  const receiptFile = path.join(f.config.stateDir, "restarts", `${key}.json`);
  const original = readFileSync(receiptFile, "utf8");
  f.setJob({ id: key, status: "running", stage: "starting", started_at: Date.now() });
  mkdirSync(path.join(f.config.stateDir, ".writer.lock"), { mode: 0o700 });
  assert.equal((await f.request(`restarts/${key}`)).status, 409);
  assert.equal(existsSync(path.join(f.config.stateDir, "restarts", `${key}.started.json`)), false);
  assert.equal(readFileSync(receiptFile, "utf8"), original);
  assert.equal(f.posts(), 1);
});

test("storage diagnostics require management authorization and expose aggregate budgets only", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("storage")).status, 401);
  assert.equal((await fetch(`${f.url}api/management/storage`)).status, 404);
  await f.unlock();
  const response = await f.request("storage");
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.limitBytes, 8388608);
  assert.equal(value.activeGrantLimit, 512);
  assert.equal(value.activeGrants, 1);
  assert.ok(value.logicalBytes > 0 && value.logicalBytes <= 8388608);
  for (const forbidden of [f.runId, f.config.stateDir, "runtime-old", "session-saved"])
    assert.ok(!JSON.stringify(value).includes(forbidden));
});

const completedJob = () => ({
  id: key,
  status: "succeeded",
  stage: "complete",
  started_at: Date.now(),
  old_runtime_id: runRuntime.runtimeId,
  new_runtime_id: "runtime-new",
  session_id: runRuntime.sessionId,
  leaf_id: runRuntime.leafId,
  expected_version: "1.1.0",
  new_version: "1.1.0",
});

async function managedChat(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const socket = new WebSocket(`${f.url.replace("http", "ws")}s/${f.payload.generation}/ws`, {
    origin: new URL(f.url).origin,
  });
  t.after(() => socket.terminate());
  const routes: Array<{ generation: string; token: string; restart?: { id: string } }> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.event === "hub_route") routes.push(message.payload);
  });
  const waitRoute = async (count: number) => {
    if (routes.length >= count) return routes[count - 1];
    await new Promise<void>((resolve, reject) => {
      const listener = () => {
        if (routes.length < count) return;
        clearTimeout(timer);
        socket.off("message", listener);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.off("message", listener);
        reject(new Error("Expected Hub route update"));
      }, 2000);
      socket.on("message", listener);
    });
    return routes[count - 1];
  };
  const route = await waitRoute(1);
  await f.unlock();
  assert.equal((await f.request("restarts", f.payload)).status, 202);
  assert.equal((await waitRoute(2)).restart?.id, key);
  return {
    socket,
    waitRoute,
    disconnect: async () => {
      const backendClosed = f.backendDisconnected();
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
      await backendClosed;
    },
    handoff: () =>
      fetch(`${f.url}api/session-handoff`, {
        method: "POST",
        headers: { Origin: new URL(f.url).origin, "X-Pi-Web-Handoff": route.token },
      }),
  };
}

for (const status of ["rejected", "failed", "stale", "recovery_required"]) {
  test(`${status} restart restores live original chat's ordinary recovery without successor authority`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const f = await fixture(t);
    const chat = await managedChat(t, f);
    f.setJob({ id: key, status, stage: status === "failed" ? "checking_rejected" : status });
    assert.equal((await (await f.request(`restarts/${key}`)).json()).status, status);
    const response = await chat.handoff();
    assert.equal(response.status, 200, "cleanup must retain the healthy original's recovery capability");
    assert.equal((await response.json()).path, `/s/${f.payload.generation}/`);
    const ordinary = await chat.waitRoute(3);
    assert.equal(ordinary.restart, undefined, "connected browser must leave the managed window");
    assert.equal(ordinary.generation, f.payload.generation);
    // Repeated terminal queries cannot rearm managed authority.
    await f.request(`restarts/${key}`);
    await chat.disconnect();
    now += 14_000;
    const recovered = await chat.handoff();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).path, `/s/${f.payload.generation}/`);
    if (status === "failed") {
      now += 32_000;
      assert.equal((await chat.handoff()).status, 410, "ordinary Hub token is not a 210-second lease");
    } else {
      await f.register("2".repeat(32), { ...runRuntime, runtimeId: "unapproved-successor" });
      assert.equal((await chat.handoff()).status, 410, "failed restart cannot follow a later generation");
    }
    assert.equal(f.posts(), 1);
  });
}

for (const change of ["disconnected", "retired", "runtime-changed", "revoked"]) {
  test(`failed restart cannot restore ordinary authority after original is ${change}`, async (t) => {
    const f = await fixture(t);
    const chat = await managedChat(t, f);
    if (change === "disconnected") await chat.disconnect();
    if (change === "retired") await f.register("2".repeat(32), { ...runRuntime, runtimeId: "other" });
    if (change === "runtime-changed") await f.register(f.payload.generation, { ...runRuntime, runtimeId: "other" });
    if (change === "revoked") revokeSession(f.config, f.runId);
    f.setJob({ id: key, status: "failed", stage: "checking_rejected" });
    await f.request(`restarts/${key}`);
    assert.equal((await chat.handoff()).status, 410);
  });
}

test("restored ordinary token rechecks original runtime after asynchronous proof", async (t) => {
  const f = await fixture(t);
  const chat = await managedChat(t, f);
  f.setJob({ id: key, status: "rejected", stage: "rejected" });
  await f.request(`restarts/${key}`);
  const held = f.holdProof();
  const response = chat.handoff();
  // Before the fix there is no token/proof; fail promptly instead of waiting.
  const release = await Promise.race([
    held,
    response.then(() => {
      throw new Error("Handoff skipped live proof");
    }),
  ]);
  await f.register(f.payload.generation, { ...runRuntime, runtimeId: "other" });
  release();
  assert.equal((await response).status, 410);
});

test("initial terminal submission never claims restoration without a verified successor", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.setJob(completedJob());
  const result = await (await f.request("restarts", f.payload)).json();
  assert.equal(result.status, "running");
  assert.equal(result.stage, "waiting_for_registration");
});

test("initial terminal submission rejects mismatched restored identity", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.setJob({ ...completedJob(), session_id: "wrong" });
  const result = await (await f.request("restarts", f.payload)).json();
  assert.equal(result.status, "failed");
});

test("revocation during backend proof prevents receipt and provider submission", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const held = f.holdProof();
  const pending = f.request("restarts", f.payload);
  const release = await held;
  revokeManagement(f.config);
  release();
  assert.equal((await pending).status, 401);
  assert.equal(f.posts(), 0);
  assert.equal(f.receiptExists(), false);
});

for (const wait of ["body", "proof"] as const)
  for (const withdraw of ["revoke", "logout", "expiry"] as const) {
    test(`${withdraw} during ${wait} wait cannot persist, arm or submit`, async (t) => {
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const f = await fixture(t);
      await f.unlock();
      let pending: Promise<number>;
      let release: () => void;
      if (wait === "proof") {
        const held = f.holdProof();
        pending = f.request("restarts", f.payload).then((r) => r.status);
        release = await held;
      } else {
        const held = f.delayedBody();
        pending = held.response;
        release = held.finish;
        // An unrelated completed request gives the local server a chance to consume
        // the first body byte without allowing this request to finish.
        await f.request("status");
      }
      if (withdraw === "revoke") revokeManagement(f.config);
      else if (withdraw === "logout") assert.equal((await f.request("logout", {})).status, 200);
      else now += 1_800_001;
      release();
      assert.equal(await pending, 401);
      assert.equal(f.posts(), 0);
      assert.equal(f.receiptExists(), false);
    });
  }

for (const changed of [{ runtimeId: "wrong" }, { sessionId: "wrong" }, { leafId: "wrong" }, { version: "wrong" }]) {
  test(`successor proof rechecks in-place renewal ${Object.keys(changed)[0]}`, async (t) => {
    const f = await fixture(t);
    await f.unlock();
    await f.request("restarts", f.payload);
    f.setJob(completedJob());
    const successor = { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" };
    const generation = "2".repeat(32);
    await f.register(generation, successor);
    const held = f.holdProof();
    const pending = f.request(`restarts/${key}`);
    const release = await held;
    assert.equal((await f.register(generation, { ...successor, ...changed })).ok, true);
    release();
    assert.equal((await (await pending).json()).status, "running");
  });
}

test("management requires one-time pairing, CSRF and origin and sanitizes target and job", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("restarts", f.payload)).status, 401);
  await f.unlock();
  assert.equal((await f.request("restarts", f.payload, false)).status, 401);
  assert.equal((await f.request("restarts", f.payload, true, "https://attacker.invalid")).status, 403);
  const target = await (await f.request(`targets/${f.payload.generation}`)).json();
  assert.equal(target.managed, true);
  assert.equal(target.runtime_id, runRuntime.runtimeId);
  assert.equal(JSON.stringify(target).includes("private"), false);
  assert.equal(target.run_id, undefined);
  assert.equal(target.container_id, undefined);
  assert.equal((await f.request("restarts", { ...f.payload, runtimeId: "wrong" })).status, 409);
  assert.equal(f.posts(), 0);
  assert.equal((await f.request("restarts", f.payload)).status, 202);
  const retry = await f.request("restarts", f.payload);
  assert.equal(retry.status, 200);
  assert.equal(f.posts(), 1);
  assert.equal(JSON.stringify(await retry.json()).includes("private"), false);
});

test("a paired browser retains pending handoff beyond three minutes and resolves only the exact successor", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  await f.unlock();
  const socket = new WebSocket(`${f.url.replace("http", "ws")}s/${f.payload.generation}/ws`, {
    origin: new URL(f.url).origin,
  });
  t.after(() => socket.terminate());
  const route = await new Promise<{ token: string }>((resolve) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event === "hub_route") resolve(message.payload);
    }),
  );
  await f.request("restarts", f.payload);
  const handoff = () =>
    fetch(`${f.url}api/session-handoff`, {
      method: "POST",
      headers: {
        Origin: new URL(f.url).origin,
        "X-Pi-Web-Handoff": route.token,
      },
    });
  now += 200_000;
  assert.equal((await handoff()).status, 202);
  const job = completedJob();
  f.setJob(job);
  now += 160_000;
  assert.equal((await handoff()).status, 202, "beyond 155s but within the 210s execution budget");
  await f.register("3".repeat(32), { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" });
  assert.equal((await (await handoff()).json()).path, `/s/${"3".repeat(32)}/`);
  now += 210_001;
  assert.equal((await handoff()).status, 410, "polling cannot renew the retirement handoff budget");
});

test("a lost submission reply is queried by the same receipt and never repeats a stop", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.loseReply();
  assert.equal((await f.request("restarts", f.payload)).status, 409);
  assert.equal((await f.request("restarts", f.payload)).status, 200);
  assert.equal(f.posts(), 1);
});

test("success requires exact restored runtime, conversation and branch, not the first registration", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const socket = new WebSocket(`${f.url.replace("http", "ws")}s/${f.payload.generation}/ws`, {
    origin: new URL(f.url).origin,
  });
  t.after(() => socket.terminate());
  const route = await new Promise<{ token: string }>((resolve) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event === "hub_route") resolve(message.payload);
    }),
  );
  const control = new Promise<Record<string, unknown>>((resolve) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.payload?.restart) resolve(message.payload.restart);
    }),
  );
  await f.request("restarts", f.payload);
  assert.deepEqual(await control, { id: key, timeoutMs: 120_000 });
  const handoff = () =>
    fetch(`${f.url}api/session-handoff`, {
      method: "POST",
      headers: { Origin: new URL(f.url).origin, "X-Pi-Web-Handoff": route.token },
    });
  assert.equal((await handoff()).status, 202);
  f.setJob({
    id: key,
    status: "succeeded",
    stage: "complete",
    started_at: Date.now(),
    old_runtime_id: runRuntime.runtimeId,
    new_runtime_id: "runtime-new",
    session_id: runRuntime.sessionId,
    leaf_id: runRuntime.leafId,
    old_version: "1.0.0",
    expected_version: "1.1.0",
    new_version: "1.1.0",
  });
  assert.equal((await (await f.request(`restarts/${key}`)).json()).stage, "waiting_for_registration");
  await f.register("2".repeat(32), { ...runRuntime, runtimeId: "other", sessionId: "other" });
  assert.equal((await handoff()).status, 202, "managed handoff must not bind the first arbitrary registration");
  assert.equal((await (await f.request(`restarts/${key}`)).json()).stage, "waiting_for_registration");
  await f.register("3".repeat(32), { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" });
  const final = await (await f.request(`restarts/${key}`)).json();
  assert.equal(final.status, "succeeded");
  assert.equal(final.path, `/s/${"3".repeat(32)}/`);
  assert.equal((await (await handoff()).json()).path, final.path);
  revokeSession(f.config, f.runId);
  assert.equal((await f.request(`restarts/${key}`)).status, 409);
});

test("manual pending time is excluded; readiness allows beyond 155 seconds but ends at 210", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  await f.unlock();
  f.setJob({ id: key, status: "pending", stage: "pending" });
  await f.request("restarts", f.payload);
  now += 200_000;
  f.setJob(completedJob());
  assert.equal((await (await f.request(`restarts/${key}`)).json()).stage, "waiting_for_registration");
  now += 160_000;
  assert.equal((await (await f.request(`restarts/${key}`)).json()).stage, "waiting_for_registration");
  now += 50_001;
  assert.equal((await (await f.request(`restarts/${key}`)).json()).stage, "registration_timeout");
});

test("running and success require bounded started_at and cannot extend it on later polls", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const started = Date.now();
  f.setJob({ id: key, status: "pending", stage: "pending" });
  await f.request("restarts", f.payload);
  for (const started_at of [undefined, -1, 1.5, Date.now() + 99_999]) {
    f.setJob({ ...completedJob(), started_at });
    assert.equal((await f.request(`restarts/${key}`)).status, 409);
  }
  f.setJob({ ...completedJob(), started_at: started });
  assert.equal((await f.request(`restarts/${key}`)).status, 200);
  f.setJob({ ...completedJob(), started_at: started + 1 });
  assert.equal((await f.request(`restarts/${key}`)).status, 409);
});

test("a restoration verified inside budget remains completed on later queries without granting a new handoff lease", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  await f.unlock();
  await f.request("restarts", f.payload);
  f.setJob(completedJob());
  await f.register("3".repeat(32), { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" });
  assert.equal((await (await f.request(`restarts/${key}`)).json()).status, "succeeded");
  now += 210_001;
  assert.equal((await (await f.request(`restarts/${key}`)).json()).status, "succeeded");
});

for (const change of ["leaf-progress", "session-switch", "session-exit", "generation-rotation", "hub-reopen"]) {
  test(`historical success survives ${change} without an unsafe link or renewed handoff`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const f = await fixture(t);
    const chat = await managedChat(t, f);
    const runtime = { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" };
    f.setJob(completedJob());
    await f.register("3".repeat(32), runtime);
    const first = await (await f.request(`restarts/${key}`)).json();
    assert.equal(first.status, "succeeded");
    assert.equal(first.path, `/s/${"3".repeat(32)}/`);
    assert.equal((await chat.handoff()).status, 200);
    const completionFile = path.join(f.config.stateDir, "restarts", `${key}.verified.json`);
    const persisted = readFileSync(completionFile, "utf8");
    if (change === "leaf-progress") await f.register("3".repeat(32), { ...runtime, leafId: "next-leaf" });
    if (change === "session-switch") await f.register("3".repeat(32), { ...runtime, sessionId: "other-session" });
    if (change === "session-exit") await f.register("3".repeat(32), runtime, "unregister");
    if (change === "hub-reopen") {
      await f.reopen();
      await f.unlock();
    }
    if (["generation-rotation", "hub-reopen"].includes(change)) await f.register("4".repeat(32), runtime);
    for (const elapsed of [0, 210_001]) {
      now += elapsed;
      const response = await f.request(`restarts/${key}`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, "succeeded", "a completed restart is history, not current availability");
      assert.equal(result.stage, "complete");
      assert.equal(result.path, undefined, "never substitute a new generation or changed identity");
      assert.equal((await chat.handoff()).status, 410);
      assert.equal(
        readFileSync(completionFile, "utf8"),
        persisted,
        "queries must not rewrite completion time/evidence",
      );
    }
    assert.equal((await f.request(`restarts/${key}`, undefined, false)).status, 401);
    revokeSession(f.config, f.runId);
    assert.equal((await f.request(`restarts/${key}`)).status, 409, "historical status does not bypass revocation");
    assert.equal(f.posts(), 1);
  });
}

test("persisted completion is bound to the receipt and immutable execution identity", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  await f.request("restarts", f.payload);
  const job = completedJob();
  f.setJob(job);
  await f.register("3".repeat(32), { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" });
  assert.equal((await (await f.request(`restarts/${key}`)).json()).status, "succeeded");
  const file = path.join(f.config.stateDir, "restarts", `${key}.verified.json`);
  const valid = JSON.parse(readFileSync(file, "utf8"));
  for (const mutation of [
    { at: job.started_at + 210_000 },
    { at: job.started_at - 1 },
    { at: 1.5 },
    { path: "https://untrusted.invalid/" },
    { runtimeId: "forged-runtime" },
    { version: "forged-version" },
    { id: "b".repeat(32) },
    { run_id: "b".repeat(32) },
    { generation: "9".repeat(32) },
    { old_runtime_id: "forged-old" },
    { session_id: "forged-session" },
    { leaf_id: "forged-leaf" },
    { started_at: job.started_at + 1 },
  ]) {
    writeFileSync(file, JSON.stringify({ ...valid, ...mutation }));
    assert.equal((await f.request(`restarts/${key}`)).status, 409, JSON.stringify(mutation));
  }
  writeFileSync(file, JSON.stringify(valid));
  for (const mutation of [{ old_runtime_id: "wrong" }, { session_id: "wrong" }, { leaf_id: "wrong" }]) {
    f.setJob({ ...job, ...mutation });
    assert.equal((await (await f.request(`restarts/${key}`)).json()).status, "failed");
  }
});

test("historical query still rechecks grant revocation across live proof", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  await f.request("restarts", f.payload);
  f.setJob(completedJob());
  await f.register("3".repeat(32), { ...runRuntime, runtimeId: "runtime-new", version: "1.1.0" });
  assert.equal((await (await f.request(`restarts/${key}`)).json()).status, "succeeded");
  const held = f.holdProof();
  const response = f.request(`restarts/${key}`);
  const release = await held;
  revokeSession(f.config, f.runId);
  release();
  assert.equal((await response).status, 409);
});

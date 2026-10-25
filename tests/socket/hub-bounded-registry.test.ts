import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../../hub/config.ts";
import { startHub } from "../../hub/server.ts";
import { isolatedHubCliEnvironment } from "../helpers/hub-cli.ts";

const protocol = "bounded-v2";
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "bounded-registry-"));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, leaseMs: 300000 });
  const config = readHubConfig(file);
  let hub = await startHub(config, { versions: { source: async () => ({}) } });
  const credential = issueSession(config, path.join(dir, "cap.json"), { label: "fixture" });
  let generation = "";
  let hold: (() => Promise<void>) | undefined;
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/.pi-web-identity") {
      res.end("OK");
      return;
    }
    const challenge = req.headers["x-pi-web-challenge"];
    const answer = {
      generation,
      proof: createHmac("sha256", credential.token).update(`${challenge}:${generation}`).digest("hex"),
    };
    if (hold) await hold();
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  t.after(async () => {
    await hub.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const exchange = (value: Record<string, unknown>): Promise<any> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(config.socketPath, () =>
        socket.write(`${JSON.stringify({ ...credential, ...value })}\n`),
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(data));
        }
      });
      socket.on("error", reject);
      socket.on("end", () => {
        if (!data) reject(new Error("registry closed without reply"));
      });
    });
  return {
    dir,
    file,
    config,
    credential,
    cliEnvironment: isolatedHubCliEnvironment(dir),
    port,
    exchange,
    get hub() {
      return hub;
    },
    setGeneration: (next: string) => {
      generation = next;
    },
    holdProof: (next?: () => Promise<void>) => {
      hold = next;
    },
    restart: async () => {
      await hub.close();
      hub = await startHub(config, { versions: { source: async () => ({}) } });
    },
    negotiate: () => exchange({ action: "registry_negotiate", protocol, nonce: "1".repeat(32) }),
  };
}

test("bounded negotiation authenticates before naming unsupported and cannot enroll legacy by accident", async (t) => {
  const f = await fixture(t);
  const negotiated = await f.negotiate();
  assert.equal(negotiated.ok, true);
  assert.equal(negotiated.result.protocol, protocol);
  assert.equal(negotiated.result.nonce, "1".repeat(32));
  assert.match(negotiated.result.boot, /^[a-f0-9]{32}$/);
  const bad = await f.exchange({
    action: "registry_negotiate",
    protocol: "future",
    nonce: "1".repeat(32),
    token: "0".repeat(64),
  });
  assert.notEqual(bad.code, "UNSUPPORTED_PROTOCOL");
  const unsupported = await f.exchange({ action: "registry_negotiate", protocol: "future", nonce: "1".repeat(32) });
  assert.equal(unsupported.code, "UNSUPPORTED_PROTOCOL");
  assert.equal(unsupported.legacy, "legacy-v1");
  f.setGeneration("a".repeat(32));
  assert.equal(
    (await f.exchange({ action: "register", protocol, generation: "a".repeat(32), port: f.port })).ok,
    false,
  );
});

test("thousands of bounded rotations compact one run record and never revive discarded URLs", {
  timeout: 60000,
}, async (t) => {
  const f = await fixture(t);
  const negotiation = await f.negotiate();
  assert.equal(negotiation.ok, true, "new Hub must select bounded-v2");
  const { boot } = negotiation.result;
  let slot = "0000000000000000";
  let first = "";
  let last = "";
  for (let i = 0; i < 2000; i++) {
    const request = {
      action: "bounded_issue",
      protocol,
      boot,
      slot,
      request_id: randomBytes(16).toString("hex"),
      port: f.port,
    };
    const issued = await f.exchange(request);
    assert.equal(issued.ok, true);
    if (i === 0)
      assert.deepEqual(await f.exchange(request), issued, "lost issuance reply is idempotent without extending expiry");
    const { generation } = issued.result;
    assert.match(generation, /^b2-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}$/);
    f.setGeneration(generation);
    assert.equal((await f.exchange({ action: "bounded_register", protocol, boot, generation, port: f.port })).ok, true);
    first ||= generation;
    last = generation;
    slot = issued.result.slot;
  }
  assert.equal((await fetch(`${f.hub.url}s/${first}/`)).status, 410);
  assert.equal(
    (await f.exchange({ action: "bounded_register", protocol, boot, generation: first, port: f.port })).ok,
    false,
  );
  assert.equal((await f.exchange({ action: "register", generation: first, port: f.port })).ok, false);
  assert.equal((await f.exchange({ action: "bounded_unregister", protocol, boot, generation: first })).ok, true);
  assert.equal((await fetch(`${f.hub.url}s/${last}/`)).status, 200, "stale unregister cannot clear successor");
  const boundedFiles = readdirSync(path.join(f.config.stateDir, "bounded"));
  const legacyFiles = readdirSync(path.join(f.config.stateDir, "generations"));
  assert.ok(boundedFiles.length + legacyFiles.length <= 2);
  assert.ok(
    boundedFiles.reduce((n, name) => n + readFileSync(path.join(f.config.stateDir, "bounded", name)).length, 0) < 8192,
  );
  await f.exchange({ action: "bounded_unregister", protocol, boot, generation: last });
  assert.equal(
    (await f.exchange({ action: "bounded_register", protocol, boot, generation: last, port: f.port })).ok,
    false,
  );
  await f.restart();
  assert.equal((await fetch(`${f.hub.url}s/${last}/`)).status, 410);
  assert.equal(
    (await f.exchange({ action: "bounded_register", protocol, boot, generation: last, port: f.port })).ok,
    false,
  );
  assert.notEqual((await f.negotiate()).result.boot, boot);
});

test("serving ownership follows canonical state, not a different runtime directory", async (t) => {
  const f = await fixture(t);
  const runtimeDir = path.join(f.dir, "other-runtime");
  let duplicate: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    await assert.rejects(async () => {
      duplicate = await startHub({ ...f.config, runtimeDir, socketPath: path.join(runtimeDir, "registry.sock") });
    });
  } finally {
    await duplicate?.close();
  }
});

test("legacy tombstones survive revocation and block another run's global URL claim", async (t) => {
  const f = await fixture(t);
  const generation = "e".repeat(32);
  f.setGeneration(generation);
  assert.equal((await f.exchange({ action: "register", generation, port: f.port })).ok, true);
  assert.equal((await f.exchange({ action: "unregister", generation })).ok, true);
  revokeSession(f.config, f.credential.run_id);
  const other = issueSession(f.config, path.join(f.dir, "other.json"), { label: "other" });
  assert.equal((await f.exchange({ ...other, action: "register", generation, port: f.port })).ok, false);
  assert.equal(readdirSync(path.join(f.config.stateDir, "generations")).length, 1);
  await f.restart();
  assert.equal(readdirSync(path.join(f.config.stateDir, "generations")).length, 1);
});

test("pending expiry/cancellation and cross-run replay cannot reinstall old bounded authority", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { boot } = (await f.negotiate()).result;
  const request = {
    action: "bounded_issue",
    protocol,
    boot,
    slot: "0000000000000000",
    request_id: "a".repeat(32),
    port: f.port,
  };
  const issued = await f.exchange(request);
  assert.equal(issued.ok, true);
  const generation = issued.result.generation;
  f.setGeneration(generation);
  assert.equal(
    (await f.exchange({ ...request, request_id: "b".repeat(32), slot: issued.result.slot })).code,
    "REGISTRY_BUSY",
  );
  now += 5001;
  assert.equal(
    (await f.exchange({ action: "bounded_register", protocol, boot, generation, port: f.port })).code,
    "ENDED_GENERATION",
  );
  assert.equal((await f.exchange(request)).code, "ISSUANCE_STALE");
  const next = await f.exchange({ ...request, slot: issued.result.slot, request_id: "b".repeat(32) });
  assert.equal(next.ok, true);
  assert.notEqual(next.result.generation, generation);
  await f.exchange({ action: "bounded_unregister", protocol, boot, generation: next.result.generation });
  assert.equal(
    (await f.exchange({ action: "bounded_register", protocol, boot, generation: next.result.generation, port: f.port }))
      .ok,
    false,
  );
  const other = issueSession(f.config, path.join(f.dir, "other.json"), { label: "other" });
  for (const action of ["register", "bounded_register"]) {
    assert.equal(
      (
        await f.exchange({
          ...other,
          action,
          generation,
          port: f.port,
          ...(action.startsWith("bounded") ? { protocol, boot } : {}),
        })
      ).ok,
      false,
    );
  }
});

test("a separate CLI revoke during proof wins before registration memory publication", async (t) => {
  const f = await fixture(t);
  const { boot } = (await f.negotiate()).result;
  const issued = await f.exchange({
    action: "bounded_issue",
    protocol,
    boot,
    slot: "0000000000000000",
    request_id: "a".repeat(32),
    port: f.port,
  });
  const generation = issued.result.generation;
  f.setGeneration(generation);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdProof(async () => {
    entered();
    await held;
  });
  const registration = f.exchange({ action: "bounded_register", protocol, boot, generation, port: f.port });
  await started;
  const revoked = spawnSync(
    process.execPath,
    ["bin/pi-web-hub.mjs", "revoke", "--config", f.file, "--run-id", f.credential.run_id],
    { encoding: "utf8", env: f.cliEnvironment },
  );
  release();
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal((await registration).ok, false);
  assert.equal((await fetch(`${f.hub.url}s/${generation}/`)).status, 410);
  assert.deepEqual((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions, []);
});

test("disconnected registry peers cannot leave an unbounded promise tail behind a held proof", async (t) => {
  const f = await fixture(t);
  const { boot } = (await f.negotiate()).result;
  const issued = await f.exchange({
    action: "bounded_issue",
    protocol,
    boot,
    slot: "0000000000000000",
    request_id: "a".repeat(32),
    port: f.port,
  });
  const generation = issued.result.generation;
  f.setGeneration(generation);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdProof(async () => {
    entered();
    await held;
  });
  const registration = f.exchange({ action: "bounded_register", protocol, boot, generation, port: f.port });
  await started;
  try {
    for (let i = 0; i < 31; i++) {
      const socket = net.createConnection(f.config.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
      });
      socket.write(
        `${JSON.stringify({ action: "registry_negotiate", protocol, nonce: "1".repeat(32), ...f.credential })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
      socket.destroy();
    }
    const overflow = await f.negotiate();
    assert.equal(overflow.code, "HUB_BUSY");
  } finally {
    release();
    await registration;
  }
});

test("concurrent backend proof admission is bounded and overload does not retire a live route", async (t) => {
  const f = await fixture(t);
  const generation = "c".repeat(32);
  f.setGeneration(generation);
  assert.equal((await f.exchange({ action: "register", generation, port: f.port })).ok, true);
  let count = 0;
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdProof(async () => {
    if (++count === 4) started();
    await held;
  });
  const requests = Array.from({ length: 4 }, () => fetch(`${f.hub.url}s/${generation}/`));
  try {
    await entered;
    assert.equal((await fetch(`${f.hub.url}s/${generation}/`)).status, 503);
  } finally {
    release();
  }
  for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
  assert.equal((await fetch(`${f.hub.url}s/${generation}/`)).status, 200);
});

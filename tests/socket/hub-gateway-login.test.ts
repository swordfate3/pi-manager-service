import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readHubConfig } from "../../hub/config.ts";
import { revokeManagement } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

const proof = "a".repeat(64);
const gateToken = "b".repeat(64);
const id = "c".repeat(32);

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-gateway-"));
  const credentialFile = path.join(dir, "gateway.json");
  const requestFile = path.join(dir, "request.json");
  writeFileSync(credentialFile, JSON.stringify({ token: proof }), { mode: 0o600 });
  writeFileSync(requestFile, JSON.stringify({ token: gateToken }), { mode: 0o600 });
  let posts = 0;
  const gate = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${gateToken}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "POST") {
      posts++;
      assert.equal(req.url, "/v1/runtime-updates");
      assert.deepEqual(JSON.parse(raw), { version: "1.3.0", idempotency_key: id });
      res
        .writeHead(202)
        .end(JSON.stringify({ id, version: "1.3.0", status: "pending", stage: "awaiting_approval", targets: [] }));
    } else res.end(JSON.stringify({ policy: { mode: "manual" }, jobs: [], active: [] }));
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      port: 0,
      management: { port: 0, gateway: { credentialFile } },
      runtimeUpdates: {
        endpoint: `http://127.0.0.1:${(gate.address() as AddressInfo).port}`,
        credentialFile: requestFile,
      },
    }),
    { mode: 0o600 },
  );
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  t.after(async () => {
    await hub?.close();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const config = readHubConfig(file);
  hub = await startHub(config);
  assert.ok(hub.managementUrl);
  const origin = new URL(hub.managementUrl).origin;
  let cookie = "";
  let csrf = "";
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/management/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Pi-Hub-Gateway": proof,
        "X-Pi-Hub-User": "owner",
        Cookie: cookie,
        "X-Pi-Hub-Csrf": csrf,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async () => {
    const result = await request("gateway", {});
    assert.equal(result.status, 200);
    const setCookie = result.headers.get("set-cookie");
    assert.ok(setCookie);
    cookie = setCookie.split(";")[0];
    const value = await result.json();
    assert.equal(value.authorized, true);
    csrf = value.csrf;
    assert.equal(csrf.length, 64);
    return result;
  };
  return { hub, config, credentialFile, request, login, posts: () => posts };
}

test("gateway login bootstraps without a pairing code and submits only a manual Gate request", async (t) => {
  const f = await fixture(t);
  const status = await (await f.request("status")).json();
  assert.equal(status.authMode, "gateway");
  assert.equal(status.authorized, false);
  const login = await f.login();
  assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
  const response = await f.request("runtime-updates", { version: "1.3.0", idempotencyKey: id });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).stage, "awaiting_approval");
  assert.equal(f.posts(), 1);
  assert.equal((await f.request("unlock", { code: "d".repeat(32) })).status, 404);
});

test("gateway rejects missing/wrong proof or identity even for existing browser sessions", async (t) => {
  const f = await fixture(t);
  const invalidHeaders: Record<string, string>[] = [
    { "X-Pi-Hub-Gateway": "" },
    { "X-Pi-Hub-Gateway": "d".repeat(64) },
    { "X-Pi-Hub-User": "" },
    { "X-Pi-Hub-User": "owner,attacker" },
  ];
  for (const headers of invalidHeaders) {
    assert.equal((await f.request("status", undefined, headers)).status, 401);
    assert.equal((await f.request("gateway", {}, headers)).status, 401);
  }
  assert.equal((await fetch(`${f.hub.managementUrl}sessions/`)).status, 401);
  await f.login();
  assert.equal((await f.request("runtime-updates", undefined, { "X-Pi-Hub-Gateway": "" })).status, 401);
  assert.equal((await f.request("runtime-updates", undefined, { "X-Pi-Hub-User": "other-user" })).status, 401);
  assert.equal(f.posts(), 0);
});

test("gateway bootstrap and update writes enforce exact Origin, bounded body and CSRF", async (t) => {
  const f = await fixture(t);
  for (const Origin of ["", "https://evil.example", new URL(f.hub.url).origin]) {
    assert.equal((await f.request("gateway", {}, { Origin })).status, 403);
  }
  assert.equal((await f.request("gateway", { unexpected: "data" })).status, 400);
  await f.login();
  const invalidWrites: Record<string, string>[] = [{ "X-Pi-Hub-Csrf": "" }, { Origin: new URL(f.hub.url).origin }];
  for (const headers of invalidWrites) {
    assert.ok(
      [401, 403].includes(
        (await f.request("runtime-updates", { version: "1.3.0", idempotencyKey: id }, headers)).status,
      ),
    );
  }
  assert.equal((await fetch(`${f.hub.url}api/management/gateway`, { method: "POST" })).status, 404);
  assert.equal(f.posts(), 0);
});

test("gateway logout and administrator revocation invalidate browser authority", async (t) => {
  const f = await fixture(t);
  await f.login();
  assert.equal((await f.request("logout", {})).status, 200);
  assert.equal((await f.request("runtime-updates")).status, 401);
  await f.login();
  revokeManagement(f.config);
  assert.equal((await f.request("runtime-updates")).status, 401);
});

test("gateway proof rotation and unsafe credential permissions fail closed", async (t) => {
  const f = await fixture(t);
  await f.login();
  writeFileSync(f.credentialFile, JSON.stringify({ token: "e".repeat(64) }));
  assert.equal((await f.request("runtime-updates")).status, 401);
  // A changed gateway credential must not resurrect cookies minted under the old credential.
  assert.equal((await f.request("runtime-updates", undefined, { "X-Pi-Hub-Gateway": "e".repeat(64) })).status, 401);
  chmodSync(f.credentialFile, 0o644);
  assert.equal((await f.request("status", undefined, { "X-Pi-Hub-Gateway": "e".repeat(64) })).status, 401);
});

test("gateway configuration rejects arbitrary paths and unexpected authority options", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-gateway-config-"));
  try {
    const file = path.join(dir, "config.json");
    for (const gateway of [
      { credentialFile: "relative.json" },
      { credentialFile: "/tmp/x\u0000.json" },
      { credentialFile: "/tmp/x", trustHeader: true },
      {},
      true,
    ]) {
      writeFileSync(file, JSON.stringify({ port: 0, management: { port: 0, gateway } }), { mode: 0o600 });
      assert.throws(() => readHubConfig(file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

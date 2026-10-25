import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, readHubConfig } from "../../hub/config.ts";
import { issueManagementCode } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

async function fixture(t: test.TestContext, management: unknown = { port: 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, ...(management ? { management } : {}) } as any);
  const config = readHubConfig(file);
  const hub = await startHub(config);
  t.after(() => hub.close());
  return { hub, config };
}

test("management lives on a separate listener; chat has no pairing or authority", async (t) => {
  const { hub, config } = await fixture(t);
  assert.ok(hub.managementUrl, "separate listener URL must be exposed");
  assert.notEqual(new URL(hub.managementUrl).origin, new URL(hub.url).origin);
  const status = await (await fetch(`${hub.url}api/management/status`)).json();
  assert.deepEqual(status, { available: false, authorized: false, managementUrl: hub.managementUrl });
  const chat = await (await fetch(`${hub.url}sessions/`)).text();
  assert.ok(chat.includes("打开运行管理"));
  assert.ok(!chat.includes('id="management-unlock"'));
  const code = issueManagementCode(config).code;
  const payload = {
    method: "POST",
    headers: { Origin: new URL(hub.url).origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  };
  assert.equal((await fetch(`${hub.url}api/management/unlock`, payload)).status, 404);
  assert.equal((await fetch(`${hub.managementUrl}api/management/unlock`, payload)).status, 403);
  payload.headers.Origin = new URL(hub.managementUrl).origin;
  const unlock = await fetch(`${hub.managementUrl}api/management/unlock`, payload);
  assert.equal(unlock.status, 200);
  assert.ok(unlock.headers.get("set-cookie")?.includes("HttpOnly"));
  for (const route of ["s/" + "a".repeat(32) + "/", "sw.js", "api/files", "redirect?url=https://evil.invalid", "ws"]) {
    assert.equal((await fetch(hub.managementUrl + route)).status, 404, route);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    http
      .get(hub.managementUrl!, { headers: { Host: new URL(hub.url).host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(hostStatus, 403);
});

test("no management configuration means no authority or listener", async (t) => {
  const { hub } = await fixture(t, null);
  assert.equal(hub.managementUrl, undefined);
  assert.deepEqual(await (await fetch(`${hub.url}api/management/status`)).json(), {
    available: false,
    authorized: false,
  });
  assert.equal((await fetch(`${hub.url}api/management/unlock`, { method: "POST" })).status, 404);
});

test("management configuration rejects shared origins, ports, unknown keys and missing canonical chat URL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-config-origin-"));
  try {
    const file = path.join(dir, "hub.json");
    for (const management of [
      { port: 16180 },
      { port: -1 },
      { port: 0, host: "0.0.0.0" },
      { port: 0, publicUrl: "https://admin.example/" },
    ]) {
      writeFileSync(file, JSON.stringify({ port: 16180, management }), { mode: 0o600 });
      assert.throws(() => readHubConfig(file));
    }
    writeFileSync(
      file,
      JSON.stringify({
        publicUrl: "https://chat.example/",
        management: { port: 0, publicUrl: "https://chat.example/" },
      }),
      { mode: 0o600 },
    );
    assert.throws(() => readHubConfig(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

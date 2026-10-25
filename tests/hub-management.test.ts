import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { HubManagement, issueManagementCode, revokeManagement } from "../hub/management.ts";

function fixture(t: test.TestContext, now?: () => number) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-management-"));
  const file = path.join(dir, "config.json");
  initializeHub(file, {
    port: 0,
    publicUrl: "https://hub.example/",
    management: { port: 0, publicUrl: "https://admin.example/" },
  });
  const config = readHubConfig(file);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, config, management: new HubManagement(config, now) };
}
const request = (cookie = "", csrf?: string) =>
  ({ headers: { cookie, ...(csrf ? { "x-pi-hub-csrf": csrf } : {}) } }) as IncomingMessage;

test("management unlock consumes pairing once and requires both cookie and CSRF for writes", (t) => {
  const f = fixture(t);
  assert.equal(f.management.status(request()).authorized, false);
  const { code } = issueManagementCode(f.config);
  const unlocked = f.management.unlock(code);
  assert.match(unlocked.cookie, /HttpOnly/);
  assert.match(unlocked.cookie, /SameSite=Strict/);
  assert.match(unlocked.cookie, /Secure/);
  const cookie = unlocked.cookie.split(";")[0];
  assert.equal(f.management.status(request(cookie)).authorized, true);
  assert.throws(() => f.management.authorize(request(cookie), true));
  assert.throws(() => f.management.authorize(request(cookie, "wrong"), true));
  assert.doesNotThrow(() => f.management.authorize(request(cookie, unlocked.csrf), true));
  assert.throws(() => f.management.unlock(code));
  assert.ok(!readFileSync(path.join(f.config.stateDir, "management.json"), "utf8").includes(code));
  assert.ok(!JSON.stringify(f.management.status(request())).includes(code));
});

test("pairing expires and repeated wrong codes lock that pairing", (t) => {
  let now = Date.now();
  const f = fixture(t, () => now);
  const { code } = issueManagementCode(f.config, now);
  now += 600_001;
  assert.throws(() => f.management.unlock(code));
  const second = issueManagementCode(f.config, now);
  for (let i = 0; i < 10; i++) assert.throws(() => f.management.unlock("0".repeat(32)));
  assert.throws(() => f.management.unlock(second.code));
});

test("logout, administrator revocation, expiry and a Hub restart invalidate management sessions", (t) => {
  let now = Date.now();
  const f = fixture(t, () => now);
  const login = () => {
    const { code } = issueManagementCode(f.config, now);
    const value = f.management.unlock(code);
    return { ...value, request: request(value.cookie.split(";")[0], value.csrf) };
  };
  const a = login();
  f.management.logout(a.request);
  assert.equal(f.management.status(a.request).authorized, false);
  const b = login();
  revokeManagement(f.config);
  assert.equal(f.management.status(b.request).authorized, false);
  const c = login();
  assert.equal(new HubManagement(f.config).status(c.request).authorized, false);
  now += 30 * 60_000 + 1;
  assert.equal(f.management.status(c.request).authorized, false);
});

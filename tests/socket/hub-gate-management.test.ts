import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeHub, readHubConfig } from "../../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

const task = {
  kind: "runtime",
  id: "a".repeat(32),
  revision: "b".repeat(64),
  status: "pending",
  stage: "awaiting_approval",
  title: "更新 Pi",
  target: "pi-runtime",
  version: "1.4.0",
  actions: ["approve", "reject"],
};
const decision = {
  kind: task.kind,
  id: task.id,
  revision: task.revision,
  action: "approve",
  decision_id: "c".repeat(32),
};

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-gate-management-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = "d".repeat(64);
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let respond: (() => void) | undefined;
  let payload: unknown = { tasks: [task], policies: [] };
  let status = 200;
  const gate = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    assert.ok(request.method && request.url);
    calls.push({ method: request.method, path: request.url, ...(raw ? { body: JSON.parse(raw) } : {}) });
    respond?.();
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    gate.closeAllConnections();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
  });
  const credentialFile = path.join(dir, "gate.json");
  writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 } });
  const config = readHubConfig(file);
  Object.assign(config, {
    gateManagement: { endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`, credentialFile },
  });
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  t.after(() => hub.close());
  assert.ok(hub.managementUrl);
  const origin = new URL(hub.managementUrl).origin;
  const unlock = await fetch(`${origin}/api/management/unlock`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueManagementCode(config).code }),
  });
  assert.equal(unlock.status, 200);
  const cookieHeader = unlock.headers.get("set-cookie");
  assert.ok(cookieHeader);
  const cookie = cookieHeader.split(";")[0];
  const csrf = (await unlock.json()).csrf;
  const headers = { Cookie: cookie, Origin: origin, "X-Pi-Hub-Csrf": csrf, "Content-Type": "application/json" };
  const request = (route = "", value?: unknown, extra = {}) =>
    fetch(`${origin}/api/management/gate${route}`, {
      method: value === undefined ? "GET" : "POST",
      headers: { ...headers, ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  return {
    hub,
    origin,
    config,
    headers,
    request,
    calls,
    reply: (value: unknown, code = 200) => {
      payload = value;
      status = code;
    },
    beforeReply: (fn: () => void) => {
      respond = fn;
    },
  };
}

test("trusted Hub manages Gate while chat and unauthenticated clients cannot access it", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/api/management/gate`)).status, 401);
  assert.equal((await fetch(`${f.hub.url}api/management/gate`)).status, 404);
  assert.equal(f.calls.length, 0);
  const status = await f.request();
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { tasks: [task], policies: [] });
  assert.equal(f.calls[0].path, "/v1/hub-management");
  const capability = await (await fetch(`${f.origin}/api/management/status`, { headers: f.headers })).json();
  assert.equal(capability.gateManagementAvailable, true);
});

test("reviewed decision forwards once and bad CSRF, Origin or exact body never reaches Gate", async (t) => {
  const f = await fixture(t);
  f.reply({ decision_id: decision.decision_id, status: "recorded", task: { ...task, status: "queued", actions: [] } });
  assert.equal((await f.request("/decisions", decision, { "X-Pi-Hub-Csrf": "0".repeat(64) })).status, 401);
  assert.equal((await f.request("/decisions", decision, { Origin: "https://wrong.invalid" })).status, 403);
  assert.equal((await f.request("/decisions", { ...decision, command: "arbitrary" })).status, 400);
  assert.equal((await f.request("/decisions", { ...decision, revision: "old" })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request("/decisions", decision)).status, 200);
  assert.deepEqual(f.calls, [{ method: "POST", path: "/v1/hub-management/decisions", body: decision }]);
});

test("Gate failures are bounded and decisions are never automatically retried", async (t) => {
  const f = await fixture(t);
  f.reply({ error: "PRIVATE-CREDENTIAL-IN-UPSTREAM-ERROR" }, 409);
  const response = await f.request("/decisions", decision);
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes("PRIVATE-CREDENTIAL"));
  assert.equal(f.calls.length, 1);
  f.reply({ tasks: [{ ...task, token: "DO-NOT-FORWARD" }], policies: [] });
  const data = await f.request();
  assert.ok(!(await data.text()).includes("DO-NOT-FORWARD"));
});

test("a valid long pinned image identity stays visible in the reviewed task", async (t) => {
  const f = await fixture(t);
  const image = `registry.example/${"a".repeat(220)}@sha256:${"b".repeat(64)}`;
  f.reply({ tasks: [{ ...task, kind: "deployment", image }], policies: [] });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tasks[0].image, image);
});

test("revoked management during a provider response cannot disclose task data", async (t) => {
  const f = await fixture(t);
  f.beforeReply(() => revokeManagement(f.config));
  const response = await f.request();
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes(task.title));
});

test("only exact management paths and bounded fixed policy/resume operations are exposed", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["/", "?token=x", "/admin/approve", `/tasks/runtime/${task.id}/extra`]) {
    assert.equal((await f.request(suffix)).status, 404);
  }
  f.reply(task);
  assert.equal((await f.request(`/tasks/runtime/${task.id}`)).status, 200);
  f.reply({ decision_id: decision.decision_id, status: "recorded" });
  const policy = {
    kind: "runtime",
    id: "pi-runtime",
    revision: task.revision,
    mode: "manual",
    decision_id: decision.decision_id,
  };
  assert.equal((await f.request("/policies", { ...policy, images: ["untrusted"] })).status, 400);
  assert.equal((await f.request("/policies", policy)).status, 200);
  assert.equal(
    (await f.request("/resume", { id: "pi-web-hub", revision: task.revision, decision_id: decision.decision_id }))
      .status,
    200,
  );
});

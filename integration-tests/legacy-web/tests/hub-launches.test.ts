import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

const configReply = {
  enabled: true,
  rootLabel: "gitproject",
  defaultPath: "pi_projects",
  revision: "a".repeat(64),
  maxActive: 16,
};
const browseReply = {
  path: "pi_projects",
  parent: "",
  revision: "b".repeat(64),
  entries: [{ name: "项目 A", path: "pi_projects/项目 A" }],
  truncated: false,
};
const launch = {
  id: "c".repeat(32),
  path: "pi_projects",
  label: "项目",
  policy_revision: configReply.revision,
  workspace_revision: browseReply.revision,
};
const job = {
  id: launch.id,
  path: launch.path,
  label: launch.label,
  status: "queued",
  stage: "accepted",
  created_at: 1000,
  updated_at: 1000,
};

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-launch-http-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let value: unknown = configReply;
  let code = 200;
  let beforeReply: (() => void) | undefined;
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const gate = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${"d".repeat(64)}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ url: request.url ?? "", method: request.method ?? "", ...(raw ? { body: JSON.parse(raw) } : {}) });
    beforeReply?.();
    response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    gate.closeAllConnections();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
  });
  const file = path.join(directory, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 } });
  const credentialFile = path.join(directory, "gate.json");
  writeFileSync(credentialFile, JSON.stringify({ token: "d".repeat(64) }), { mode: 0o600 });
  const config = readHubConfig(file);
  config.gateManagement = { endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`, credentialFile };
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  t.after(() => hub.close());
  assert.ok(hub.managementUrl);
  const origin = new URL(hub.managementUrl).origin;
  const unlocked = await fetch(`${origin}/api/management/unlock`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueManagementCode(config).code }),
  });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = {
    Cookie: cookie,
    Origin: origin,
    "X-Pi-Hub-Csrf": (await unlocked.json()).csrf,
    "Content-Type": "application/json",
  };
  return {
    hub,
    origin,
    calls,
    config,
    directory,
    reply(payload: unknown, status = 200) {
      value = payload;
      code = status;
    },
    before(fn: () => void) {
      beforeReply = fn;
    },
    request(route: string, body?: unknown, extra = {}) {
      return fetch(`${origin}/api/management/gate/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

test("trusted management browses bounded root-relative directories while chat cannot", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("launch-config")).status, 200);
  f.reply(browseReply);
  const response = await f.request("workspaces?path=pi_projects");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), browseReply);
  assert.equal(f.calls[1].url, "/v1/hub-management/workspaces?path=pi_projects");
  assert.equal((await fetch(`${f.hub.url}api/management/gate/workspaces?path=pi_projects`)).status, 404);
  assert.equal((await fetch(`${f.origin}/api/management/gate/workspaces?path=pi_projects`)).status, 401);
  assert.equal(f.calls.length, 2);
});

test("launch is forwarded once with reviewed identities and exact trusted body only", async (t) => {
  const f = await fixture(t);
  f.reply(job);
  assert.equal((await f.request("launches", launch, { "X-Pi-Hub-Csrf": "wrong" })).status, 401);
  assert.equal((await f.request("launches", { ...launch, image: "anything" })).status, 400);
  assert.equal((await f.request("launches", { ...launch, path: "../outside" })).status, 400);
  assert.equal((await f.request("launches", { ...launch, policy_revision: "changed" })).status, 400);
  assert.equal(f.calls.length, 0);
  const response = await f.request("launches", launch);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), job);
  assert.deepEqual(f.calls, [{ method: "POST", url: "/v1/hub-management/launches", body: launch }]);
});

test("invalid directory queries and upstream traversal do not reach or escape the proxy", async (t) => {
  const f = await fixture(t);
  for (const query of [
    "path=../outside",
    "path=%2Fhome",
    "path=a%5Cb",
    "path=a//b",
    "path=a&path=b",
    "command=ls",
    "cursor=../bad",
    "path=.%2Fproject",
  ]) {
    assert.equal((await f.request(`workspaces?${query}`)).status, 400, query);
  }
  assert.equal(f.calls.length, 0);
  f.reply({ ...browseReply, entries: [{ name: "escape", path: "../outside" }] });
  assert.equal((await f.request("workspaces?path=pi_projects")).status, 503);
  f.reply({ ...browseReply, entries: [{ name: "sibling", path: "other/sibling" }] });
  assert.equal((await f.request("workspaces?path=pi_projects")).status, 503);
});

test("upstream cannot supply a session URL or secrets and unknown launch writes are not retried", async (t) => {
  const f = await fixture(t);
  f.reply({ ...job, run_id: "e".repeat(32), sessionUrl: "https://evil.invalid/", token: "PRIVATE-NOT-FORWARDED" });
  const response = await f.request(`launches/${job.id}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessionUrl, undefined);
  assert.equal(body.token, undefined);
  f.reply({ error: "PRIVATE-UPSTREAM-ERROR" }, 500);
  const failed = await f.request("launches", launch);
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("PRIVATE-UPSTREAM"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("revocation after upstream launch response hides private paths and job metadata", async (t) => {
  const f = await fixture(t);
  f.reply({ jobs: [job] });
  f.before(() => revokeManagement(f.config));
  const response = await f.request("launches");
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("pi_projects"));
});

test("launch list and create responses cannot exchange shapes or exceed public bounds", async (t) => {
  const f = await fixture(t);
  f.reply(job);
  assert.equal((await f.request("launches")).status, 503);
  f.reply({ jobs: [job] });
  assert.equal((await f.request("launches", launch)).status, 503);
  f.reply({ jobs: Array.from({ length: 257 }, () => job) });
  assert.equal((await f.request("launches")).status, 503);
  f.reply({ ...configReply, private: "x".repeat(1024 * 1024) });
  assert.equal((await f.request("launch-config")).status, 503);
  f.reply({ ...configReply, enabled: false });
  assert.equal((await (await f.request("launch-config")).json()).enabled, false);
});

test("directory cursors must advance monotonically through bounded ordered entries", async (t) => {
  const f = await fixture(t);
  const entries = [
    { name: "b", path: "pi_projects/b" },
    { name: "c", path: "pi_projects/c" },
  ];
  f.reply({ ...browseReply, entries, truncated: true, nextCursor: "c" });
  assert.equal((await f.request("workspaces?path=pi_projects&cursor=a")).status, 200);
  for (const patch of [
    { nextCursor: "a" },
    { nextCursor: "b" },
    { entries: [...entries].reverse() },
    { entries: [], nextCursor: "c" },
  ]) {
    f.reply({ ...browseReply, entries, truncated: true, nextCursor: "c", ...patch });
    assert.equal((await f.request("workspaces?path=pi_projects&cursor=a")).status, 503);
  }
});

test("launch links come only from exact live Hub registration and disappear on revocation", async (t) => {
  const f = await fixture(t);
  const credentialFile = path.join(f.directory, "run.json");
  const credential = issueSession(f.config, credentialFile, { label: "launch fixture" });
  const registration = createSessionRegistration({ socketPath: f.hub.socketPath, credentialFile });
  const backend = http.createServer((request, response) => {
    if (registration.guard(request, response)) response.end("isolated backend");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await registration.stop();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  let link = "";
  await registration.start((backend.address() as net.AddressInfo).port, (value) => {
    link = value ?? "";
  });
  assert.ok(link);
  f.reply({
    ...job,
    status: "running",
    stage: "running",
    run_id: credential.run_id,
    sessionUrl: "https://evil.invalid/",
  });
  assert.equal((await (await f.request(`launches/${job.id}`)).json()).sessionUrl, link);
  f.reply({ ...job, status: "running", stage: "running", run_id: "f".repeat(32) });
  assert.equal((await (await f.request(`launches/${job.id}`)).json()).sessionUrl, undefined);
  revokeSession(f.config, credential.run_id);
  f.reply({ ...job, status: "running", stage: "running", run_id: credential.run_id });
  assert.equal((await (await f.request(`launches/${job.id}`)).json()).sessionUrl, undefined);
});

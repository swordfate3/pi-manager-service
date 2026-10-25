import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { InteractionBroker } from "../extensions/interactions/broker.ts";
import { createInteractionControlServer } from "../extensions/interactions/control.ts";
import { createSessionRegistration, guardSessionRequest } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import type { InteractionTarget } from "../hub/interaction-control.ts";
import { interactionSigning } from "../hub/interaction-signing.ts";
import { createInteractionApi } from "../hub/interactions.ts";
import { HubManagement, issueManagementCode, revokeManagement } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-interactions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 } });
  const config = readHubConfig(file);
  const credentialFile = path.join(dir, "run.json");
  const credential = issueSession(config, credentialFile, { label: "isolated source" });
  const registration = createSessionRegistration({ credentialFile, socketPath: config.socketPath });
  const broker = new InteractionBroker({ runId: credential.run_id, generation: "a".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" }, { pin: registration.interactionPin, onChange: () => control.notify() });
  const control = createInteractionControlServer({ broker: () => broker, authorize: (request) => typeof request.headers["x-pi-web-proof"] === "string" && guardSessionRequest(registration, request) });
  let beforeProof: (() => void | Promise<void>) | undefined;
  const sourceServer = http.createServer(async (request, response) => {
    if (request.headers["x-pi-web-challenge"]) await beforeProof?.();
    if (guardSessionRequest(registration, request, response)) response.writeHead(404).end();
  });
  sourceServer.on("upgrade", (request, socket, head) => { if (!control.upgrade(request, socket, head)) socket.destroy(); });
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  let generation = "";
  await registration.start((sourceServer.address() as net.AddressInfo).port, (url) => {
    if (!url) return;
    generation = new URL(url).pathname.split("/")[2];
    broker.replaceIdentity({ runId: credential.run_id, generation, runtimeId: "runtime-1", sessionId: "session-1" });
  }, () => "isolated", () => ({ runtimeId: "runtime-1", sessionId: "session-1", leafId: null, version: "1.1.0", managed: true }));
  assert.ok(generation);
  t.after(async () => { control.close(); broker.close(); await registration.stop(); await hub.close(); await new Promise<void>((resolve) => sourceServer.close(() => resolve())); });
  const adapter = broker.registerAdapter({ id: "memory", version: "1", packageName: "memory", actions: { write: { method: "confirm", classification: "sensitive" } } });
  const source = () => adapter.request({ action: "write", revision: "prepared-1", classification: "sensitive", method: "confirm", schema: { kind: "confirm" }, content: { preview: "PRIVATE-MEMORY-CONTENT" }, deadline: Date.now() + 20_000 }, { isCurrent: () => true });
  const unlock = await fetch(`${hub.managementUrl}api/management/unlock`, { method: "POST", headers: { Origin: new URL(hub.managementUrl!).origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: issueManagementCode(config).code }) });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get("set-cookie")!.split(";")[0];
  const csrf = (await unlock.json()).csrf;
  const headers = { Cookie: cookie, Origin: new URL(hub.managementUrl!).origin, "x-pi-hub-csrf": csrf, "Content-Type": "application/json" };
  const route = (requestId: string) => `${hub.managementUrl}api/management/interactions/${generation}/${requestId}`;
  return { hub, broker, config, source, headers, route, generation, beforeProof: (callback: () => void | Promise<void>) => { beforeProof = callback; } };
}

test("trusted review shares existing management session; chat, missing auth and wrong CSRF cannot approve", async (t) => {
  const f = await fixture(t);
  const source = f.source();
  const route = f.route(source.request.requestId);
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(`${f.hub.url}api/management/interactions/${f.generation}/${source.request.requestId}`, { headers: f.headers })).status, 403);
  const read = await fetch(route, { headers: f.headers });
  assert.equal(read.status, 200);
  const request = await read.json();
  assert.equal(request.content.preview, "PRIVATE-MEMORY-CONTENT");
  const decision = { decisionId: "a".repeat(32), digest: request.digest, revision: request.revision, answer: true };
  assert.equal((await fetch(route, { method: "POST", headers: { ...f.headers, "x-pi-hub-csrf": "0".repeat(64) }, body: JSON.stringify(decision) })).status, 401);
  assert.equal(f.broker.pending().length, 1);
  const allow = await fetch(route, { method: "POST", headers: f.headers, body: JSON.stringify(decision) });
  assert.equal(allow.status, 200);
  assert.equal((await allow.json()).state, "allowed");
  assert.equal((await source.result).winner, "web");
  const duplicate = await fetch(route, { method: "POST", headers: f.headers, body: JSON.stringify(decision) });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).state, "allowed");
  const receipt = await fetch(route, { headers: f.headers });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { state: "allowed" });
});

test("changed preview binding and revoked management authority cause no source mutation", async (t) => {
  const f = await fixture(t);
  const source = f.source();
  const route = f.route(source.request.requestId);
  assert.equal((await fetch(route, { headers: f.headers })).status, 200);
  const body = { decisionId: "b".repeat(32), digest: "f".repeat(64), revision: source.request.revision, answer: true };
  assert.equal((await fetch(route, { method: "POST", headers: f.headers, body: JSON.stringify(body) })).status, 409);
  assert.equal(f.broker.pending().length, 1);
  revokeManagement(f.config);
  assert.equal((await fetch(route, { method: "POST", headers: f.headers, body: JSON.stringify({ ...body, digest: source.request.digest }) })).status, 401);
  source.cancel();
  assert.equal((await source.result).state, "cancelled");
});

test("review shell and assets exist only on management origin and deny frames and service workers", async (t) => {
  const f = await fixture(t);
  const page = `interactions/${f.generation}/${"a".repeat(32)}/`;
  const privateResponse = await fetch(`${f.hub.managementUrl}${page}`);
  assert.equal(privateResponse.status, 200);
  assert.match(privateResponse.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(await privateResponse.text(), /review-preview/);
  for (const route of [page, "interaction-page.js", "interaction-page.css"]) {
    assert.equal((await fetch(`${f.hub.managementUrl}${route}`)).status, 200);
    assert.equal((await fetch(`${f.hub.url}${route}`)).status, 404);
  }
  assert.equal((await fetch(`${f.hub.managementUrl}interaction-page.js`, { headers: { "service-worker": "script" } })).status, 404);
});

test("management revoked while backend identity proof is in flight cannot receive a private preview", async (t) => {
  const f = await fixture(t);
  const source = f.source();
  f.beforeProof(() => revokeManagement(f.config));
  const response = await fetch(f.route(source.request.requestId), { headers: f.headers });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("PRIVATE-MEMORY-CONTENT"));
  assert.equal(f.broker.pending().length, 1);
  source.cancel();
  assert.equal((await source.result).state, "cancelled");
});

test("trusted inbox discovers live extension requests without private preview or chat access", async (t) => {
  const f = await fixture(t);
  const source = f.source();
  const inbox = `${f.hub.managementUrl}api/management/interactions`;
  assert.equal((await fetch(inbox)).status, 401);
  assert.equal((await fetch(`${f.hub.url}api/management/interactions`)).status, 404);
  const response = await fetch(inbox, { headers: f.headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.unavailable, 0);
  assert.equal(data.truncated, false);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].requestId, source.request.requestId);
  assert.equal(data.items[0].path, `/interactions/${f.generation}/${source.request.requestId}/`);
  assert.ok(!JSON.stringify(data).includes("PRIVATE-MEMORY-CONTENT"));
  source.cancel();
  assert.equal((await source.result).state, "cancelled");
  assert.equal((await (await fetch(inbox, { headers: f.headers })).json()).items.length, 0);
});

test("inbox admits one bounded enumeration and rejects concurrent scans without extra source work", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let proofs = 0;
  f.beforeProof(async () => { proofs++; entered(); await blocked; });
  const inbox = `${f.hub.managementUrl}api/management/interactions`;
  const first = fetch(inbox, { headers: f.headers });
  await started;
  try {
    const second = await fetch(inbox, { headers: f.headers });
    assert.equal(second.status, 503);
    assert.equal(proofs, 1);
  } finally { release(); await first; }
});

for (const change of ["retired", "replaced", "expired"] as const) {
  test(`inbox removes source A ${change} after collection while real source B is deferred`, { timeout: 10_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-inbox-race-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.json");
    initializeHub(file, { port: 0, management: { port: 0 } });
    const config = readHubConfig(file);
    const signing = interactionSigning(config);
    const management = new HubManagement(config);
    const session = management.unlock(issueManagementCode(config).code);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let collected!: () => void;
    let release!: () => void;
    const sourceACollected = new Promise<void>((resolve) => { collected = resolve; });
    const sourceBDeferred = new Promise<void>((resolve) => { release = resolve; });
    t.after(release);
    let sourceAStatusReturned = false;
    const revalidate = management.revalidate.bind(management);
    t.mock.method(management, "revalidate", (...args: Parameters<HubManagement["revalidate"]>) => {
      revalidate(...args);
      // This real authorization check follows A's real status response. Its
      // worker finishes collecting synchronously before this waiter resumes.
      if (sourceAStatusReturned) collected();
    });
    const sources = [];
    for (const generation of ["a".repeat(32), "b".repeat(32)]) {
      const identity = { runId: generation, generation, runtimeId: "runtime-1", sessionId: "session-1" };
      const token = "c".repeat(64);
      const broker = new InteractionBroker(identity, { pin: signing.pin, now: () => now });
      const control = createInteractionControlServer({ broker: () => broker, authorize: (request) => request.headers["x-pi-web-proof"] === createHmac("sha256", token).update(generation).digest("hex") });
      const server = http.createServer((_request, response) => response.writeHead(404).end());
      server.on("upgrade", (request, socket, head) => { if (!control.upgrade(request, socket, head)) socket.destroy(); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => { control.close(); broker.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
      const target: InteractionTarget = { identity, backendHost: "127.0.0.1", port: (server.address() as net.AddressInfo).port, token };
      const adapter = broker.registerAdapter({ id: "memory", version: "1", packageName: "memory", actions: { write: { method: "confirm", classification: "sensitive" } } });
      const source = adapter.request({ action: "write", revision: "prepared-1", classification: "sensitive", method: "confirm", schema: { kind: "confirm" }, content: { preview: "PRIVATE-RACE-CONTENT" }, deadline: now + (sources.length ? 20_000 : 2000) }, { isCurrent: () => true });
      if (!sources.length) {
        const pending = broker.pending.bind(broker);
        let reads = 0;
        t.mock.method(broker, "pending", () => {
          const metadata = pending();
          // First read is the channel's initial notice; second is status RPC.
          if (++reads === 2) sourceAStatusReturned = true;
          return metadata;
        });
      }
      sources.push({ target, source });
    }
    const [a, b] = sources;
    const current = new Map(sources.map(({ target }) => [target.identity.generation, target]));
    const api = createInteractionApi(config, management, {
      generations: () => [...current.keys()],
      lookup: async (generation) => {
        if (generation === b.target.identity.generation) await sourceBDeferred;
        return current.get(generation);
      },
      current: (target) => current.get(target.identity.generation) === target,
    });
    const server = http.createServer((request, response) => { void api.handle(request, response, true); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { api.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const response = fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/management/interactions`, { headers: { Cookie: session.cookie.split(";")[0] } });
    await sourceACollected;
    if (change === "retired") api.retire(a.target.identity.generation);
    if (change === "replaced") current.set(a.target.identity.generation, { ...a.target, identity: { ...a.target.identity, sessionId: "session-2" } });
    if (change === "expired") now = a.source.request.deadline;
    release();
    const reply = await response;
    assert.equal(reply.status, 200);
    const data = await reply.json();
    assert.deepEqual(data.items.map((item: { requestId: string }) => item.requestId), [b.source.request.requestId]);
    assert.equal(data.unavailable, change === "expired" ? 0 : 1);
    assert.equal(data.truncated, false);
    assert.ok(!JSON.stringify(data).includes("PRIVATE-RACE-CONTENT"));
  });
}

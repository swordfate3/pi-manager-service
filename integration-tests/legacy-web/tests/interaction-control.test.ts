import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { test } from "node:test";
import { InteractionBroker } from "../extensions/interactions/broker.ts";
import { createInteractionControlServer } from "../extensions/interactions/control.ts";
import { signInteractionEvidence } from "../extensions/interactions/proof.ts";
import { openInteractionControl } from "../hub/interaction-control.ts";

async function fixture(t: test.TestContext) {
  const identity = { runId: "a".repeat(32), generation: "b".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" };
  const pair = generateKeyPairSync("ed25519");
  const token = randomBytes(32).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const signing = { pin: { issuer: "test-hub" }, epoch, sign: (claim: Record<string, unknown>) => signInteractionEvidence(pair.privateKey, {
    ...claim, protocol: "pi-web-interactions-v1", audience: "pi-interaction-broker", issuer: "test-hub", epoch,
  } as Parameters<typeof signInteractionEvidence>[1]) };
  let controlServer: ReturnType<typeof createInteractionControlServer> | undefined;
  const broker = new InteractionBroker(identity, { pin: { issuer: "test-hub", publicKey: pair.publicKey }, onChange: () => controlServer?.notify() });
  controlServer = createInteractionControlServer({ broker: () => broker, authorize: (request) => request.headers.origin === undefined && request.headers["x-pi-web-proof"] === createHmac("sha256", token).update(identity.generation).digest("hex") });
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => { if (!controlServer!.upgrade(request, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { controlServer?.close(); broker.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const target = { identity, backendHost: "127.0.0.1", port: (server.address() as net.AddressInfo).port, token };
  const adapter = broker.registerAdapter({ id: "memory", version: "1", packageName: "memory", actions: { write: { method: "confirm", classification: "sensitive" } } });
  const source = () => adapter.request({ action: "write", revision: "revision-1", classification: "sensitive", method: "confirm", schema: { kind: "confirm" }, content: { preview: "PRIVATE-TEST-PREVIEW" }, deadline: Date.now() + 10_000 }, { isCurrent: () => true });
  return { broker, target, signing, source };
}

test("real private WebSocket negotiates pinned authority, then reads and settles exact source operation", async (t) => {
  const f = await fixture(t);
  const channel = await openInteractionControl(f.target, f.signing, () => true);
  t.after(() => channel.close());
  const source = f.source();
  const request = await channel.read(source.request.requestId);
  assert.equal(request.content.preview, "PRIVATE-TEST-PREVIEW");
  assert.equal(await channel.decide(request, true, "d".repeat(32)), "allowed");
  assert.equal((await source.result).answer, true);
  assert.ok(!JSON.stringify(await channel.status()).includes("PRIVATE-TEST-PREVIEW"));
});

test("run-token possession without Hub signing authority cannot establish approval channel", async (t) => {
  const f = await fixture(t);
  const wrong = generateKeyPairSync("ed25519");
  const signer = { ...f.signing, sign: (claim: Record<string, unknown>) => signInteractionEvidence(wrong.privateKey, {
    ...claim, protocol: "pi-web-interactions-v1", audience: "pi-interaction-broker", issuer: "test-hub", epoch: f.signing.epoch,
  } as Parameters<typeof signInteractionEvidence>[1]) };
  await assert.rejects(() => openInteractionControl(f.target, signer, () => true));
});

test("channel loss settles pending source; stale registration cannot deliver a later approval", async (t) => {
  const f = await fixture(t);
  let current = true;
  const channel = await openInteractionControl(f.target, f.signing, () => current);
  const source = f.source();
  current = false;
  await assert.rejects(() => channel.decide(source.request, true, "d".repeat(32)));
  channel.close();
  assert.equal((await source.result).state, "cancelled");
});

test("replaced control cancels old work and its late close cannot revoke the new authority", async (t) => {
  const f = await fixture(t);
  const first = await openInteractionControl(f.target, f.signing, () => true);
  const previous = f.source();
  const next = await openInteractionControl(f.target, f.signing, () => true);
  t.after(() => next.close());
  assert.equal((await previous.result).state, "cancelled");
  first.close();
  const current = f.source();
  assert.equal(await next.decide(await next.read(current.request.requestId), true, "f".repeat(32)), "allowed");
  assert.equal((await current.result).answer, true);
});

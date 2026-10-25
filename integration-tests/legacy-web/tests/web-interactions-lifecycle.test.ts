import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startPiWebUi, type PiWebUiHarness } from "../e2e/harness/pi-process.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

type Hub = Awaited<ReturnType<typeof startHub>>;
type Json = Record<string, any>;
type Effect = { event: string; operationId?: string; instanceId?: string; sessionId?: string; state?: string };

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = path.join(root, "e2e/fixtures/web-interaction-lifecycle-extension.ts");

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, message: string, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function effects(file: string): Effect[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function operationEffects(file: string, operationId: string) {
  return effects(file).filter((entry) => entry.operationId === operationId);
}

async function connectPi(harness: PiWebUiHarness) {
  const events: Json[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  const sync = await eventually(
    () => events.find((event) => event.event === "state_sync"),
    "real Pi WebSocket did not publish state_sync",
  );
  return { events, socket, sync };
}

async function waitForPiServer(harness: PiWebUiHarness) {
  await eventually(async () => {
    try {
      const response = await fetch(harness.pageUrl);
      await response.body?.cancel();
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, "real Pi Web server did not return after lifecycle replacement");
}

async function currentGeneration(hub: Hub, previous?: string) {
  return await eventually(async () => {
    try {
      const response = await fetch(`${hub.url}api/sessions`);
      const body = await response.json();
      const generation = body.sessions?.[0]?.generation;
      return typeof generation === "string" && generation !== previous ? generation : undefined;
    } catch {
      return undefined;
    }
  }, "real Pi did not register a current Hub generation", 30_000);
}

async function managementHeaders(hub: Hub, config: ReturnType<typeof readHubConfig>) {
  const origin = new URL(hub.managementUrl!).origin;
  const unlock = await fetch(`${hub.managementUrl}api/management/unlock`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueManagementCode(config).code }),
  });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return {
    Origin: origin,
    Cookie: cookie,
    "x-pi-hub-csrf": (await unlock.json()).csrf as string,
    "Content-Type": "application/json",
  };
}

function interactionRoute(hub: Hub, generation: string, requestId: string) {
  return `${hub.managementUrl}api/management/interactions/${generation}/${requestId}`;
}

async function review(hub: Hub, generation: string, requestId: string, headers: Record<string, string>) {
  const response = await fetch(interactionRoute(hub, generation, requestId), { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as Json;
}

async function decide(
  hub: Hub,
  generation: string,
  requestId: string,
  headers: Record<string, string>,
  request: Json,
  decisionId: string,
) {
  return await fetch(interactionRoute(hub, generation, requestId), {
    method: "POST",
    headers,
    body: JSON.stringify({
      decisionId,
      digest: request.digest,
      revision: request.revision,
      answer: true,
    }),
  });
}

async function pendingInteraction(events: Json[], known = new Set<string>()) {
  return await eventually(() => {
    for (const event of events) {
      if (event.event !== "extension_interactions") continue;
      for (const item of event.payload?.pending ?? []) if (!known.has(item.requestId)) return item as Json;
    }
    return undefined;
  }, "cooperative interaction did not become pending");
}

async function nativeConfirmation(rpcEvents: Json[], from: number) {
  return await eventually(
    () => rpcEvents.slice(from).find((event) => event.type === "extension_ui_request" && event.method === "confirm"),
    "real Pi native confirmation did not start",
  );
}

async function startInteraction(
  harness: PiWebUiHarness,
  events: Json[],
  rpcEvents: Json[],
  operationId: string,
  mode = "plain",
) {
  const known = new Set(
    events.flatMap((event) => (event.event === "extension_interactions" ? event.payload?.pending ?? [] : [])).map((item) => item.requestId),
  );
  const rpcFrom = rpcEvents.length;
  const operation = harness
    .rpc({ type: "prompt", message: `/test-lifecycle-confirm ${operationId} ${mode}` })
    .then(() => undefined, (error: Error) => error);
  const [pending, native] = await Promise.all([
    pendingInteraction(events, known),
    nativeConfirmation(rpcEvents, rpcFrom),
  ]);
  return { pending, native, operation };
}

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "real-pi-interaction-lifecycle-"));
  const configFile = path.join(dir, "hub.json");
  initializeHub(configFile, { port: 0, management: { port: 0 } });
  const config = readHubConfig(configFile);
  const credentialFile = path.join(dir, "run.json");
  issueSession(config, credentialFile, { label: "real Pi lifecycle acceptance" });
  let hub = await startHub(config, { versions: { source: async () => ({}) } });
  const rpcEvents: Json[] = [];
  const harness = await startPiWebUi("basic", {
    repositoryRoot: root,
    git: false,
    registration: { socketPath: config.socketPath, credentialFile },
    extraExtensions: [extension],
    onRpcEvent: (event) => rpcEvents.push(event),
  });
  const effectFile = path.join(harness.workspaceDir, "web-interaction-lifecycle-effects.jsonl");
  return {
    config,
    dir,
    effectFile,
    harness,
    rpcEvents,
    hub: () => hub,
    replaceHub(next: Hub) {
      hub = next;
    },
    async close() {
      await harness.stop();
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("real Pi session replacement cancels a pending confirmation and old decisions cannot replay", { timeout: 90_000 }, async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  let nextSocket: WebSocket | undefined;
  try {
    const connection = await connectPi(f.harness);
    socket = connection.socket;
    const firstSession = connection.sync.payload.sessionId;
    const oldGeneration = await currentGeneration(f.hub());
    const headers = await managementHeaders(f.hub(), f.config);
    const oldOperation = "1".repeat(32);
    const old = await startInteraction(f.harness, connection.events, f.rpcEvents, oldOperation);
    const oldRequest = await review(f.hub(), oldGeneration, old.pending.requestId, headers);

    const replacement = (await f.harness.rpc({ type: "new_session" })) as Json;
    assert.equal(replacement.cancelled, false);
    f.harness.respondToUI(String(old.native.id), true);
    await eventually(
      () => operationEffects(f.effectFile, oldOperation).find((entry) => entry.event === "settled"),
      "old source callback did not settle after successful session replacement",
    );
    assert.equal(operationEffects(f.effectFile, oldOperation).filter((entry) => entry.event === "effect").length, 0);
    assert.ok(effects(f.effectFile).some((entry) => entry.event === "session-before-switch"));

    await waitForPiServer(f.harness);
    const next = await connectPi(f.harness);
    nextSocket = next.socket;
    assert.notEqual(next.sync.payload.sessionId, firstSession);
    const nextGeneration = await currentGeneration(f.hub(), oldGeneration);
    const replay = await decide(f.hub(), oldGeneration, old.pending.requestId, headers, oldRequest, "a".repeat(32));
    assert.ok([200, 409].includes(replay.status));
    if (replay.status === 200) assert.notEqual((await replay.json()).state, "allowed");

    const freshOperation = "2".repeat(32);
    const fresh = await startInteraction(f.harness, next.events, f.rpcEvents, freshOperation);
    const freshRequest = await review(f.hub(), nextGeneration, fresh.pending.requestId, headers);
    const wrongReplay = await decide(f.hub(), nextGeneration, fresh.pending.requestId, headers, oldRequest, "a".repeat(32));
    assert.equal(wrongReplay.status, 409);
    const allow = await decide(f.hub(), nextGeneration, fresh.pending.requestId, headers, freshRequest, "b".repeat(32));
    assert.equal(allow.status, 200);
    assert.equal((await allow.json()).state, "allowed");
    await eventually(
      () => operationEffects(f.effectFile, freshOperation).find((entry) => entry.event === "effect"),
      "fresh session source effect did not commit",
    );
    assert.equal(await fresh.operation, undefined);
    assert.equal(operationEffects(f.effectFile, freshOperation).filter((entry) => entry.event === "effect").length, 1);
  } finally {
    socket?.terminate();
    nextSocket?.terminate();
    await f.close();
  }
});

test("real Pi reload cancels a pending confirmation and a delayed old decision cannot affect the reloaded source", { timeout: 90_000 }, async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  let nextSocket: WebSocket | undefined;
  try {
    const connection = await connectPi(f.harness);
    socket = connection.socket;
    const oldGeneration = await currentGeneration(f.hub());
    const headers = await managementHeaders(f.hub(), f.config);
    const oldOperation = "3".repeat(32);
    const old = await startInteraction(f.harness, connection.events, f.rpcEvents, oldOperation, "reload");
    const oldRequest = await review(f.hub(), oldGeneration, old.pending.requestId, headers);
    writeFileSync(path.join(f.harness.workspaceDir, `.pi-web-lifecycle-reload-${oldOperation}`), "reload\n", "utf8");

    await eventually(
      () => effects(f.effectFile).find((entry) => entry.event === "reload-requested" && entry.operationId === oldOperation),
      "fixture did not request the real Pi reload",
    );
    await eventually(
      () => effects(f.effectFile).find((entry) => entry.event === "shutdown"),
      "old extension instance did not receive session shutdown during reload",
    );
    f.harness.respondToUI(String(old.native.id), true);
    assert.equal(operationEffects(f.effectFile, oldOperation).filter((entry) => entry.event === "effect").length, 0);

    await waitForPiServer(f.harness);
    const next = await connectPi(f.harness);
    nextSocket = next.socket;
    const nextGeneration = await currentGeneration(f.hub(), oldGeneration);
    const replay = await decide(f.hub(), oldGeneration, old.pending.requestId, headers, oldRequest, "c".repeat(32));
    assert.ok([200, 409].includes(replay.status));
    if (replay.status === 200) assert.notEqual((await replay.json()).state, "allowed");

    const freshOperation = "4".repeat(32);
    const fresh = await startInteraction(f.harness, next.events, f.rpcEvents, freshOperation);
    const freshRequest = await review(f.hub(), nextGeneration, fresh.pending.requestId, headers);
    const wrongReplay = await decide(f.hub(), nextGeneration, fresh.pending.requestId, headers, oldRequest, "c".repeat(32));
    assert.equal(wrongReplay.status, 409);
    const allow = await decide(f.hub(), nextGeneration, fresh.pending.requestId, headers, freshRequest, "d".repeat(32));
    assert.equal(allow.status, 200);
    assert.equal((await allow.json()).state, "allowed");
    await eventually(
      () => operationEffects(f.effectFile, freshOperation).find((entry) => entry.event === "effect"),
      "reloaded source did not commit its fresh approved effect",
    );
    assert.equal(await fresh.operation, undefined);
    assert.equal(operationEffects(f.effectFile, freshOperation).filter((entry) => entry.event === "effect").length, 1);
  } finally {
    socket?.terminate();
    nextSocket?.terminate();
    await f.close();
  }
});

test("real Pi recovers after Hub restart without replaying the cancelled old decision", { timeout: 90_000 }, async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const connection = await connectPi(f.harness);
    socket = connection.socket;
    const oldHub = f.hub();
    const oldGeneration = await currentGeneration(oldHub);
    const oldHeaders = await managementHeaders(oldHub, f.config);
    const oldOperation = "5".repeat(32);
    const old = await startInteraction(f.harness, connection.events, f.rpcEvents, oldOperation);
    const oldRequest = await review(oldHub, oldGeneration, old.pending.requestId, oldHeaders);

    await oldHub.close();
    await eventually(
      () => operationEffects(f.effectFile, oldOperation).find((entry) => entry.event === "settled"),
      "source interaction did not settle when its trusted Hub channel closed",
    );
    f.harness.respondToUI(String(old.native.id), true);
    assert.equal(operationEffects(f.effectFile, oldOperation).filter((entry) => entry.event === "effect").length, 0);

    const restarted = await startHub(f.config, { versions: { source: async () => ({}) } });
    f.replaceHub(restarted);
    const nextGeneration = await currentGeneration(restarted, oldGeneration);
    const headers = await managementHeaders(restarted, f.config);
    const oldReplay = await decide(restarted, oldGeneration, old.pending.requestId, headers, oldRequest, "e".repeat(32));
    assert.ok([200, 409].includes(oldReplay.status));
    if (oldReplay.status === 200) assert.notEqual((await oldReplay.json()).state, "allowed");

    const freshOperation = "6".repeat(32);
    const fresh = await startInteraction(f.harness, connection.events, f.rpcEvents, freshOperation);
    const freshRequest = await review(restarted, nextGeneration, fresh.pending.requestId, headers);
    const wrongReplay = await decide(restarted, nextGeneration, fresh.pending.requestId, headers, oldRequest, "e".repeat(32));
    assert.equal(wrongReplay.status, 409);
    const allow = await decide(restarted, nextGeneration, fresh.pending.requestId, headers, freshRequest, "f".repeat(32));
    assert.equal(allow.status, 200);
    assert.equal((await allow.json()).state, "allowed");
    await eventually(
      () => operationEffects(f.effectFile, freshOperation).find((entry) => entry.event === "effect"),
      "source did not commit a fresh effect after Hub restart recovery",
    );
    assert.equal(await fresh.operation, undefined);
    assert.equal(operationEffects(f.effectFile, freshOperation).filter((entry) => entry.event === "effect").length, 1);
    assert.equal(operationEffects(f.effectFile, oldOperation).filter((entry) => entry.event === "effect").length, 0);
  } finally {
    socket?.terminate();
    await f.close();
  }
});

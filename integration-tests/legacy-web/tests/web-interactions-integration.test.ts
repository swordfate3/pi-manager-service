import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startPiWebUi } from "../e2e/harness/pi-process.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Temporary integration event timed out");
}

test("real Pi source consumes trusted Hub confirmation and aborts native dialog without leaking preview to chat", { timeout: 45_000 }, async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "real-pi-interaction-"));
  let harness: Awaited<ReturnType<typeof startPiWebUi>> | undefined;
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const configFile = path.join(dir, "hub.json");
    initializeHub(configFile, { port: 0, management: { port: 0 } });
    const config = readHubConfig(configFile);
    const credentialFile = path.join(dir, "run.json");
    issueSession(config, credentialFile, { label: "real Pi isolated fixture" });
    hub = await startHub(config, { versions: { source: async () => ({}) } });
    const rpcEvents: Record<string, unknown>[] = [];
    harness = await startPiWebUi("basic", { repositoryRoot: root, git: false, registration: { socketPath: config.socketPath, credentialFile }, extraExtensions: [path.join(root, "e2e/fixtures/web-interaction-extension.ts")], onRpcEvent: (event) => rpcEvents.push(event) });
    const sessions = await eventually(async () => { const data = await (await fetch(`${hub!.url}api/sessions`)).json(); return data.sessions.length ? data.sessions : undefined; });
    const generation = sessions[0].generation;
    const events: Record<string, any>[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await eventually(() => events.find((event) => event.event === "state_sync"));
    const operation = harness.rpc({ type: "prompt", message: "/test-web-confirm" });
    const notice = await eventually(() => events.find((event) => event.event === "extension_interactions" && event.payload?.pending?.length));
    const requestId = notice.payload.pending[0].requestId;
    const unlock = await fetch(`${hub.managementUrl}api/management/unlock`, { method: "POST", headers: { Origin: new URL(hub.managementUrl!).origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: issueManagementCode(config).code }) });
    const headers = { Origin: new URL(hub.managementUrl!).origin, Cookie: unlock.headers.get("set-cookie")!.split(";")[0], "x-pi-hub-csrf": (await unlock.json()).csrf, "Content-Type": "application/json" };
    const route = `${hub.managementUrl}api/management/interactions/${generation}/${requestId}`;
    const review = await fetch(route, { headers });
    assert.equal(review.status, 200);
    const request = await review.json();
    assert.equal(request.content.preview, "PRIVATE-REAL-PI-PREVIEW");
    const allow = await fetch(route, { method: "POST", headers, body: JSON.stringify({ decisionId: "a".repeat(32), digest: request.digest, revision: request.revision, answer: true }) });
    assert.equal(allow.status, 200);
    await operation;
    await eventually(() => rpcEvents.find((event) => event.message === "FIXTURE_WEB_INTERACTION_COMMITTED"));
    await eventually(() => events.find((event) => event.event === "ui_prompt_end"));
    assert.equal(rpcEvents.filter((event) => event.message === "FIXTURE_WEB_INTERACTION_COMMITTED").length, 1);
    assert.ok(!JSON.stringify(events).includes("PRIVATE-REAL-PI-PREVIEW"));
    await harness.rpc({ type: "prompt", message: "/test-cancel-session" });
    await eventually(() => rpcEvents.find((event) => event.message === "FIXTURE_SESSION_SWITCH_CANCELLED"));
    await harness.rpc({ type: "prompt", message: "Hello" });
    const state = events.find((event) => event.event === "state_sync")!.payload;
    socket.send(JSON.stringify({ type: "req", id: "after-cancel-panels", method: "get_extension_panels", params: { sessionId: state.sessionId, runtimeId: state.runtimeId } }));
    const panels = await eventually(() => events.find((event) => event.type === "res" && event.id === "after-cancel-panels"));
    assert.equal(panels.ok, true, JSON.stringify(panels));
    assert.equal(panels.result.length, 2, "fresh input after a cancelled transition restores source panels");
  } finally {
    socket?.terminate(); await harness?.stop(); await hub?.close(); rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["local-allow", "local-deny", "web-deny", "simultaneous-allow", "timeout", "cancel", "hub-disconnect"] as const) {
  test(`real Pi cooperative confirmation: ${mode} settles once without private chat data`, { timeout: 45_000 }, async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const dir = mkdtempSync(path.join(tmpdir(), "real-pi-interaction-race-"));
    let harness: Awaited<ReturnType<typeof startPiWebUi>> | undefined;
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    let socket: WebSocket | undefined;
    try {
      const configFile = path.join(dir, "hub.json");
      initializeHub(configFile, { port: 0, management: { port: 0 } });
      const config = readHubConfig(configFile);
      const credentialFile = path.join(dir, "run.json");
      issueSession(config, credentialFile, { label: "temporary arbitration fixture" });
      hub = await startHub(config, { versions: { source: async () => ({}) } });
      const rpcEvents: Record<string, unknown>[] = [];
      harness = await startPiWebUi("basic", { repositoryRoot: root, git: false, registration: { socketPath: config.socketPath, credentialFile }, extraExtensions: [path.join(root, "e2e/fixtures/web-interaction-extension.ts")], onRpcEvent: (event) => rpcEvents.push(event) });
      const sessions = await eventually(async () => {
        const data = await (await fetch(`${hub!.url}api/sessions`)).json();
        return data.sessions.length ? data.sessions : undefined;
      });
      const events: Record<string, any>[] = [];
      socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
      socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
      await eventually(() => events.find((event) => event.event === "state_sync"));
      const argument = mode === "timeout" || mode === "cancel" ? ` ${mode}` : "";
      const operation = harness.rpc({ type: "prompt", message: `/test-web-confirm${argument}` });
      const notice = await eventually(() => events.find((event) => event.event === "extension_interactions" && event.payload?.pending?.length));
      const requestId = notice.payload.pending[0].requestId;
      const native = await eventually(() => rpcEvents.find((event) => event.type === "extension_ui_request" && event.method === "confirm"));
      let route: string | undefined;
      let headers: Record<string, string> | undefined;
      let request: Record<string, any> | undefined;
      if (["web-deny", "simultaneous-allow", "hub-disconnect"].includes(mode)) {
        const origin = new URL(hub.managementUrl!).origin;
        const unlock = await fetch(`${hub.managementUrl}api/management/unlock`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: issueManagementCode(config).code }) });
        headers = { Origin: origin, Cookie: unlock.headers.get("set-cookie")!.split(";")[0], "x-pi-hub-csrf": (await unlock.json()).csrf, "Content-Type": "application/json" };
        route = `${hub.managementUrl}api/management/interactions/${sessions[0].generation}/${requestId}`;
        const review = await fetch(route, { headers });
        assert.equal(review.status, 200);
        request = await review.json();
      }
      if (mode === "local-allow" || mode === "local-deny") harness.respondToUI(String(native.id), mode === "local-allow");
      else if (mode === "web-deny" || mode === "simultaneous-allow") {
        const decision = { decisionId: "c".repeat(32), digest: request!.digest, revision: request!.revision, answer: mode === "simultaneous-allow" };
        const delivered = fetch(route!, { method: "POST", headers, body: JSON.stringify(decision) });
        if (mode === "simultaneous-allow") harness.respondToUI(String(native.id), true);
        const response = await delivered;
        if (mode === "web-deny") assert.equal(response.status, 200);
        else assert.ok([200, 409, 410].includes(response.status), `race returned ${response.status}`);
      } else if (mode === "hub-disconnect") {
        await hub.close();
        hub = undefined;
      }
      await operation;
      const allowed = mode === "local-allow" || mode === "simultaneous-allow";
      const marker = allowed ? "FIXTURE_WEB_INTERACTION_COMMITTED" : "FIXTURE_WEB_INTERACTION_NOT_COMMITTED";
      await eventually(() => rpcEvents.find((event) => event.message === marker));
      await eventually(() => events.find((event) => event.event === "ui_prompt_end"));
      assert.equal(rpcEvents.filter((event) => event.message === "FIXTURE_WEB_INTERACTION_COMMITTED").length, allowed ? 1 : 0);
      assert.equal(rpcEvents.filter((event) => event.message === marker).length, 1);
      assert.ok(!JSON.stringify(events).includes("PRIVATE-REAL-PI-PREVIEW"));
      // A delayed native reply must not revive an expired, denied or disconnected request.
      harness.respondToUI(String(native.id), true);
      await harness.rpc({ type: "get_state" });
      assert.equal(rpcEvents.filter((event) => event.message === "FIXTURE_WEB_INTERACTION_COMMITTED").length, allowed ? 1 : 0);
    } finally {
      socket?.terminate();
      await harness?.stop();
      await hub?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

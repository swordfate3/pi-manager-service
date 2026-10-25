import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { UsageStatsResult } from "../src/web/src/core/types.ts";
import { startPiWebUi } from "./harness/pi-process.ts";

test("real Pi usage method rejects missing/stale identities and returns full-session mixed-model totals without content", {
  timeout: 60_000,
}, async () => {
  const harness = await startPiWebUi("chat-lifecycle", {
    repositoryRoot: fileURLToPath(new URL("..", import.meta.url)),
    usageHistory: true,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  const pending = new Map<string, { resolve: (value: UsageStatsResult) => void; reject: (reason: unknown) => void }>();
  let counter = 0;
  let syncResolve!: (value: { sessionId: string; runtimeId: string }) => void;
  const sync = new Promise<{ sessionId: string; runtimeId: string }>((resolve) => {
    syncResolve = resolve;
  });
  socket.on("message", (bytes) => {
    const data = JSON.parse(String(bytes));
    if (data.type === "event" && data.event === "state_sync") syncResolve(data.payload);
    if (data.type === "res") {
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) request?.resolve(data.result);
      else request?.reject(new Error(data.error));
    }
  });
  function send(params: Record<string, unknown>) {
    const id = `usage-${++counter}`;
    return new Promise<UsageStatsResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "req", id, method: "get_usage_stats", params }));
    });
  }
  try {
    const initial = await sync;
    const scope = { sessionId: initial.sessionId, runtimeId: initial.runtimeId };
    assert.equal(typeof scope.sessionId, "string");
    assert.equal(typeof scope.runtimeId, "string");
    await assert.rejects(send({}));
    await assert.rejects(send({ sessionId: scope.sessionId }));
    await assert.rejects(send({ ...scope, sessionId: "stale" }));
    await assert.rejects(send({ ...scope, runtimeId: "stale" }));
    const result = await send(scope);
    assert.equal(result.statisticsScope, "all_entries");
    assert.equal(result.currency, "USD");
    assert.equal(result.sessionId, scope.sessionId);
    assert.equal(result.runtimeId, scope.runtimeId);
    assert.deepEqual(result.totals, {
      input: 300,
      output: 60,
      cacheRead: 90,
      cacheWrite: 15,
      totalTokens: 465,
      requests: 2,
      unpricedRequests: 1,
      cost: 0.001,
    });
    assert.deepEqual(result.models.map((row) => row.model).sort(), ["billed-model-a", "billed-model-b"]);
    assert.equal(result.lastResponse?.model, "billed-model-b");
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      harness.workspaceDir,
      harness.sessionDir,
      "SYNTHETIC_USAGE",
      "selected-alias",
      "content",
      "faux-key",
    ])
      assert.equal(serialized.includes(forbidden), false);
  } finally {
    socket.terminate();
    await harness.stop();
  }
});

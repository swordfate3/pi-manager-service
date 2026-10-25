// Real Pi + real packaged Hub regression; never loads user sessions or real models.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isBoundedGeneration } from "../extensions/hub-generation.ts";
import type {
  HistoryMetadata,
  SavedSessionsResult,
  SessionEntry,
  SessionTreeNodeWire,
} from "../src/web/src/core/types.ts";
import { startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

type HistorySnapshot = {
  entries: SessionEntry[];
  treeNodes: SessionTreeNodeWire[];
  history: HistoryMetadata;
  sessionId: string;
  runtimeId: string;
};

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Detail = { sessionId: string; runtimeId: string; entryId: string; text: string; nextCursor: string | null };

function assertWindow(snapshot: HistorySnapshot) {
  assert.ok(snapshot.entries.length <= 40);
  assert.ok(bytes(snapshot.entries) <= 192 * 1024);
  assert.ok(snapshot.entries.every((entry) => bytes(entry) <= 16 * 1024));
  assert.ok(snapshot.treeNodes.length <= 200);
  assert.ok(bytes(snapshot.treeNodes) <= 32 * 1024);
}

test("large dated history remains connected through Hub and loads only requested pages without modifying JSONL", {
  timeout: 45000,
}, async (t) => {
  const hub = await startHubCli({ repositoryRoot });
  let agent: PiWebUiHarness | undefined;
  let ws: WebSocket | undefined;
  const pending = new Map<
    string,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  t.after(async () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Test ended"));
    }
    ws?.terminate();
    try {
      await agent?.stop();
    } finally {
      await hub.close();
    }
  });
  agent = await startPiWebUi("chat-lifecycle", {
    repositoryRoot,
    datedHistory: true,
    registration: hub.issue("dated-history"),
  });
  const filename = readdirSync(agent.sessionDir).find((file) => file.includes("8e91f4c2-3000-4500-8500-000000000003"));
  assert.ok(filename, "Large dated fixture was written");
  const sessionFile = path.join(agent.sessionDir, filename);
  const originalHash = digest(sessionFile);
  assert.ok(statSync(sessionFile).size > 20 * 1024 * 1024);
  let route: string | undefined;
  const deadline = Date.now() + 10000;
  do {
    const result = await (await fetch(`${hub.url}api/sessions`)).json();
    route = result.sessions[0]?.path;
    if (route) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(route, "Pi registers in the isolated Hub");
  assert.ok(isBoundedGeneration(route.split("/")[2]), "Packaged Hub negotiates bounded-v2, never legacy fallback");
  const wsUrl = new URL(`${route}ws`, hub.url);
  wsUrl.protocol = "ws:";
  const frames: number[] = [];
  const historyFrames: number[] = [];
  const detailFrames: number[] = [];
  const windows: HistorySnapshot[] = [];
  let nextId = 0;
  const snapshots: HistorySnapshot[] = [];
  const socket = new WebSocket(wsUrl, { origin: new URL(hub.url).origin, maxPayload: 16 * 1024 * 1024 });
  ws = socket;
  const initial = new Promise<HistorySnapshot>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bounded state_sync did not arrive")), 10000);
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("Hub closed before bounded state_sync"));
    });
    socket.on("message", (raw) => {
      const text = raw.toString();
      const frameBytes = Buffer.byteLength(text, "utf8");
      frames.push(frameBytes);
      const value = JSON.parse(text);
      if (value.type === "event" && value.event === "state_sync") {
        assert.ok(frameBytes <= 256 * 1024, "Complete state_sync envelope before compression");
        historyFrames.push(frameBytes);
        assertWindow(value.payload);
        windows.push(value.payload);
        snapshots.push(value.payload);
        clearTimeout(timer);
        resolve(value.payload);
      }
      if (value.type === "res") {
        const request = pending.get(value.id);
        if (request) {
          if (["get_history", "sync_request", "get_tree"].includes(request.method)) {
            assert.ok(frameBytes <= 256 * 1024, `Complete ${request.method} envelope before compression`);
            historyFrames.push(frameBytes);
            if (value.ok) {
              assertWindow(value.result);
              windows.push(value.result);
            }
          }
          if (request.method === "get_entry_detail") {
            assert.ok(frameBytes <= 64 * 1024, "Complete detail envelope including errors");
            detailFrames.push(frameBytes);
          }
          clearTimeout(request.timer);
          pending.delete(value.id);
          if (value.ok) request.resolve(value.result);
          else request.reject(new Error(value.error));
        }
      }
    });
  });
  const first = await initial;
  assert.ok(first.history, "Initial snapshot declares its bounded history window");
  assertWindow(first);
  assert.ok(!JSON.stringify(first).includes("DATED_OLD_ONLY_MARKER"));
  assert.ok(JSON.stringify(first.entries).includes("DATED_RECENT_END_MARKER"));
  assert.ok(first.history.truncatedEntries > 0, "The giant message has an explicit preview");
  assert.ok(first.history.nextBefore, "A recent day is paged rather than sent in full");

  const request = <T = HistorySnapshot>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = `history-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No response to ${method}`));
      }, 10000);
      pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const next = await request("get_history", {
    from: first.history.from,
    to: first.history.to,
    before: first.history.nextBefore,
    sessionId: first.sessionId,
  });
  assert.ok(next.entries.length > 0);
  const firstIds = new Set(first.entries.map((entry) => entry.id));
  assert.ok(
    next.entries.every((entry) => !firstIds.has(entry.id)),
    "Consecutive pages do not overlap",
  );
  const seen = new Set([...firstIds, ...next.entries.map((entry) => entry.id)]);
  let page = next;
  let pageCount = 2;
  while (page.history.nextBefore) {
    assert.ok(pageCount < 10, "Older pages must terminate, not loop");
    const before = page.history.nextBefore;
    page = await request("get_history", {
      from: first.history.from,
      to: first.history.to,
      before,
      sessionId: first.sessionId,
    });
    assert.ok(page.entries.length > 0, "Each older page makes progress");
    for (const entry of page.entries) {
      assert.ok(!seen.has(entry.id), "No repeated entry across any older page");
      seen.add(entry.id);
    }
    assert.notEqual(page.history.nextBefore, before);
    pageCount++;
  }
  for (const id of [
    "datedbig",
    "datedend",
    ...Array.from({ length: 150 }, (_, i) => `dated-${String(i).padStart(4, "0")}`),
  ])
    assert.ok(seen.has(id), `Persisted fixture entry ${id} remains reachable (Pi may add startup metadata)`);
  const scope = { sessionId: first.sessionId, runtimeId: first.runtimeId, entryId: "datedbig" };
  const detail = await request<Detail>("get_entry_detail", scope);
  assert.equal(detail.entryId, "datedbig");
  assert.equal(detail.sessionId, first.sessionId);
  assert.equal(detail.runtimeId, first.runtimeId);
  assert.ok(detail.text.startsWith("DATED_LARGE_START_"));
  assert.ok(detail.nextCursor);
  const continuation = await request<Detail>("get_entry_detail", { ...scope, cursor: detail.nextCursor });
  assert.ok(/^x+$/.test(continuation.text), "Next chunk replaces, never repeats/concatenates first chunk");
  assert.ok(continuation.nextCursor && continuation.nextCursor !== detail.nextCursor);
  for (const invalid of [
    { sessionId: "other-session" },
    { runtimeId: "other-runtime" },
    { entryId: "savedold" },
    { entryId: "../../outside" },
    { cursor: "invalid" },
    { entryId: "datedold", cursor: detail.nextCursor },
  ]) {
    await assert.rejects(request("get_entry_detail", { ...scope, ...invalid }), /session|runtime|detail|cursor/i);
  }
  const [cursorBody, signature] = detail.nextCursor.split(".");
  const decoded = JSON.parse(Buffer.from(cursorBody, "base64url").toString());
  for (const changed of [
    { ...decoded, offset: -1 },
    { ...decoded, fence: "0".repeat(64) },
  ]) {
    const cursor = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    await assert.rejects(request("get_entry_detail", { ...scope, cursor }), /detail|cursor/i);
  }
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = midnight - 14 * 86400000;
  const old = await request("get_history", { from, to: from + 86400000, sessionId: first.sessionId });
  assert.deepEqual(
    old.entries.map((entry) => entry.id),
    ["datedold"],
  );
  assert.match(JSON.stringify(old.entries), /DATED_OLD_ONLY_MARKER/);
  const oldDetail = await request<Detail>("get_entry_detail", { ...scope, entryId: "datedold" });
  assert.equal(oldDetail.text, "DATED_OLD_ONLY_MARKER");
  assert.equal(oldDetail.nextCursor, null);
  assert.ok(!JSON.stringify(old).includes("DATED_RECENT_END_MARKER"));
  const synced = await request("sync_request", { from, to: from + 86400000, sessionId: first.sessionId });
  assert.deepEqual(
    synced.entries.map((entry) => entry.id),
    ["datedold"],
  );
  const recent = await request("get_history", {
    from: first.history.from,
    to: first.history.to,
    sessionId: first.sessionId,
  });
  assert.match(JSON.stringify(recent.entries), /DATED_RECENT_END_MARKER/);
  const recentSessions = await request<SavedSessionsResult>("get_saved_sessions", {
    from: first.history.from,
    to: first.history.to,
  });
  assert.ok(
    !recentSessions.sessions.some((session) => session.sessionId === "9e91f4c2-0000-4500-8500-000000000014"),
    "Old saved sessions are not returned by a recent-date query",
  );
  const oldSessions = await request<SavedSessionsResult>("get_saved_sessions", { from, to: from + 86400000 });
  assert.deepEqual(
    oldSessions.sessions.map((session) => session.sessionId),
    ["9e91f4c2-0000-4500-8500-000000000014"],
  );
  assert.ok(
    !JSON.stringify(oldSessions).includes("DATED_LARGE_START"),
    "Saved-session queries only return compact metadata",
  );
  await assert.rejects(
    request("get_history", { from, to: from + 86400000, sessionId: "not-the-current-session" }),
    /session/i,
  );
  await assert.rejects(
    request("get_history", { from, to: from + 86400000, before: "unknown-entry", sessionId: first.sessionId }),
    /cursor/i,
  );
  await assert.rejects(
    request("get_history", { from: 123, to: 122, sessionId: first.sessionId }),
    /range|date|time|from/i,
  );
  await request("get_tree");
  await agent.rpc({ type: "prompt", message: "/webui" });
  await request("navigate_tree", { entryId: "datedbig" });
  await assert.rejects(request("get_entry_detail", { ...scope, cursor: detail.nextCursor }), /detail|cursor/i);
  const reopened = await request<Detail>("get_entry_detail", scope);
  assert.ok(reopened.text.startsWith("DATED_LARGE_START_"), "Current-branch entry can be reopened after leaf change");
  await request("navigate_tree", { entryId: "datedold" });
  await assert.rejects(request("get_entry_detail", scope), /detail|cursor/i);
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(digest(sessionFile), originalHash, "History queries never rewrite the original session");
  console.log(
    JSON.stringify({
      maxFrameBytes: Math.max(...frames),
      maxHistoryEnvelopeBytes: Math.max(...historyFrames),
      maxDetailEnvelopeBytes: Math.max(...detailFrames),
      maxEntriesBytes: Math.max(...windows.map((window) => bytes(window.entries))),
      maxEntryBytes: Math.max(...windows.flatMap((window) => window.entries.map(bytes))),
      maxTreeBytes: Math.max(...windows.map((window) => bytes(window.treeNodes))),
      pageCount,
      uniqueRecentEntries: seen.size,
      jsonlBytes: statSync(sessionFile).size,
      originalHash,
      finalHash: digest(sessionFile),
      initialEntries: first.entries.length,
      initialTreeNodes: first.treeNodes.length,
      snapshots: snapshots.length,
    }),
  );
});

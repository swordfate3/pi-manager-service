import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { RevisionEntry } from "../extensions/message-revision.ts";
import type { MessageVersionGroup } from "../extensions/message-versions.ts";
import { startPiWebUi } from "./harness/pi-process.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await sleep(25);
  }
}
function text(entry: RevisionEntry): string {
  const content = entry.message?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : "";
}

for (const mode of ["edit", "regenerate"] as const) {
  test(`real Pi RPC + WS ${mode}: system-patch pager restores both branches without generation and permits two more turns`, {
    timeout: 60_000,
  }, async () => {
    const harness = await startPiWebUi(`revision-dispatch-${mode}`, {
      repositoryRoot: fileURLToPath(new URL("..", import.meta.url)),
      git: false,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    type Reply = { ok: boolean; result: Record<string, unknown>; error?: string };
    const pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let sequence = 0;
    ws.on("message", (bytes) => {
      const record = JSON.parse(String(bytes));
      if (record.type === "event") events.push(record);
      if (record.type === "res") pending.get(record.id)?.resolve(record);
    });
    const send = (method: string, params: Record<string, unknown>) =>
      new Promise<Reply>((resolve, reject) => {
        const id = `revision-${++sequence}`;
        const cleanup = () => {
          clearTimeout(timer);
          pending.delete(id);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`WS timeout: ${method}`));
        }, 15_000);
        pending.set(id, {
          resolve(reply) {
            cleanup();
            resolve(reply);
          },
          reject(error) {
            cleanup();
            reject(error);
          },
        });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    // Only this harness's freshly generated synthetic session files are read.
    const entries = (): RevisionEntry[] =>
      readdirSync(harness.sessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
          readFileSync(path.join(harness.sessionDir, name), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
    const ends = () => events.filter((e) => e.event === "agent_end").length;
    try {
      await waitFor(() => events.some((e) => e.event === "state_sync"), "initial snapshot");
      const initial = events.find((e) => e.event === "state_sync")?.payload;
      assert.ok(initial);
      const scope = { sessionId: initial.sessionId, runtimeId: initial.runtimeId };
      await harness.rpc({ type: "prompt", message: "/webui" });
      await waitFor(
        () => events.some((e) => e.event === "webui_state" && e.payload.advancedFeatures),
        "command context",
      );
      async function prompt(message: string, answer: string) {
        const count = ends();
        const reply = await send("prompt", { ...scope, message });
        assert.equal(reply.ok, true, reply.error);
        await waitFor(() => ends() > count && entries().some((e) => text(e) === answer), answer);
      }
      await prompt("QUESTION_ALPHA", "ANSWER_ALPHA_ORIGINAL");
      await prompt("QUESTION_BETA", "ANSWER_BETA_ORIGINAL");
      const before = entries();
      const original = before.find(
        (e) => e.message?.role === "user" && text(e) === (mode === "edit" ? "QUESTION_ALPHA" : "QUESTION_BETA"),
      );
      assert.ok(original);
      const target =
        mode === "edit" ? original : before.find((e) => e.parentId === original.id && e.message?.role === "assistant");
      assert.ok(target);
      const preview = await send("get_message_revision", { ...scope, entryId: target.id, mode });
      assert.equal(preview.ok, true, preview.error);
      const count = ends();
      const startEvent = events.length;
      const dispatchedAt = Date.now();
      const submitted = await send("submit_message_revision", {
        ...scope,
        entryId: target.id,
        mode,
        previewId: preview.result.previewId,
        sourceLeafId: preview.result.sourceLeafId,
        ...(mode === "edit" ? { text: "  QUESTION_ALPHA_EDITED  " } : {}),
      });
      assert.equal(submitted.ok, true, submitted.error);
      assert.equal(submitted.result.dispatched, true);
      await waitFor(() => ends() > count, "revision end");
      await waitFor(
        () =>
          entries().some((e) =>
            text(e).startsWith(mode === "edit" ? "ANSWER_ALPHA_EDITED" : "ANSWER_BETA_REGENERATED"),
          ),
        "revision persisted",
      );
      const after = entries();
      const revised = after.find((e) => !before.some((old) => old.id === e.id) && e.message?.role === "user");
      assert.ok(revised);
      assert.equal(text(revised), mode === "edit" ? "  QUESTION_ALPHA_EDITED  " : "QUESTION_BETA");
      assert.notEqual(revised.parentId, original.parentId, "fixture must reproduce the system-patch parent mismatch");
      let parent = revised.parentId;
      let patches = 0;
      while (parent !== original.parentId) {
        assert.ok(++patches <= 64);
        const entry = after.find((e) => e.id === parent);
        assert.ok(entry);
        assert.equal(entry.type, "message");
        assert.equal(entry.message?.role, "system");
        parent = entry.parentId;
      }
      assert.ok(patches > 0);
      const turnEvents = events.slice(startEvent);
      const systemEnd = turnEvents.findIndex(
        (e) => e.event === "message_end" && (e.payload.message as { role?: string })?.role === "system",
      );
      const userStart = turnEvents.findIndex(
        (e) => e.event === "message_start" && (e.payload.message as { role?: string })?.role === "user",
      );
      assert.ok(systemEnd >= 0 && userStart > systemEnd, "system ends before revision user starts");
      for (const old of before)
        assert.deepEqual(
          after.find((e) => e.id === old.id),
          old,
          "original entries unchanged",
        );
      assert.equal(
        after.some((e) => text(e).startsWith("CONTEXT_LEAK")),
        false,
      );
      const revisedAnswer = after.find((e) => e.parentId === revised.id && e.message?.role === "assistant");
      const originalAnswer = before.find((e) => e.parentId === original.id && e.message?.role === "assistant");
      assert.ok(revisedAnswer && originalAnswer);
      async function state() {
        const reply = await send("get_messages", scope);
        assert.equal(reply.ok, true, reply.error);
        return reply.result;
      }
      const newState = await state();
      const newLeaf = newState.leafId;
      const oldLeaf = preview.result.sourceLeafId;
      assert.equal(typeof oldLeaf, "string");
      assert.equal(typeof newLeaf, "string");
      const isRealLeaf = (id: unknown) => after.some((e) => e.id === id) && !after.some((e) => e.parentId === id);
      assert.ok(isRealLeaf(oldLeaf) && isRealLeaf(newLeaf));
      if (mode === "edit") assert.notEqual(oldLeaf, originalAnswer.id, "original ALPHA continues through BETA");
      const versions = [
        { userEntryId: original.id, targetEntryId: oldLeaf },
        { userEntryId: revised.id, targetEntryId: newLeaf },
      ];
      async function group(user: RevisionEntry, answer: RevisionEntry, leaf: unknown, index: number) {
        const reply = await send("get_message_versions", {
          ...scope,
          sourceLeafId: leaf,
          entryIds: [user.id, answer.id],
        });
        assert.equal(reply.ok, true, reply.error);
        assert.equal(reply.result.limited, false);
        assert.deepEqual(reply.result.groups as MessageVersionGroup[], [
          {
            entryIds: [user.id, answer.id],
            userEntryId: user.id,
            index,
            total: 2,
            versions,
          },
        ]);
      }
      await group(revised, revisedAnswer, newLeaf, 2);
      const generationEvents = () =>
        events.filter((e) => ["agent_start", "agent_end", "message_start"].includes(e.event)).length;
      const generationCount = generationEvents();
      const savedBeforeSwitch = entries();
      async function switchVersion(
        entryId: string,
        userEntryId: string,
        sourceLeafId: unknown,
        targetEntryId: unknown,
      ) {
        const reply = await send("switch_message_version", {
          ...scope,
          entryId,
          userEntryId,
          sourceLeafId,
          targetEntryId,
        });
        assert.equal(reply.ok, true, reply.error);
        assert.deepEqual(reply.result, { switched: true, ...scope, leafId: targetEntryId });
        const snapshot = await state();
        assert.equal(snapshot.leafId, targetEntryId);
        return snapshot;
      }
      const restored = await switchVersion(revisedAnswer.id, original.id, newLeaf, oldLeaf);
      await group(original, originalAnswer, oldLeaf, 1);
      const restoredTexts = (restored.entries as RevisionEntry[]).map(text);
      assert.ok(restoredTexts.includes("ANSWER_ALPHA_ORIGINAL") && restoredTexts.includes("ANSWER_BETA_ORIGINAL"));
      assert.ok(!restoredTexts.some((value) => /ANSWER_ALPHA_EDITED|ANSWER_BETA_REGENERATED/.test(value)));
      const resumed = await switchVersion(original.id, revised.id, oldLeaf, newLeaf);
      await group(revised, revisedAnswer, newLeaf, 2);
      assert.deepEqual(resumed.entries, newState.entries, "new branch context restored exactly");
      await sleep(150);
      assert.equal(generationEvents(), generationCount, "pager must not start a model turn or resend messages");
      assert.deepEqual(entries(), savedBeforeSwitch, "pager only navigates, never appends generated entries");
      // Cross the old eight-second timeout: successful dispatch alone never suffices.
      await sleep(Math.max(0, 8_100 - (Date.now() - dispatchedAt)));
      await prompt("FOLLOWUP_ONE", "FOLLOWUP_ONE_OK");
      await prompt("FOLLOWUP_TWO", "FOLLOWUP_TWO_OK");
      assert.equal(
        entries().some((e) => text(e).startsWith("CONTEXT_LEAK")),
        false,
      );
      for (const message of ["FOLLOWUP_ONE", "FOLLOWUP_TWO"]) {
        assert.equal(entries().filter((e) => e.message?.role === "user" && text(e) === message).length, 1);
      }
    } finally {
      for (const request of pending.values()) request.reject(new Error("Test finished"));
      ws.terminate();
      await harness.stop();
    }
  });
}

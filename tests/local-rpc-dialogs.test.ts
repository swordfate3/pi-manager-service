import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { LocalRpcDialogs, type HostRpcDialog } from "../manager/local-rpc-dialogs.ts";

type JsonRecord = Record<string, unknown>;

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 1000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) assert.fail("condition did not settle before deadline");
    await pause(5);
  }
}

function status(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error ? (error as { status?: number }).status : undefined;
}

function fixture(t: any, initialSession = "session-a") {
  const output = new PassThrough();
  const input = new PassThrough();
  const dialogs = new LocalRpcDialogs(output, input);
  const writes: JsonRecord[] = [];
  let sessionId = initialSession;
  let inputBuffer = Buffer.alloc(0);

  input.on("data", (chunk: Buffer) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    for (;;) {
      const newline = inputBuffer.indexOf(10);
      if (newline < 0) break;
      const frame = inputBuffer.subarray(0, newline);
      inputBuffer = inputBuffer.subarray(newline + 1);
      if (!frame.length) continue;
      const record = JSON.parse(frame.toString("utf8")) as JsonRecord;
      writes.push(record);
      if (record.type === "get_state") {
        output.write(JSON.stringify({
          type: "response",
          command: "get_state",
          id: record.id,
          success: true,
          data: { sessionId, isStreaming: false, privateState: "must-not-leak" },
        }) + "\n");
      }
    }
  });

  t.after(() => dialogs.close());
  const request = (record: JsonRecord) => output.write(JSON.stringify(record) + "\n");
  const responses = () => writes.filter(record => record.type === "extension_ui_response");
  const dialog = async (): Promise<HostRpcDialog> => {
    const value = await eventually(() => dialogs.snapshot(sessionId), candidate => candidate !== null);
    assert.ok(value);
    return value;
  };
  return { dialogs, input, output, request, responses, writes, dialog, setSession: (value: string) => { sessionId = value; }, session: () => sessionId };
}

test("confirm exposes the complete dialog and writes the exact standard response", async t => {
  const f = fixture(t);
  const started = Date.now();
  f.request({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Deploy?", message: "Complete untruncated preview", timeout: 10_000 });

  const dialog = await f.dialog();
  assert.equal(dialog.id, "confirm-1");
  assert.equal(dialog.method, "confirm");
  assert.equal(dialog.title, "Deploy?");
  assert.equal(dialog.message, "Complete untruncated preview");
  assert.ok(dialog.deadline >= started && dialog.deadline <= started + 10_500);

  assert.deepEqual(await f.dialogs.respond(f.session(), { id: "confirm-1", decisionId: "decision-confirm-1", confirmed: true }), { state: "delivered" });
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "confirm-1", confirmed: true }]);
});

test("select rejects a value outside the literal source options", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["alpha", "beta"] });
  await f.dialog();

  await assert.rejects(
    f.dialogs.respond(f.session(), { id: "select-1", decisionId: "decision-select-1", value: "gamma" }),
    error => status(error) === 400,
  );
  assert.deepEqual(f.responses(), []);
});

test("cancellation is delivered as cancellation and never converted to approval", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "confirm-cancel", method: "confirm", title: "Proceed", message: "No default approval" });
  await f.dialog();

  await f.dialogs.respond(f.session(), { id: "confirm-cancel", decisionId: "decision-cancel-1", cancelled: true });
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "confirm-cancel", cancelled: true }]);
});

test("byte framing preserves split multibyte UTF-8 and treats U+2028 as content", async t => {
  const f = fixture(t);
  const title = "before 界\u2028after";
  const frame = Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "input-utf8", method: "input", title, placeholder: "值" }) + "\n");
  const marker = Buffer.from("界");
  const split = frame.indexOf(marker) + 1;
  assert.ok(split > 0);

  f.output.write(frame.subarray(0, split));
  f.output.write(frame.subarray(split));

  const dialog = await f.dialog();
  assert.equal(dialog.title, title);
  assert.equal(dialog.placeholder, "值");
});

test("an oversized unrelated frame is discarded through LF and parsing recovers", async t => {
  const f = fixture(t);
  f.output.write(Buffer.alloc(256 * 1024 + 17, 120));
  f.output.write("\n");
  f.request({ type: "extension_ui_request", id: "editor-after-large", method: "editor", title: "Recovered", prefill: "body" });

  const dialog = await f.dialog();
  assert.equal(dialog.id, "editor-after-large");
  assert.equal(dialog.prefill, "body");
});

test("source timeout cancels the exact id and never sends approval", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "confirm-timeout", method: "confirm", title: "Expiring", message: "Do not approve", timeout: 25 });
  await f.dialog();

  await eventually(() => f.responses(), records => records.length === 1);
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "confirm-timeout", cancelled: true }]);
  assert.equal(await f.dialogs.snapshot(f.session()), null);
});

test("a changed source session rejects the answer and cancels stale pending ids", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "confirm-session", method: "confirm", title: "Bound", message: "Session A only" });
  await f.dialog();
  f.setSession("session-b");

  await assert.rejects(
    f.dialogs.respond("session-a", { id: "confirm-session", decisionId: "decision-session-1", confirmed: true }),
    error => status(error) === 409,
  );
  await eventually(() => f.responses(), records => records.length === 1);
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "confirm-session", cancelled: true }]);
});

test("a wrong caller session cannot cancel the prompt bound to the current source session", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "confirm-caller", method: "confirm", title: "Bound", message: "Session A remains authoritative" });
  await f.dialog();

  await assert.rejects(f.dialogs.snapshot("other-session"), error => status(error) === 409);
  await assert.rejects(
    f.dialogs.respond("other-session", { id: "confirm-caller", decisionId: "decision-wrong-caller", confirmed: true }),
    error => status(error) === 409,
  );
  assert.deepEqual(f.responses(), []);
  assert.equal((await f.dialogs.snapshot("session-a"))?.id, "confirm-caller");

  await f.dialogs.respond("session-a", { id: "confirm-caller", decisionId: "decision-correct-caller", confirmed: true });
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "confirm-caller", confirmed: true }]);
});

test("select admits 1 through 1000 literal options and rejects counts outside that range", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "select-empty", method: "select", title: "Empty", options: [] });
  f.request({ type: "extension_ui_request", id: "select-too-many", method: "select", title: "Too many", options: Array.from({ length: 1001 }, (_, index) => `option-${index}`) });
  await eventually(() => f.responses(), records => records.length === 2);
  assert.deepEqual(f.responses(), [
    { type: "extension_ui_response", id: "select-empty", cancelled: true },
    { type: "extension_ui_response", id: "select-too-many", cancelled: true },
  ]);

  const options = Array.from({ length: 1000 }, (_, index) => `value-${index}`);
  f.request({ type: "extension_ui_request", id: "select-max", method: "select", title: "Maximum", options });
  const dialog = await f.dialog();
  assert.deepEqual(dialog.options, options);
});

test("the serialized host prompt stays within 32 KiB after deadline is added", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "confirm-near-limit", method: "confirm", title: "Large", message: "x".repeat(32_500) });

  const dialog = await f.dialog();
  assert.ok(Buffer.byteLength(JSON.stringify(dialog), "utf8") <= 32 * 1024);
  assert.equal(dialog.message?.length, 32_500);
});

test("duplicate or conflicting submissions reserve one decision and write once", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "input-once", method: "input", title: "One answer", placeholder: "value" });
  await f.dialog();

  const first = f.dialogs.respond(f.session(), { id: "input-once", decisionId: "decision-once-1", value: "first" });
  await assert.rejects(
    f.dialogs.respond(f.session(), { id: "input-once", decisionId: "decision-once-2", value: "second" }),
    error => status(error) === 409,
  );
  assert.deepEqual(await first, { state: "delivered" });
  assert.deepEqual(f.responses(), [{ type: "extension_ui_response", id: "input-once", value: "first" }]);

  await assert.rejects(
    f.dialogs.respond(f.session(), { id: "input-once", decisionId: "decision-once-1", value: "first" }),
    error => status(error) === 409,
  );
  assert.equal(f.responses().length, 1);
});

test("unrecognized protocol messages and custom UI requests are never exposed", async t => {
  const f = fixture(t);
  f.request({ type: "message_update", message: { role: "assistant", content: "private" } });
  f.request({ type: "extension_ui_request", id: "custom-1", method: "custom", title: "Unsupported" });
  f.request({ type: "extension_ui_notification", message: "fire-and-forget" });

  assert.equal(await f.dialogs.snapshot(f.session()), null);
  assert.deepEqual(f.responses(), []);
});

test("malformed answers, extra keys, and oversized UTF-8 values fail with 400", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "editor-validation", method: "editor", title: "Edit", prefill: "initial" });
  await f.dialog();

  const invalidBodies = [
    { id: "editor-validation", decisionId: "decision-extra", value: "ok", extra: true },
    { id: "editor-validation", decisionId: "decision-two-answers", value: "ok", cancelled: true },
    { id: "editor-validation", decisionId: "unsafe decision", value: "ok" },
    { id: "editor-validation", decisionId: "decision-large", value: "界".repeat(1366) },
  ];
  for (const body of invalidBodies) {
    await assert.rejects(f.dialogs.respond(f.session(), body), error => status(error) === 400);
  }
  assert.deepEqual(f.responses(), []);
});

test("close cancels every visible prompt, clears memory, and detaches stream handlers", async t => {
  const f = fixture(t);
  f.request({ type: "extension_ui_request", id: "close-1", method: "confirm", title: "First", message: "first" });
  await f.dialog();
  f.request({ type: "extension_ui_request", id: "close-2", method: "input", title: "Second" });
  await eventually(() => f.writes.filter(record => record.type === "get_state").length, count => count >= 3);
  await pause(5);

  f.dialogs.close();

  await eventually(() => f.responses(), records => records.length === 2);
  assert.deepEqual(f.responses(), [
    { type: "extension_ui_response", id: "close-1", cancelled: true },
    { type: "extension_ui_response", id: "close-2", cancelled: true },
  ]);
  await assert.rejects(f.dialogs.snapshot(f.session()), error => status(error) === 409);
  assert.equal(f.output.listenerCount("data"), 0);
  assert.equal(f.output.listenerCount("error"), 0);
  assert.equal(f.output.listenerCount("end"), 0);
});

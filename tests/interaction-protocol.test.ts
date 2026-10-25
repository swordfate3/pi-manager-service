import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  createInteractionRequest,
  publicInteraction,
  validateAnswer,
  validateInteractionRequest,
} from "../protocol/interactions/protocol.ts";

const identity = { runId: "a".repeat(32), generation: "b".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" };
const adapter = { id: "scoped-memory", version: "1.0.0", packageName: "pi-scoped-memory" };
const source = () => ({
  action: "write", revision: "prepared-17", classification: "sensitive" as const,
  method: "confirm" as const, schema: { kind: "confirm" as const },
  content: { title: "Write memory", preview: "exact private text", scope: "/workspace/project-a" },
  deadline: 500_000,
});
const make = () => createInteractionRequest(identity, adapter, source(), 1000);

test("complete semantic digest ignores object ordering but binds scope and exact preview", () => {
  const first = make();
  const reordered = validateInteractionRequest(Object.fromEntries(Object.entries(first).reverse()));
  assert.equal(reordered.digest, first.digest);
  assert.equal(canonicalJson({ z: [1, true], a: "中文" }), '{"a":"中文","z":[1,true]}');
  const modified = structuredClone(first);
  modified.content.preview = "a different operation";
  assert.throws(() => validateInteractionRequest(modified), /Invalid interaction/);
  assert.notEqual(createInteractionRequest(identity, adapter, { ...source(), content: { scope: "global" } }, 1000).digest, first.digest);
});

test("source deadlines are clamped and expired or nonfinite inputs fail closed", () => {
  assert.equal(make().deadline, 121_000);
  assert.equal(createInteractionRequest(identity, adapter, { ...source(), deadline: 1200 }, 1000).deadline, 1200);
  assert.equal(createInteractionRequest(identity, adapter, { ...source(), method: "input", schema: { kind: "text", maxBytes: 1024 }, purpose: "oauth", deadline: 900_000 }, 1000).deadline, 601_000);
  for (const deadline of [1000, NaN, Infinity, -1]) assert.throws(() => createInteractionRequest(identity, adapter, { ...source(), deadline }, 1000));
});

test("full UTF-8 request is bounded without truncating an authorization preview", () => {
  assert.throws(() => createInteractionRequest(identity, adapter, { ...source(), content: { preview: "中".repeat(23_000) } }, 1000), /Invalid interaction/);
  assert.equal(make().content.preview, "exact private text");
});

test("unknown fields, custom prototypes, non-JSON values and excessive nesting are rejected", () => {
  for (const change of [
    { ...make(), approved: true },
    { ...make(), identity: { ...identity, sessionId: "" } },
    { ...make(), content: new Date() },
    { ...make(), content: { dangerous: undefined } },
    { ...make(), content: { dangerous: Number.NaN } },
    { ...make(), content: JSON.parse('{"__proto__":{"approved":true}}') },
  ]) assert.throws(() => validateInteractionRequest(change), /Invalid interaction/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /Invalid interaction/);
});

test("sensitive public projection cannot carry preview, digest, schema or OAuth material", () => {
  const request = make();
  assert.deepEqual(publicInteraction(request, "pending"), {
    requestId: request.requestId, adapterId: "scoped-memory", action: "write",
    classification: "sensitive", state: "pending", deadline: 121_000,
  });
  const serialized = JSON.stringify(publicInteraction(request, "pending"));
  for (const secret of ["exact private text", "/workspace/project-a", "prepared-17", request.digest]) assert.ok(!serialized.includes(secret));
});

test("responses are checked against exact source choice schema without coercion", () => {
  assert.equal(validateAnswer({ kind: "confirm" }, false), false);
  for (const value of ["true", 1, null, { approved: true }]) assert.throws(() => validateAnswer({ kind: "confirm" }, value));
  assert.equal(validateAnswer({ kind: "select", options: ["profile-a", "profile-b"] }, "profile-b"), "profile-b");
  assert.throws(() => validateAnswer({ kind: "select", options: ["profile-a"] }, "profile-c"));
  assert.throws(() => validateAnswer({ kind: "text", maxBytes: 3 }, "中文"));
});

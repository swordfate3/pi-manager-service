import { createHash, randomBytes } from "node:crypto";
import { isHubGeneration } from "../hub-generation.ts";

export const INTERACTION_PROTOCOL = "pi-web-interactions-v1";
export const INTERACTION_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  pendingPerPi: 8,
  pendingPerHub: 64,
  hubBytes: 4 * 1024 * 1024,
  confirmationMs: 120_000,
  oauthMs: 600_000,
  completedCount: 128,
  completedMs: 300_000,
  completedBytes: 256 * 1024,
  panelItems: 100,
});
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type InteractionIdentity = { runId: string; generation: string; runtimeId: string; sessionId: string };
export type InteractionRegistration = { protocol: typeof INTERACTION_PROTOCOL; runtimeId: string; sessionId: string };
export type AdapterIdentity = { id: string; version: string; packageName: string };
export type ResponseSchema =
  | { kind: "confirm" }
  | { kind: "select"; options: string[] }
  | { kind: "text"; maxBytes: number };
export type InteractionState =
  | "pending"
  | "delivering"
  | "allowed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "stale"
  | "delivery_unknown";
export type InteractionSpec = {
  action: string;
  revision: string;
  classification: "session" | "sensitive";
  method: "confirm" | "select" | "input" | "editor";
  schema: ResponseSchema;
  purpose?: "oauth";
  content: Record<string, Json>;
  deadline: number;
};
export type InteractionRequest = InteractionSpec & {
  protocol: typeof INTERACTION_PROTOCOL;
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  identity: InteractionIdentity;
  adapter: AdapterIdentity;
  createdAt: number;
  digest: string;
};
export type InteractionAnswer = boolean | string;

export function invalidInteraction(): never {
  throw new Error("Invalid interaction");
}
export function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
export function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalidInteraction();
}
export function safeLabel(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}
export function opaqueId(value: unknown, length = 32): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}
export function validateIdentity(value: unknown): asserts value is InteractionIdentity {
  if (!plainRecord(value)) invalidInteraction();
  exactKeys(value, ["runId", "generation", "runtimeId", "sessionId"]);
  if (
    !opaqueId(value.runId) ||
    !isHubGeneration(value.generation) ||
    !safeLabel(value.runtimeId) ||
    !safeLabel(value.sessionId)
  )
    invalidInteraction();
}
export function readInteractionRegistration(value: unknown): InteractionRegistration | undefined {
  if (value === undefined) return undefined;
  canonicalJson(value);
  if (!plainRecord(value)) invalidInteraction();
  exactKeys(value, ["protocol", "runtimeId", "sessionId"]);
  if (value.protocol !== INTERACTION_PROTOCOL || !safeLabel(value.runtimeId) || !safeLabel(value.sessionId))
    invalidInteraction();
  return { protocol: INTERACTION_PROTOCOL, runtimeId: value.runtimeId, sessionId: value.sessionId };
}
export function validateAdapter(value: unknown): asserts value is AdapterIdentity {
  if (!plainRecord(value)) invalidInteraction();
  exactKeys(value, ["id", "version", "packageName"]);
  if (
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) ||
    !safeLabel(value.version, 64) ||
    !safeLabel(value.packageName, 128)
  )
    invalidInteraction();
}

/** Strict JSON only. Never invoke toJSON/getters or silently omit undefined fields. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  let budget = INTERACTION_LIMITS.requestBytes;
  const consume = (text: string) => {
    budget -= Buffer.byteLength(text);
    if (budget < 0) invalidInteraction();
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 32) invalidInteraction();
    if (item === null || typeof item === "boolean") return consume(String(item));
    if (typeof item === "string") return consume(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item)) return consume(JSON.stringify(item));
    if (typeof item !== "object" || item === null || seen.has(item)) invalidInteraction();
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Sparse arrays and non-index properties are not JSON protocol values.
      if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length) invalidInteraction();
      const parts = Array.from({ length: item.length }, (_, i) => {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !("value" in property)) invalidInteraction();
        return visit(property.value, depth + 1);
      });
      budget -= Math.max(0, parts.length - 1);
      result = consume("[") + parts.join(",") + consume("]");
    } else {
      if (!plainRecord(item) || Object.getOwnPropertySymbols(item).length) invalidInteraction();
      const keys = Object.keys(item).sort();
      const parts = keys.map((key) => {
        if (["__proto__", "constructor", "prototype"].includes(key)) invalidInteraction();
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !("value" in property)) invalidInteraction();
        return consume(JSON.stringify(key)) + consume(":") + visit(property.value, depth + 1);
      });
      budget -= Math.max(0, parts.length - 1);
      result = consume("{") + parts.join(",") + consume("}");
    }
    seen.delete(item);
    if (budget < 0) invalidInteraction();
    return result;
  };
  return visit(value, 0);
}

export const contentDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function validateSchema(value: unknown): asserts value is ResponseSchema {
  if (!plainRecord(value)) invalidInteraction();
  if (value.kind === "confirm") exactKeys(value, ["kind"]);
  else if (value.kind === "select") {
    exactKeys(value, ["kind", "options"]);
    if (
      !Array.isArray(value.options) ||
      value.options.length < 1 ||
      value.options.length > 100 ||
      value.options.some((option) => !safeLabel(option, 512)) ||
      new Set(value.options).size !== value.options.length
    )
      invalidInteraction();
  } else if (value.kind === "text") {
    exactKeys(value, ["kind", "maxBytes"]);
    if (!Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > 32 * 1024)
      invalidInteraction();
  } else invalidInteraction();
}

export function validateAnswer(schema: ResponseSchema, answer: unknown): InteractionAnswer {
  validateSchema(schema);
  if (schema.kind === "confirm" && typeof answer === "boolean") return answer;
  if (schema.kind === "select" && typeof answer === "string" && schema.options.includes(answer)) return answer;
  if (schema.kind === "text" && typeof answer === "string" && Buffer.byteLength(answer) <= schema.maxBytes)
    return answer;
  return invalidInteraction();
}

function validateSpec(spec: InteractionSpec, createdAt: number) {
  if (
    !safeLabel(spec.action, 64) ||
    !/^[a-z][a-z0-9_.-]*$/.test(spec.action) ||
    !safeLabel(spec.revision, 256) ||
    !["session", "sensitive"].includes(spec.classification) ||
    !["confirm", "select", "input", "editor"].includes(spec.method)
  )
    invalidInteraction();
  validateSchema(spec.schema);
  if (
    (spec.method === "confirm") !== (spec.schema.kind === "confirm") ||
    (spec.method === "select") !== (spec.schema.kind === "select")
  )
    invalidInteraction();
  if (
    !plainRecord(spec.content) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(spec.deadline) ||
    spec.deadline <= createdAt ||
    (spec.purpose !== undefined && spec.purpose !== "oauth")
  )
    invalidInteraction();
  if (
    spec.deadline - createdAt >
    (spec.purpose === "oauth" ? INTERACTION_LIMITS.oauthMs : INTERACTION_LIMITS.confirmationMs)
  )
    invalidInteraction();
}

export function createInteractionRequest(
  identity: InteractionIdentity,
  adapter: AdapterIdentity,
  spec: InteractionSpec,
  now = Date.now(),
  operationId = randomBytes(16).toString("hex"),
): InteractionRequest {
  // Validate before JSON cloning: JSON.stringify would hide invalid source input.
  canonicalJson(spec);
  const deadline = Math.min(
    spec.deadline,
    now + (spec.purpose === "oauth" ? INTERACTION_LIMITS.oauthMs : INTERACTION_LIMITS.confirmationMs),
  );
  const body = {
    ...spec,
    deadline,
    protocol: INTERACTION_PROTOCOL,
    schemaVersion: 1,
    requestId: randomBytes(16).toString("hex"),
    operationId,
    identity,
    adapter,
    createdAt: now,
  };
  const request = { ...body, digest: contentDigest(body) };
  return validateInteractionRequest(request);
}

export function validateInteractionRequest(value: unknown): InteractionRequest {
  const serialized = canonicalJson(value);
  if (!plainRecord(value)) invalidInteraction();
  exactKeys(
    value,
    [
      "protocol",
      "schemaVersion",
      "requestId",
      "operationId",
      "identity",
      "adapter",
      "createdAt",
      "digest",
      "action",
      "revision",
      "classification",
      "method",
      "schema",
      "content",
      "deadline",
    ],
    ["purpose"],
  );
  if (
    value.protocol !== INTERACTION_PROTOCOL ||
    value.schemaVersion !== 1 ||
    !opaqueId(value.requestId) ||
    !opaqueId(value.operationId) ||
    !opaqueId(value.digest, 64)
  )
    invalidInteraction();
  validateIdentity(value.identity);
  validateAdapter(value.adapter);
  validateSpec(value as InteractionRequest, value.createdAt as number);
  const { digest, ...body } = value;
  if (contentDigest(body) !== digest) invalidInteraction();
  // Return an independent JSON value: consumers cannot mutate source state by alias.
  return JSON.parse(serialized) as InteractionRequest;
}

export function publicInteraction(request: InteractionRequest, state: InteractionState) {
  const notice = {
    requestId: request.requestId,
    adapterId: request.adapter.id,
    action: request.action,
    classification: request.classification,
    state,
    deadline: request.deadline,
  };
  return request.classification === "sensitive" ? notice : { ...notice, request: structuredClone(request) };
}

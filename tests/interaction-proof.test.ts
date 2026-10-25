import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { signInteractionEvidence, verifyInteractionEvidence } from "../protocol/interactions/proof.ts";

const pair = generateKeyPairSync("ed25519");
const identity = { runId: "a".repeat(32), generation: "b".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" };
const claim = () => ({
  protocol: "pi-web-interactions-v1" as const, audience: "pi-interaction-broker" as const,
  kind: "decision" as const, identity, issuer: "hub-key-1", epoch: "c".repeat(32),
  challenge: "d".repeat(64), issuedAt: 1000, expiresAt: 2000,
  payload: { requestId: "e".repeat(32), operationId: "f".repeat(32), adapterId: "memory", adapterVersion: "1.0.0", revision: "rev-1", digest: "1".repeat(64), decisionId: "2".repeat(32), answer: true },
});
const verify = (evidence: unknown) => verifyInteractionEvidence(evidence, { publicKey: pair.publicKey, issuer: "hub-key-1", identity, challenge: "d".repeat(64), epoch: "c".repeat(32), kind: "decision", now: 1500 });

test("only independently verifiable asymmetric evidence is accepted", () => {
  const signed = signInteractionEvidence(pair.privateKey, claim());
  assert.equal(verify(signed).payload.answer, true);
  const fake = { ...signed, signature: randomBytes(64).toString("base64url") };
  assert.throws(() => verify(fake), /Untrusted interaction evidence/);
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => verify(signInteractionEvidence(other.privateKey, claim())));
});

test("identity, semantic fields, broker challenge, epoch and audience cannot be substituted", () => {
  for (const changed of [
    { ...claim(), identity: { ...identity, sessionId: "session-other" } },
    { ...claim(), epoch: "9".repeat(32) },
    { ...claim(), challenge: "8".repeat(64) },
    { ...claim(), issuer: "attacker" },
    { ...claim(), audience: "different-audience" },
  ]) assert.throws(() => verify(signInteractionEvidence(pair.privateKey, changed as ReturnType<typeof claim>)));
  const signed = signInteractionEvidence(pair.privateKey, claim());
  for (const key of ["revision", "digest", "adapterId", "decisionId"] as const) {
    const changed = structuredClone(signed);
    changed.claim.payload[key] = "substitution";
    assert.throws(() => verify(changed));
  }
});

test("expired, future-dated, excessive lifetime, extra-field and oversized evidence is rejected", () => {
  for (const changed of [
    { ...claim(), expiresAt: 1500 }, { ...claim(), issuedAt: 1501 },
    { ...claim(), expiresAt: 700_000 }, { ...claim(), unexpected: true },
    { ...claim(), payload: { text: "中".repeat(23_000) } },
  ]) assert.throws(() => verify(signInteractionEvidence(pair.privateKey, changed as ReturnType<typeof claim>)));
});

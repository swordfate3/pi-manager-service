import { type KeyObject, sign, verify } from "node:crypto";
import {
  canonicalJson,
  exactKeys,
  INTERACTION_PROTOCOL,
  type InteractionIdentity,
  type Json,
  opaqueId,
  plainRecord,
  safeLabel,
  validateIdentity,
} from "./protocol.ts";

export type InteractionClaim = {
  protocol: typeof INTERACTION_PROTOCOL;
  audience: "pi-interaction-broker";
  kind: "control" | "read" | "decision";
  identity: InteractionIdentity;
  issuer: string;
  epoch: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  payload: Record<string, Json>;
};
export type InteractionEvidence = { claim: InteractionClaim; signature: string };
const untrusted = (): never => {
  throw new Error("Untrusted interaction evidence");
};

export function signInteractionEvidence(privateKey: KeyObject | string, claim: InteractionClaim): InteractionEvidence {
  const serialized = canonicalJson(claim);
  return {
    claim: JSON.parse(serialized),
    signature: sign(null, Buffer.from(serialized), privateKey).toString("base64url"),
  };
}

export function verifyInteractionEvidence(
  evidence: unknown,
  expected: {
    publicKey: KeyObject | string;
    issuer: string;
    identity: InteractionIdentity;
    challenge: string;
    epoch?: string;
    kind: InteractionClaim["kind"];
    now: number;
  },
): InteractionClaim {
  try {
    // Size-check the whole frame, including signature, before signature work.
    canonicalJson(evidence);
    if (!plainRecord(evidence)) return untrusted();
    exactKeys(evidence, ["claim", "signature"]);
    const claim = evidence.claim;
    if (
      !plainRecord(claim) ||
      typeof evidence.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(evidence.signature)
    )
      return untrusted();
    exactKeys(claim, [
      "protocol",
      "audience",
      "kind",
      "identity",
      "issuer",
      "epoch",
      "challenge",
      "issuedAt",
      "expiresAt",
      "payload",
    ]);
    validateIdentity(claim.identity);
    if (
      claim.protocol !== INTERACTION_PROTOCOL ||
      claim.audience !== "pi-interaction-broker" ||
      claim.kind !== expected.kind ||
      claim.issuer !== expected.issuer ||
      !safeLabel(claim.issuer, 128) ||
      !opaqueId(claim.epoch) ||
      (expected.epoch !== undefined && claim.epoch !== expected.epoch) ||
      claim.challenge !== expected.challenge ||
      !opaqueId(claim.challenge, 64) ||
      canonicalJson(claim.identity) !== canonicalJson(expected.identity) ||
      !Number.isSafeInteger(claim.issuedAt) ||
      !Number.isSafeInteger(claim.expiresAt) ||
      Number(claim.issuedAt) > expected.now ||
      Number(claim.expiresAt) <= expected.now ||
      Number(claim.expiresAt) <= Number(claim.issuedAt) ||
      Number(claim.expiresAt) - Number(claim.issuedAt) > 30_000 ||
      !plainRecord(claim.payload)
    )
      return untrusted();
    if (
      !verify(null, Buffer.from(canonicalJson(claim)), expected.publicKey, Buffer.from(evidence.signature, "base64url"))
    )
      return untrusted();
    return JSON.parse(canonicalJson(claim)) as InteractionClaim;
  } catch {
    return untrusted();
  }
}

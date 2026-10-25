import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { type InteractionPin, validateInteractionPin } from "../protocol/interactions/enrollment.ts";
import { type InteractionClaim, signInteractionEvidence } from "../protocol/interactions/proof.ts";
import { INTERACTION_PROTOCOL } from "../protocol/interactions/protocol.ts";
import type { HubConfig } from "./config.ts";
import { readStateJson, withStateWriter } from "./state-budget.ts";

export function interactionSigning(config: HubConfig) {
  if (!config.management) throw new Error("Interaction management is not configured");
  const stored = withStateWriter(config, (writer) => {
    const file = path.join(config.stateDir, "interaction-signing.json");
    if (!existsSync(file)) {
      const pair = generateKeyPairSync("ed25519");
      writer.write(
        "interaction-signing.json",
        {
          schema: 1,
          privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        { exclusive: true },
      );
    }
    return readStateJson(file) as { schema: unknown; privateKey: string; publicKey: string };
  });
  if (stored.schema !== 1 || Object.keys(stored).sort().join(",") !== "privateKey,publicKey,schema")
    throw new Error("Interaction signing unavailable");
  const privateKey = createPrivateKey(stored.privateKey);
  const publicKey = createPublicKey(privateKey);
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.export({ type: "spki", format: "pem" }).toString() !== stored.publicKey
  )
    throw new Error("Interaction signing unavailable");
  const pin: InteractionPin = validateInteractionPin({
    protocol: INTERACTION_PROTOCOL,
    issuer: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    publicKey: stored.publicKey,
    ...(config.management.publicUrl ? { managementOrigin: new URL(config.management.publicUrl).origin } : {}),
  });
  const epoch = randomBytes(16).toString("hex");
  return {
    pin,
    epoch,
    sign: (claim: Omit<InteractionClaim, "issuer" | "epoch" | "protocol" | "audience">) =>
      signInteractionEvidence(privateKey, {
        ...claim,
        protocol: INTERACTION_PROTOCOL,
        audience: "pi-interaction-broker",
        issuer: pin.issuer,
        epoch,
      }),
  };
}
export type InteractionSigning = ReturnType<typeof interactionSigning>;

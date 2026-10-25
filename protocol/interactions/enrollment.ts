import { createHash, createPublicKey } from "node:crypto";
import { exactKeys, INTERACTION_PROTOCOL, opaqueId, plainRecord } from "./protocol.ts";

export type InteractionPin = {
  protocol: typeof INTERACTION_PROTOCOL;
  issuer: string;
  publicKey: string;
  managementOrigin?: string;
};

/** Public authority only. This value must come from host-owned per-run enrollment. */
export function validateInteractionPin(value: unknown): InteractionPin {
  try {
    if (!plainRecord(value)) throw new Error();
    exactKeys(value, ["protocol", "issuer", "publicKey"], ["managementOrigin"]);
    if (
      value.protocol !== INTERACTION_PROTOCOL ||
      !opaqueId(value.issuer, 64) ||
      typeof value.publicKey !== "string" ||
      value.publicKey.length > 1024
    )
      throw new Error();
    const key = createPublicKey(value.publicKey);
    const encoded = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || createHash("sha256").update(encoded).digest("hex") !== value.issuer)
      throw new Error();
    if (value.managementOrigin !== undefined) {
      if (typeof value.managementOrigin !== "string") throw new Error();
      const url = new URL(value.managementOrigin);
      if (
        url.origin !== value.managementOrigin ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
      )
        throw new Error();
    }
    return {
      protocol: INTERACTION_PROTOCOL,
      issuer: value.issuer,
      publicKey: key.export({ type: "spki", format: "pem" }).toString(),
      ...(value.managementOrigin === undefined ? {} : { managementOrigin: value.managementOrigin }),
    };
  } catch {
    throw new Error("Invalid interaction authority enrollment");
  }
}

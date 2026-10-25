import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type HubConfig, readPrivateJson } from "./config.ts";

/** Gateway proof is server-to-server only; never accept a browser identity header by itself. */
export function gatewayIdentity(config: HubConfig, request: IncomingMessage): string | undefined {
  const gateway = config.management?.gateway;
  if (!gateway) return undefined;
  try {
    const value = readPrivateJson(gateway.credentialFile);
    const proof = request.headers["x-pi-hub-gateway"];
    const user = request.headers["x-pi-hub-user"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).join(",") !== "token" ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof proof !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof) ||
      typeof user !== "string" ||
      !/^[\p{L}\p{N}_.@+-]{1,128}$/u.test(user) ||
      !timingSafeEqual(Buffer.from(proof), Buffer.from(value.token))
    )
      return undefined;
    // Bind browser sessions to both the authenticated user and current gateway credential.
    return createHash("sha256").update(`${proof}\0${user}`).digest("hex");
  } catch {
    return undefined;
  }
}

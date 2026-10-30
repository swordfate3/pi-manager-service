import { createHmac, timingSafeEqual } from "node:crypto";
import { type Grant, type HubConfig, readGrant } from "./config.ts";

const domain = "pi-web-runtime-reconnect-v1:";
const signature = (grant: Grant, payload: string) =>
  createHmac("sha256", grant.token).update(domain + payload).digest("hex");

/** A browser may return to this exact Pi runtime after sleep or a Hub restart.
 * No retained browser records or sliding deadlines: the existing run grant and
 * live runtime identity remain the authority, never an old generation URL.
 */
export function browserReconnect(grant: Grant, runtimeId: string | undefined): string | undefined {
  if (!runtimeId || runtimeId.length > 256 || /\p{Cc}/u.test(runtimeId)) return undefined;
  const payload = Buffer.from(JSON.stringify([grant.run_id, runtimeId])).toString("base64url");
  return `${payload}.${signature(grant, payload)}`;
}

export function readBrowserReconnect(config: HubConfig, value: unknown) {
  if (typeof value !== "string" || value.length > 1536 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value))
    return undefined;
  try {
    const [payload, supplied] = value.split(".");
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return undefined;
    const identity = JSON.parse(decoded.toString("utf8"));
    if (
      !Array.isArray(identity) || identity.length !== 2 ||
      typeof identity[0] !== "string" || !/^[a-f0-9]{32}$/.test(identity[0]) ||
      typeof identity[1] !== "string" || !identity[1] || identity[1].length > 256 || /\p{Cc}/u.test(identity[1])
    ) return undefined;
    const grant = readGrant(config, identity[0]);
    if (grant.revoked || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(grant, payload), "hex")))
      return undefined;
    return { grant, runtimeId: identity[1] as string };
  } catch {
    return undefined;
  }
}

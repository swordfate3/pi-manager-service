// Shared syntax only. Membership, credentials, boot and live authority are
// checked by the Hub; a syntactically valid generation grants no authority.
export const BOUNDED_PROTOCOL = "bounded-v2";
export const BOUNDED_GENERATION_SOURCE = "b2-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}";
export const HUB_GENERATION_SOURCE = `(?:[a-f0-9]{32}|${BOUNDED_GENERATION_SOURCE})`;
const bounded = new RegExp(`^${BOUNDED_GENERATION_SOURCE}$`);
const generation = new RegExp(`^${HUB_GENERATION_SOURCE}$`);
const sessionPath = new RegExp(`^/s/${HUB_GENERATION_SOURCE}/$`);
export const isBoundedGeneration = (value: unknown): value is string =>
  typeof value === "string" && bounded.test(value);
export const isHubGeneration = (value: unknown): value is string => typeof value === "string" && generation.test(value);
export const isHubSessionPath = (value: unknown): value is string =>
  typeof value === "string" && sessionPath.test(value);

import { createHash, timingSafeEqual } from "node:crypto";

export class ManagerError extends Error {
  readonly status: number;
  constructor(status: number) { super(({ 400: "Invalid request", 401: "Authentication required", 403: "Forbidden", 404: "Not found", 409: "Conflict; review current task", 413: "Request too large", 503: "Capability unavailable" } as Record<number, string>)[status] ?? "Service unavailable"); this.status = status; }
}
export function requireThat(condition: unknown, status = 400): asserts condition { if (!condition) throw new ManagerError(status); }
export function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  requireThat(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)));
}
export function identifier(value: unknown): string { requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)); return value; }
export function taskId(value: unknown): string { requireThat(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)); return value; }
export function revision(value: unknown): number { requireThat(Number.isSafeInteger(value) && (value as number) > 0); return value as number; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function token(value: unknown): string { requireThat(typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value), 401); return value; }
export function equalHash(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

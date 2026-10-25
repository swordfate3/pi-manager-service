import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { isBoundedGeneration } from "../protocol/hub-generation.ts";
import { type HubConfig, readPrivateJson } from "./config.ts";
import type { StateWriter } from "./state-budget.ts";

const ZERO = "0000000000000000";
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
export class RegistryError extends Error {
  code: string;
  constructor(code = "ENDED_GENERATION") {
    super(code === "ENDED_GENERATION" ? "ended generation" : "Registration rejected");
    this.code = code;
  }
}
type Tuple = { generation: string; port: number; request_id: string; expires: number };
export type BoundedRecord = {
  schema: 2;
  run_id: string;
  boot: string;
  slot: string;
  revision: number;
  current?: Tuple;
  pending?: Tuple;
};
const relative = (runId: string) => {
  if (!hex(runId, 32)) throw new RegistryError("AUTH_FAILED");
  return `bounded/${runId}.json`;
};
export const hasBoundedRecord = (config: HubConfig, runId: string) =>
  existsSync(path.join(config.stateDir, relative(runId)));

export function boundedRecord(config: HubConfig, runId: string, boot: string): BoundedRecord {
  const file = path.join(config.stateDir, relative(runId));
  if (!existsSync(file)) return { schema: 2, run_id: runId, boot, slot: ZERO, revision: 0 };
  const value = readPrivateJson(file);
  if (
    value.schema !== 2 ||
    value.run_id !== runId ||
    !hex(value.boot, 32) ||
    !hex(value.slot, 16) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new RegistryError("STATE_UNAVAILABLE");
  for (const tuple of [value.current, value.pending]) {
    if (tuple === undefined) continue;
    if (
      !isBoundedGeneration(tuple.generation) ||
      !tuple.generation.startsWith(`b2-${value.boot}-`) ||
      tuple.generation.split("-")[2] > value.slot ||
      !hex(tuple.request_id, 32) ||
      !Number.isInteger(tuple.port) ||
      tuple.port < 1 ||
      tuple.port > 65535 ||
      !Number.isSafeInteger(tuple.expires)
    )
      throw new RegistryError("STATE_UNAVAILABLE");
  }
  // A fresh serving boot never restores stored live or pending authority.
  return value.boot === boot ? value : { schema: 2, run_id: runId, boot, slot: ZERO, revision: 0 };
}

export function saveBounded(writer: StateWriter, record: BoundedRecord, security = false) {
  if (!Number.isSafeInteger(record.revision + 1)) throw new RegistryError("STATE_UNAVAILABLE");
  record.revision++;
  writer.write(relative(record.run_id), record, { security });
}

export function issueBounded(
  writer: StateWriter,
  record: BoundedRecord,
  value: Record<string, unknown>,
  live: (generation: string) => boolean,
) {
  if (
    value.boot !== record.boot ||
    !hex(value.slot, 16) ||
    !hex(value.request_id, 32) ||
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535
  )
    throw new RegistryError("ISSUANCE_STALE");
  const now = Date.now();
  const result = (tuple: Tuple) => ({
    generation: tuple.generation,
    boot: record.boot,
    slot: tuple.generation.split("-")[2],
    expires: tuple.expires,
  });
  const pending = record.pending;
  // A retry is exact and never extends the original five-second deadline.
  if (
    pending?.request_id === value.request_id &&
    pending.port === value.port &&
    pending.expires > now &&
    BigInt(`0x${value.slot}`) + 1n === BigInt(`0x${record.slot}`)
  )
    return result(pending);
  if (value.slot !== record.slot) throw new RegistryError("ISSUANCE_STALE");
  if (pending && pending.expires > now) throw new RegistryError("REGISTRY_BUSY");
  if (record.slot === "ffffffffffffffff") throw new RegistryError("STATE_UNAVAILABLE");
  record.slot = (BigInt(`0x${record.slot}`) + 1n).toString(16).padStart(16, "0");
  record.pending = {
    generation: `b2-${record.boot}-${record.slot}-${randomBytes(16).toString("hex")}`,
    port: Number(value.port),
    request_id: value.request_id,
    expires: now + 5000,
  };
  if (record.current && !live(record.current.generation)) delete record.current;
  saveBounded(writer, record);
  return result(record.pending);
}

export function boundedTuple(record: BoundedRecord, generation: string, port: number, live: boolean) {
  if (record.pending?.generation === generation && record.pending.port === port && record.pending.expires > Date.now())
    return "pending";
  if (record.current?.generation === generation && record.current.port === port && live) return "current";
  throw new RegistryError();
}

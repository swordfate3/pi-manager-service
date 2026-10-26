import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_LIMITS } from "./archive.ts";
import { StageError } from "./errors.ts";

/** Administrator-only, persisted per private root. Bytes are logical regular-file lengths. */
export interface StagingQuota {
  readonly maxRetainedBytes: number;
  /** All filesystem nodes, including root, marker, locks, and incomplete directories. */
  readonly maxRetainedEntries: number;
  readonly maxCandidates: number;
}
export const DEFAULT_STAGING_QUOTA: StagingQuota = Object.freeze({
  maxRetainedBytes: 512 * 1024 * 1024, maxRetainedEntries: 100_000, maxCandidates: 8,
});
const ceiling: StagingQuota = Object.freeze({
  maxRetainedBytes: 16 * 1024 * 1024 * 1024, maxRetainedEntries: 200_000, maxCandidates: 128,
});
export const RECEIPT_BYTES = 1024 * 1024;
export const GLOBAL_WRITER = ".artifact-writer.lock";
export const ROOT_MARKER = ".artifact-staging-v1";
export const LEGACY_MARKER = "pi-manager private artifact staging v1\n";
const policyPrefix = "pi-manager private artifact staging quota v1\n";

/** Copy and freeze before any await; reject misspellings instead of silently disabling a bound. */
export function stagingQuota(value: unknown = {}, base: StagingQuota = DEFAULT_STAGING_QUOTA): StagingQuota {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(base, key))) throw new StageError("options-invalid");
  const result = { ...base };
  for (const key of Object.keys(base) as (keyof StagingQuota)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const limit = (value as Record<string, unknown>)[key];
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > ceiling[key]) throw new StageError("options-invalid");
    result[key] = limit;
  }
  return Object.freeze(result);
}
export function quotaMarker(quota: StagingQuota): string { return policyPrefix + JSON.stringify(quota) + "\n"; }
export function readQuotaMarker(text: string): StagingQuota {
  // Existing roots get conservative defaults, without rewriting/adopting any candidate or stale lock.
  if (text === LEGACY_MARKER) return DEFAULT_STAGING_QUOTA;
  if (!text.startsWith(policyPrefix)) throw new StageError("root-unsafe");
  try {
    const quota = stagingQuota(JSON.parse(text.slice(policyPrefix.length)));
    if (quotaMarker(quota) !== text) throw new Error(); // canonical, complete keys; no duplicates/aliases
    return quota;
  } catch { throw new StageError("root-unsafe"); }
}

/** Run ONLY under the root-wide exclusive lock. Never read file contents or materialize directory lists. */
export async function reserveCandidate(root: string, quota: StagingQuota): Promise<void> {
  let entries = 0, bytes = 0, candidates = 0;
  async function visit(target: string, depth: number): Promise<void> {
    if (++entries > quota.maxRetainedEntries || depth > ARCHIVE_LIMITS.depth + 2) throw new StageError("resource-limit");
    const info = await lstat(target);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new StageError("root-unsafe");
    if (info.isFile()) {
      if (!Number.isSafeInteger(info.size) || info.size < 0) throw new StageError("root-unsafe");
      bytes += info.size;
      if (bytes > quota.maxRetainedBytes) throw new StageError("resource-limit");
      return;
    }
    if (depth === 2 && ++candidates > quota.maxCandidates) throw new StageError("resource-limit");
    const dir = await opendir(target, { bufferSize: 1 });
    try {
      for (;;) {
        const entry = await dir.read();
        if (!entry) break;
        if (depth === 0) {
          const control = entry.name === ROOT_MARKER || entry.name === GLOBAL_WRITER || /^\.[a-f0-9]{64}\.lock$/.test(entry.name);
          if (control ? !entry.isFile() : !/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) throw new StageError("root-unsafe");
        } else if (depth === 1 && (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory())) throw new StageError("root-unsafe");
        await visit(path.join(target, entry.name), depth + 1);
      }
    } finally { await dir.close(); }
  }
  await visit(root, 0);
  // Single admitted writer owns this worst-case reservation through receipt fsync. The lock itself
  // survives process crashes; after explicit reconciliation, all remaining partial bytes/nodes count.
  if (candidates + 1 > quota.maxCandidates ||
    bytes + ARCHIVE_LIMITS.artifactBytes + ARCHIVE_LIMITS.treeBytes + RECEIPT_BYTES > quota.maxRetainedBytes ||
    entries + ARCHIVE_LIMITS.entries + 4 > quota.maxRetainedEntries) throw new StageError("resource-limit");
}

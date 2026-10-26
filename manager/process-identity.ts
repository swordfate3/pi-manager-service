import { readFileSync } from "node:fs";

/** Linux-only observation, never authority to adopt or signal a process. */
export function readProcessIdentity(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = content.lastIndexOf(")");
    if (end < 0) return null;
    const startTicks = content.slice(end + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const identity = `${bootId}:${startTicks}`;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(identity) ? identity : null;
  } catch {
    return null;
  }
}

export function matchesProcessIdentity(pid: number, identity: string | null): boolean {
  return identity !== null && readProcessIdentity(pid) === identity;
}

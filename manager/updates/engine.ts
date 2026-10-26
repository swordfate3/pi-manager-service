import { StageError } from "./errors.ts";
import { compareVersions, stableVersion } from "./release.ts";

/** Deliberately supported grammar: exact X.Y.Z or >=X.Y.Z, optionally followed by <X.Y.Z. */
export function checkNodeEngine(range: string, nodeVersion: string): void {
  const match = /^(>=)?([0-9]+\.[0-9]+\.[0-9]+)(?: <([0-9]+\.[0-9]+\.[0-9]+))?$/.exec(range);
  if (!match || !stableVersion(match[2]) || (match[3] && (!match[1] || !stableVersion(match[3]) || compareVersions(match[2], match[3]) >= 0)))
    throw new StageError("engine-unsupported");
  if (!stableVersion(nodeVersion) || (match[1] ? compareVersions(nodeVersion, match[2]) < 0 : compareVersions(nodeVersion, match[2]) !== 0) ||
    (match[3] && compareVersions(nodeVersion, match[3]) >= 0)) throw new StageError("node-incompatible");
}

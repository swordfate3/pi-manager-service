import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = "@kkkiio/pi-web-ui";

export type SoftwareMetadata = Readonly<{
  piVersion: string;
  webUi?: Readonly<{ version: string; build?: string }>;
}>;

function validSemver(value: unknown, stableOnly: boolean): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = (stableOnly ? STABLE_SEMVER : SEMVER).exec(value);
  if (!match) return false;
  if ([match[1], match[2], match[3]].some((part) => !Number.isSafeInteger(Number(part)))) return false;
  return !match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}

export function isStableSemver(value: unknown): value is string {
  return validSemver(value, true);
}

function isDisplayVersion(value: unknown): value is string {
  return validSemver(value, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/** Validate only bounded display metadata; this is never an authorization identity. */
export function readSoftwareMetadata(value: unknown): SoftwareMetadata | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, value.webUi === undefined ? ["piVersion"] : ["piVersion", "webUi"]) ||
    !isDisplayVersion(value.piVersion)
  )
    throw new Error("Invalid software metadata");
  const webUi = value.webUi;
  if (webUi === undefined) return Object.freeze({ piVersion: value.piVersion });
  if (!isRecord(webUi) || !hasExactKeys(webUi, webUi.build === undefined ? ["version"] : ["version", "build"]))
    throw new Error("Invalid software metadata");
  if (
    !isStableSemver(webUi.version) ||
    (webUi.build !== undefined && (typeof webUi.build !== "string" || !SHA256.test(webUi.build)))
  )
    throw new Error("Invalid software metadata");
  return Object.freeze({
    piVersion: value.piVersion,
    webUi: Object.freeze({ version: webUi.version, ...(webUi.build === undefined ? {} : { build: webUi.build }) }),
  });
}

function readBoundedJson(filePath: string, maxBytes: number): unknown {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Metadata file unavailable");
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function packageRoot(moduleUrl: string): string | undefined {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = readBoundedJson(path.join(directory, "package.json"), 32 * 1024);
      if (isRecord(manifest) && manifest.name === PACKAGE_NAME) return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Capture the installed Web UI package version and source fingerprint once when
 * the extension factory is initialized. A missing/invalid build manifest only
 * omits the build field; it never probes the filesystem during registration.
 */
export function captureSoftwareMetadata(piVersion: unknown, moduleUrl = import.meta.url): SoftwareMetadata | undefined {
  if (!isDisplayVersion(piVersion)) return undefined;
  const root = packageRoot(moduleUrl);
  if (!root) return Object.freeze({ piVersion });
  try {
    const manifest = readBoundedJson(path.join(root, "package.json"), 32 * 1024);
    if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME || !isStableSemver(manifest.version))
      return Object.freeze({ piVersion });
    let build: string | undefined;
    try {
      const buildManifest = readBoundedJson(path.join(root, "dist", "build-manifest.json"), 256 * 1024);
      const source = isRecord(buildManifest) ? buildManifest.source : undefined;
      if (isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) build = source.sha256;
    } catch {
      // Package version and Pi version remain useful when a build manifest is absent.
    }
    return readSoftwareMetadata({
      piVersion,
      webUi: { version: manifest.version, ...(build ? { build } : {}) },
    });
  } catch {
    return Object.freeze({ piVersion });
  }
}

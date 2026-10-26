import { createHash } from "node:crypto";
import { CatalogError } from "./errors.ts";
import { record } from "./json.ts";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const REGISTRY = "https://registry.npmjs.org/";
export interface ResolvedRelease {
  readonly packageName: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly nodeEngine: string;
  readonly identity: string;
}
export function stableVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
    && value.split(".").every(n => Number.isSafeInteger(Number(n)));
}
export function compareVersions(a: string, b: string): number {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}
export function approvedPackages(extensions: readonly string[] = []): ReadonlySet<string> {
  if (extensions.length > 100 || extensions.some(n => typeof n !== "string" || n.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(n))) throw new CatalogError("package-not-approved");
  return new Set([PI_PACKAGE, ...extensions]);
}
export function releaseFromMetadata(value: unknown, name: string, version: string): ResolvedRelease {
  const bad = (): never => { throw new CatalogError("metadata-invalid"); };
  if (!stableVersion(version) || !record(value) || value.name !== name || value.version !== version || !record(value.dist) || !record(value.engines)) return bad();
  const tarball = `${REGISTRY}${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
  const integrity = value.dist.integrity, nodeEngine = value.engines.node;
  if (value.dist.tarball !== tarball || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) return bad();
  const digest = Buffer.from(integrity.slice(7), "base64");
  if (digest.length !== 64 || digest.toString("base64") !== integrity.slice(7) || typeof nodeEngine !== "string" ||
    nodeEngine.length === 0 || nodeEngine.length > 256 || /[\x00-\x1f\x7f]/.test(nodeEngine)) return bad();
  const fields = { packageName: name, version, tarball, integrity, nodeEngine };
  const identity = createHash("sha256").update(JSON.stringify(["official-artifact-v1", name, version, tarball, integrity, nodeEngine])).digest("hex");
  return Object.freeze({ ...fields, identity });
}
/** Reconstruct rather than trusting structural TypeScript types, caller freezing, or caller hashes. */
export function validateRelease(value: unknown): ResolvedRelease {
  if (!record(value) || Object.keys(value).sort().join(",") !== "identity,integrity,nodeEngine,packageName,tarball,version" ||
    typeof value.packageName !== "string" || !stableVersion(value.version)) throw new CatalogError("metadata-invalid");
  const release = releaseFromMetadata({ name: value.packageName, version: value.version, dist: { tarball: value.tarball, integrity: value.integrity },
    engines: { node: value.nodeEngine } }, value.packageName, value.version);
  if (release.identity !== value.identity) throw new CatalogError("metadata-invalid");
  return release;
}

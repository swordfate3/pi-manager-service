import { createHash } from "node:crypto";
import { CatalogError } from "./errors.ts";
import { record, strictJson } from "./json.ts";
import { approvedPackages, compareVersions, REGISTRY, releaseFromMetadata, stableVersion, type ResolvedRelease } from "./release.ts";
import { boundedDownload, type OfficialTransport, TransportError } from "./transport.ts";
export { CatalogError } from "./errors.ts";
export { PI_PACKAGE, type ResolvedRelease } from "./release.ts";
export type { OfficialTransport } from "./transport.ts";

export interface CatalogPage {
  readonly status: "fresh" | "stale" | "unavailable";
  readonly versions: readonly string[];
  readonly checkedAt: number | null;
  readonly error?: "registry-unavailable";
  readonly nextCursor?: string;
}
interface Cache { versions?: readonly string[]; checkedAt: number | null; freshUntil: number; retryAt: number; pending?: Promise<void> }
export class ReleaseCatalog {
  readonly #packages: ReadonlySet<string>;
  readonly #transport?: OfficialTransport;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cache>();
  constructor(options: { readonly extensionPackages?: readonly string[]; readonly transport?: OfficialTransport; readonly now?: () => number } = {}) {
    this.#packages = approvedPackages(options.extensionPackages); this.#transport = options.transport; this.#now = options.now ?? Date.now;
  }
  #approved(name: string) { if (!this.#packages.has(name)) throw new CatalogError("package-not-approved"); }
  async #metadata(name: string, version?: string): Promise<unknown> {
    try { return strictJson(await boundedDownload(`${REGISTRY}${encodeURIComponent(name)}${version ? "/" + version : ""}`, 8 * 1024 * 1024, 8000, this.#transport)); }
    catch (error) { throw new CatalogError(error instanceof TransportError && ["unavailable", "timeout"].includes(error.code) ? "registry-unavailable" : "metadata-invalid"); }
  }
  async #refresh(name: string, cache: Cache): Promise<void> {
    if (cache.pending) return cache.pending;
    if (this.#now() < cache.retryAt) return;
    cache.pending = (async () => {
      try {
        const value = await this.#metadata(name);
        if (!record(value) || value.name !== name || !record(value.versions)) throw new CatalogError("metadata-invalid");
        const keys = Object.keys(value.versions);
        if (keys.length > 20000) throw new CatalogError("metadata-invalid");
        const versions = keys.filter(stableVersion).sort((a, b) => compareVersions(b, a));
        for (const version of versions) releaseFromMetadata(value.versions[version], name, version);
        cache.versions = Object.freeze(versions); cache.checkedAt = this.#now();
        cache.freshUntil = cache.checkedAt + 300_000; cache.retryAt = cache.freshUntil;
      } catch { cache.retryAt = this.#now() + 30_000; }
    })();
    try { await cache.pending; } finally { cache.pending = undefined; }
  }
  async list(name: string, options: { readonly query?: string; readonly cursor?: string; readonly limit?: number } = {}): Promise<CatalogPage> {
    this.#approved(name);
    const { query = "", cursor, limit = 50 } = options;
    if (typeof query !== "string" || query.length > 64 || !/^[0-9.]*$/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) throw new CatalogError("invalid-query");
    let cache = this.#cache.get(name);
    if (!cache) { cache = { checkedAt: null, freshUntil: 0, retryAt: 0 }; this.#cache.set(name, cache); }
    await this.#refresh(name, cache);
    if (!cache.versions) {
      if (cursor) throw new CatalogError("invalid-query");
      return Object.freeze({ status: "unavailable", versions: Object.freeze([]), checkedAt: null, error: "registry-unavailable" });
    }
    const matching = cache.versions.filter(v => v.startsWith(query));
    const tag = createHash("sha256").update(JSON.stringify([name, query, limit, cache.versions])).digest("hex");
    let offset = 0;
    if (cursor) {
      try {
        const raw = Buffer.from(cursor, "base64url");
        if (raw.toString("base64url") !== cursor) throw new Error();
        const parsed = strictJson(raw);
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== tag || !Number.isInteger(parsed[1]) || parsed[1] <= 0 || parsed[1] >= matching.length || parsed[1] % limit)
          throw new Error();
        offset = parsed[1];
      } catch { throw new CatalogError("invalid-query"); }
    }
    const fresh = this.#now() < cache.freshUntil;
    return Object.freeze({ status: fresh ? "fresh" : "stale", checkedAt: cache.checkedAt,
      versions: Object.freeze(matching.slice(offset, offset + limit)), ...(!fresh ? { error: "registry-unavailable" as const } : {}),
      ...(offset + limit < matching.length ? { nextCursor: Buffer.from(JSON.stringify([tag, offset + limit])).toString("base64url") } : {}),
    });
  }
  async resolve(name: string, version: string): Promise<ResolvedRelease> {
    this.#approved(name);
    if (!stableVersion(version)) throw new CatalogError("invalid-version");
    return releaseFromMetadata(await this.#metadata(name, version), name, version);
  }
}

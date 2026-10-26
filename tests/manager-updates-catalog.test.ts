import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const PACKAGE = "@earendil-works/pi-coding-agent";
const registry = "https://registry.npmjs.org/";
const integrity = `sha512-${createHash("sha512").update("fixture").digest("base64")}`;
const version = "2099.10.26";
const metadataUrl = `${registry}${encodeURIComponent(PACKAGE)}`;
function release(v = version, name = PACKAGE) {
  return { name, version: v, engines: { node: ">=20.0.0" }, dist: {
    tarball: `${registry}${name}/-/${name.split("/").at(-1)}-${v}.tgz`, integrity,
  } };
}
function response(url: string, value: unknown, statusCode = 200) {
  return { url, statusCode, headers: {}, body: (async function* () {
    yield Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  })() };
}
async function api() {
  const mod = await import("../manager/updates/catalog.ts").catch(() => null);
  assert.ok(mod?.ReleaseCatalog, "ReleaseCatalog must provide real bounded official discovery");
  return mod;
}

test("discovers future stable versions, orders numerically, paginates and freezes exact identity", async () => {
  const { ReleaseCatalog } = await api();
  const catalog = new ReleaseCatalog({ transport: async ({ url }) => response(url,
    url === metadataUrl ? { name: PACKAGE, versions: { "3.0.0": release("3.0.0"),
      "10.0.0": release("10.0.0"), [version]: release(), "2100.0.0-beta.1": {} } } : release()) });
  const page = await catalog.list(PACKAGE, { limit: 2 });
  assert.deepEqual(page.versions, [version, "10.0.0"]);
  assert.equal(page.status, "fresh");
  assert.ok(page.nextCursor);
  assert.deepEqual((await catalog.list(PACKAGE, { limit: 2, cursor: page.nextCursor })).versions, ["3.0.0"]);
  assert.deepEqual((await catalog.list(PACKAGE, { query: "2099" })).versions, [version]);
  await assert.rejects(catalog.list(PACKAGE, { query: "3", cursor: page.nextCursor }), { code: "invalid-query" });
  const resolved = await catalog.resolve(PACKAGE, version);
  assert.equal(resolved.packageName, PACKAGE);
  assert.equal(resolved.version, version);
  assert.equal(resolved.nodeEngine, ">=20.0.0");
  assert.equal(resolved.integrity, integrity);
  assert.match(resolved.identity, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(page) && Object.isFrozen(page.versions));
  assert.equal((await catalog.resolve(PACKAGE, version)).identity, resolved.identity);
});

test("coalesces concurrent discovery and exposes stale/unavailable with bounded retry", async () => {
  const { ReleaseCatalog } = await api();
  let now = 0, calls = 0, fail = false;
  const catalog = new ReleaseCatalog({ now: () => now, transport: async ({ url }) => {
    calls++; if (fail) throw new Error("private /secret/path credential");
    return response(url, { name: PACKAGE, versions: { [version]: release() } });
  } });
  const pages = await Promise.all(Array.from({ length: 20 }, () => catalog.list(PACKAGE)));
  assert.equal(calls, 1);
  assert.ok(pages.every(p => p.status === "fresh"));
  now = 300_001; fail = true;
  const stale = await catalog.list(PACKAGE);
  assert.equal(stale.status, "stale");
  assert.equal(stale.error, "registry-unavailable");
  assert.deepEqual(stale.versions, [version]);
  await catalog.list(PACKAGE); assert.equal(calls, 2);
  const empty = new ReleaseCatalog({ transport: async () => { throw new Error("secret"); } });
  assert.deepEqual(await empty.list(PACKAGE), { status: "unavailable", versions: [], checkedAt: null, error: "registry-unavailable" });
  await assert.rejects(empty.resolve(PACKAGE, version), { code: "registry-unavailable", message: "Official registry unavailable" });
});

test("construction-only metadata deadlines are strictly bounded while existing callers keep eight seconds", async () => {
  const { ReleaseCatalog } = await api();
  const observed: number[] = [];
  const transport = async (request: { url: string; timeoutMs: number }) => {
    observed.push(request.timeoutMs);
    return response(request.url, { name: PACKAGE, versions: { [version]: release() } });
  };
  assert.equal((await new ReleaseCatalog({ transport }).list(PACKAGE)).status, "fresh");
  assert.equal((await new ReleaseCatalog({ transport, metadataDeadlineMs: 2500 }).list(PACKAGE)).status, "fresh");
  assert.deepEqual(observed, [8000, 2500]);
  for (const metadataDeadlineMs of [0, -1, 1.5, 8001, "2500", null]) {
    assert.throws(() => new ReleaseCatalog({ transport, metadataDeadlineMs } as any), { code: "invalid-query" });
  }
  assert.deepEqual(observed, [8000, 2500]);
});

test("allowlist is fixed at construction; unknown packages and nonexact versions never fetch", async () => {
  const { ReleaseCatalog } = await api();
  const approved = ["@trusted/extension"];
  const catalog = new ReleaseCatalog({ extensionPackages: approved, transport: async ({ url }) => {
    assert.equal(url, `${registry}${encodeURIComponent(approved[0])}/${version}`);
    return response(url, release(version, approved[0]));
  } });
  await catalog.resolve(approved[0], version);
  approved.push("@evil/changed");
  for (const name of ["@evil/changed", "https://evil.test/package", "unknown"]) {
    await assert.rejects(catalog.resolve(name, version), { code: "package-not-approved" });
  }
  for (const v of ["latest", "^1.0.0", "01.0.0", "1.0.0-beta", "1.0.0/../../evil"]) {
    await assert.rejects(catalog.resolve(PACKAGE, v), { code: "invalid-version" });
  }
});

test("rejects malformed exact identities, unsafe origins, noncanonical sha512 and duplicate JSON keys", async () => {
  const { ReleaseCatalog } = await api();
  const good = release();
  const invalid = [
    { ...good, name: "wrong" }, { ...good, version: "1.0.0" },
    ...["http://registry.npmjs.org/x", good.dist.tarball + "?token=secret", good.dist.tarball.replace("https://", "https://user:pass@"),
      good.dist.tarball.replace("registry.npmjs.org", "registry.npmjs.org.evil.test"), good.dist.tarball.replace("/-/", "/%2e%2e/-/")]
      .map(tarball => ({ ...good, dist: { ...good.dist, tarball } })),
    ...["sha1-abc", integrity + " ", integrity.slice(0, -1), "sha512-" + "A".repeat(88)]
      .map(integrity => ({ ...good, dist: { ...good.dist, integrity } })),
    { ...good, engines: {} },
    JSON.stringify(good).replace('"name":', '"name":"wrong","na\\u006de":'),
  ];
  for (const value of invalid) {
    const c = new ReleaseCatalog({ transport: async ({ url }) => response(url, value) });
    await assert.rejects(c.resolve(PACKAGE, version), { code: "metadata-invalid" });
  }
});

test("rejects redirected/oversize metadata, too many versions, invalid JSON and expired page snapshots", async () => {
  const { ReleaseCatalog } = await api();
  for (const transport of [
    async ({ url }: { url: string }) => response(url, {}, 302),
    async ({ url }: { url: string }) => response(url + "/redirect", release()),
    async ({ url }: { url: string }) => response(url, " ".repeat(8 * 1024 * 1024 + 1)),
    async ({ url }: { url: string }) => ({ ...response(url, release()), headers: { "content-encoding": "gzip" } }),
  ]) {
    const c = new ReleaseCatalog({ transport });
    await assert.rejects(c.resolve(PACKAGE, version));
    assert.equal((await c.list(PACKAGE)).status, "unavailable");
  }
  for (const value of ["{", '{"name":"x","name":"y"}', { name: "wrong", versions: {} },
    { name: PACKAGE, versions: Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`1.0.${i}`, {}])) }]) {
    const c = new ReleaseCatalog({ transport: async ({ url }) => response(url, value) });
    assert.equal((await c.list(PACKAGE)).status, "unavailable");
  }
  let now = 0;
  const c = new ReleaseCatalog({ now: () => now, transport: async ({ url }) => response(url,
    { name: PACKAGE, versions: now ? { "4.0.0": release("4.0.0") } : { "1.0.0": release("1.0.0"), "2.0.0": release("2.0.0") } }) });
  const page = await c.list(PACKAGE, { limit: 1 }); now = 300001;
  await assert.rejects(c.list(PACKAGE, { limit: 1, cursor: page.nextCursor }), { code: "invalid-query" });
});

test("newly resolved source/integrity or engine mutation changes task identity", async () => {
  const { ReleaseCatalog } = await api();
  let value = release();
  const c = new ReleaseCatalog({ transport: async ({ url }) => response(url, value) });
  const original = await c.resolve(PACKAGE, version);
  value = { ...value, dist: { ...value.dist, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } };
  assert.notEqual((await c.resolve(PACKAGE, version)).identity, original.identity);
  value = { ...value, engines: { node: ">=24.0.0" } };
  assert.notEqual((await c.resolve(PACKAGE, version)).identity, original.identity);
});

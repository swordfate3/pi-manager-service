import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { ReleaseCatalog, PI_PACKAGE, type ResolvedRelease } from "../manager/updates/catalog.ts";

type Entry = { name: string; text?: string; type?: string; link?: string; size?: number };
/** Generate actual ustar + gzip bytes. No archive/parser implementation is mocked. */
function archive(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, "ascii"); header.write("0000000\0", 108, "ascii"); header.write("0000000\0", 116, "ascii");
    header.write((entry.size ?? data.length).toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii"); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, "ascii"); header.write(entry.link ?? "", 157, 100, "ascii");
    header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const version = "2099.10.26";
function manifest(overrides: Record<string, unknown> = {}) {
  return { name: PI_PACKAGE, version, engines: { node: ">=20.0.0" }, bin: { pi: "dist/cli.js" }, ...overrides };
}
function entries(value = manifest()): Entry[] {
  return [{ name: "package/package.json", text: JSON.stringify(value) }, { name: "package/dist/cli.js", text: "throw new Error('NEVER RUN');" }];
}
async function resolved(data: Buffer, nodeEngine = ">=20.0.0", packageName = PI_PACKAGE): Promise<ResolvedRelease> {
  const catalog = new ReleaseCatalog({ extensionPackages: packageName === PI_PACKAGE ? [] : [packageName], transport: async ({ url }) => ({
    statusCode: 200, url, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify({ name: packageName, version,
      engines: { node: nodeEngine }, dist: { tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").at(-1)}-${version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(data).digest("base64")}` } })); })(),
  }) });
  return catalog.resolve(packageName, version);
}
async function setup(t: TestContext, data = archive(entries())) {
  const mod = await import("../manager/updates/stage.ts").catch(() => null);
  assert.ok(mod?.ArtifactStager, "ArtifactStager must implement real private artifact preparation");
  const parent = await mkdtemp(path.join(tmpdir(), "manager-update-test-"));
  t.after(async () => {
    async function writable(dir: string) { await chmod(dir, 0o700); for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); }
    await writable(parent); await rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "artifacts");
  const transport = async ({ url }: { url: string }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() });
  const stager = await mod.ArtifactStager.create({ root, transport, nodeVersion: "22.19.0" });
  return { mod, parent, root, transport, stager, release: await resolved(data), data };
}

test("stages actual files with immutable evidence, without executing scripts or changing active installation", async t => {
  const data = archive(entries(manifest({ scripts: { preinstall: "touch ../lifecycle-marker", install: "touch ../lifecycle-marker", postinstall: "touch ../lifecycle-marker" },
    dependencies: { dependency: "^1.0.0" } })));
  const f = await setup(t, data);
  const live = path.join(f.parent, "live"); await mkdir(live); await writeFile(path.join(live, "installed"), "old");
  await symlink("live", path.join(f.parent, "active"));
  const before = await lstat(path.join(f.parent, "active"));
  const result = await f.stager.stage({ installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity });
  assert.equal(result.status, "prepared-unverified");
  assert.equal(result.runnable, false); assert.equal(result.dependencyClosure, "not-installed");
  assert.equal(result.candidateExecutable, "package/dist/cli.js");
  assert.equal(result.packageLockSha256, null);
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.release) && Object.isFrozen(result.executables));
  assert.ok(!JSON.stringify(result).includes(f.parent));
  const candidate = path.join(f.root, result.candidateKey);
  assert.equal(await readFile(path.join(candidate, "package/dist/cli.js"), "utf8"), "throw new Error('NEVER RUN');");
  assert.deepEqual(JSON.parse(await readFile(path.join(candidate, "receipt.json"), "utf8")), result);
  assert.equal((await lstat(candidate)).mode & 0o777, 0o500);
  assert.equal((await lstat(path.join(candidate, "package/dist/cli.js"))).mode & 0o777, 0o400);
  assert.equal(await readFile(path.join(live, "installed"), "utf8"), "old");
  assert.equal((await lstat(path.join(f.parent, "active"))).ino, before.ino);
  assert.deepEqual((await readdir(f.parent)).sort(), ["active", "artifacts", "live"]);
  assert.deepEqual((await readdir(candidate)).sort(), ["artifact.tgz", "package", "receipt.json"]);
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity }), { code: "stage-exists" });
});

test("verifies binding and sha512 before extraction and never trusts mutated identity fields", async t => {
  const f = await setup(t);
  for (const change of [{ version: "2099.10.27" }, { tarball: "https://evil.test/a.tgz" }, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, { nodeEngine: ">=1.0.0" }]) {
    await assert.rejects(f.stager.stage({ installationId: "pi-main", release: { ...f.release, ...change }, expectedIdentity: f.release.identity }), { code: "release-invalid" });
  }
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: f.release, expectedIdentity: "0".repeat(64) }), { code: "release-invalid" });
  const wrong = await resolved(Buffer.from("wrong"));
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: wrong, expectedIdentity: wrong.identity }), { code: "integrity-mismatch" });
  assert.deepEqual(await readdir(f.root), [".artifact-staging-v1"]);
});

test("exclusive per-installation writer spans separate handles; duplicate stages never overwrite", async t => {
  const f = await setup(t);
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { finish = r; });
  const first = await f.mod.ArtifactStager.open({ root: f.root, nodeVersion: "22.19.0", transport: async req => { started(); await gate; return f.transport(req); } });
  const second = await f.mod.ArtifactStager.open({ root: f.root, nodeVersion: "22.19.0", transport: f.transport });
  const request = { installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity };
  const work = first.stage(request); await entered;
  try {
    await assert.rejects(second.stage(request), { code: "writer-busy" });
    const unrelated = await second.stage({ ...request, installationId: "separate-install" });
    assert.equal(unrelated.status, "prepared-unverified");
  } finally { finish(); }
  const result = await work;
  await assert.rejects(second.stage(request), { code: "stage-exists" });
  assert.equal(await readFile(path.join(f.root, result.candidateKey, "artifact.tgz"), "hex"), f.data.toString("hex"));
});

test("fail-closed engine grammar, incompatible Node, unknown packages and invalid installation IDs", async t => {
  const f = await setup(t);
  for (const engine of [">=20", "^20.0.0", ">=20.0.0 || >=22.0.0", "*", "not semver"]) {
    const release = await resolved(f.data, engine);
    await assert.rejects(f.stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity }), { code: "engine-unsupported" });
  }
  const future = await resolved(f.data, ">=24.0.0");
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: future, expectedIdentity: future.identity }), { code: "node-incompatible" });
  const unknown = await resolved(f.data, ">=20.0.0", "@not-approved/extension");
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: unknown, expectedIdentity: unknown.identity }), { code: "package-not-approved" });
  for (const id of ["../escape", "", "a/b", "x".repeat(129)]) {
    await assert.rejects(f.stager.stage({ installationId: id, release: f.release, expectedIdentity: f.release.identity }), { code: "invalid-installation" });
  }
  assert.deepEqual(await readdir(f.root), [".artifact-staging-v1"]);
});

test("rejects traversal, aliases, duplicate entries, symlinks, hardlinks, special files and file/dir collisions", async t => {
  const hostile: Entry[][] = [
    ...["../escape", "/absolute", "package/../../escape", "package/./x", "package//x", "package/a\\b", "package/C:/x", "other/x", "package/CON", "package/x."].map(name => [{ name, text: "evil" }]),
    [{ name: "package/package.json", text: "{}" }],
    ...["1", "2", "3", "4", "6", "x", "g", "L", "K"].map(type => [{ name: "package/link", type, link: "../../outside" }]),
    [{ name: "package/dist", text: "collision" }],
    [{ name: "package/DIST/cli.js", text: "case alias" }],
    [{ name: "package/dist/", type: "5" }, { name: "package/dist", type: "5" }],
  ];
  const f = await setup(t);
  for (const extra of hostile) {
    const data = archive([...entries(), ...extra]);
    const stager = await f.mod.ArtifactStager.open({ root: f.root, nodeVersion: "22.19.0", transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() }) });
    const release = await resolved(data);
    await assert.rejects(stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity }), { code: "archive-invalid" });
  }
  assert.deepEqual(await readdir(f.root), [".artifact-staging-v1"]);
});

test("rejects wrong or duplicate manifest identity, unsafe executable and mismatched engine metadata", async t => {
  const f = await setup(t);
  for (const value of [manifest({ name: "wrong" }), manifest({ version: "1.0.0" }), manifest({ engines: { node: ">=18.0.0" } }),
    manifest({ bin: { pi: "../outside" } }), manifest({ bin: { pi: "missing.js" } })]) {
    const data = archive(entries(value));
    const release = await resolved(data);
    const stager = await f.mod.ArtifactStager.open({ root: f.root, nodeVersion: "22.19.0", transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() }) });
    await assert.rejects(stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity }), { code: "manifest-mismatch" });
  }
  const malformed = entries(); malformed[0].text = JSON.stringify(manifest()).replace('"version":', '"version":"1.0.0","version":');
  const data = archive(malformed), release = await resolved(data);
  const stager = await f.mod.ArtifactStager.open({ root: f.root, transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() }) });
  await assert.rejects(stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity }), { code: "manifest-mismatch" });
});

test("refuses existing, noncanonical, symlinked or nonprivate roots and does not expose private paths", async t => {
  const f = await setup(t);
  await assert.rejects(f.mod.ArtifactStager.create({ root: f.root }), { code: "root-unsafe" });
  await symlink(f.root, path.join(f.parent, "alias"));
  for (const root of [path.join(f.parent, "alias"), `${f.root}/../artifacts`, "/", "relative-root"]) {
    await assert.rejects(f.mod.ArtifactStager.open({ root }), { code: "root-unsafe" });
  }
  await chmod(f.root, 0o755);
  await assert.rejects(f.stager.stage({ installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity }), error => {
    assert.equal((error as { code: string }).code, "root-unsafe");
    assert.ok(!String(error).includes(f.parent)); return true;
  });
});

test("bounded archive rejects corrupt/truncated streams, header checksums and excessive declared entries/tree", async t => {
  const f = await setup(t);
  const many = archive([...entries(), ...Array.from({ length: 20001 }, (_, i) => ({ name: `package/f${i}` }))]);
  const badChecksum = gunzipSync(f.data); badChecksum[0] ^= 1;
  const trailingGarbage = Buffer.concat([gunzipSync(f.data), Buffer.alloc(512, 1)]);
  for (const data of [Buffer.from("not gzip"), f.data.subarray(0, f.data.length - 10),
    gzipSync(badChecksum), gzipSync(trailingGarbage), gzipSync(gunzipSync(f.data).subarray(0, -1024)),
    archive([...entries(), { name: "package/huge", size: 129 * 1024 * 1024 }]), many]) {
    const release = await resolved(data);
    const stager = await f.mod.ArtifactStager.open({ root: f.root, transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() }) });
    await assert.rejects(stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity }));
  }
  assert.deepEqual(await readdir(f.root), [".artifact-staging-v1"]);
});

test("artifact transport has fixed bounds and failed download releases the installation writer", async t => {
  const f = await setup(t);
  let attempt = 0;
  const stager = await f.mod.ArtifactStager.open({ root: f.root, transport: async request => {
    assert.equal(request.maxBytes, 32 * 1024 * 1024); assert.equal(request.timeoutMs, 30000);
    assert.equal(request.url, f.release.tarball);
    attempt++;
    return { url: request.url, statusCode: 200, headers: {}, body: (async function* () {
      if (attempt === 1) { for (let i = 0; i < 33; i++) yield Buffer.alloc(1024 * 1024); }
      else yield f.data;
    })() };
  } });
  const request = { installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity };
  await assert.rejects(stager.stage(request), { code: "download-failed" });
  assert.deepEqual(await readdir(f.root), [".artifact-staging-v1"]);
  assert.equal((await stager.stage(request)).status, "prepared-unverified");
});

test("approved extension stages without a CLI and records an artifact lockfile, not dependency closure", async t => {
  const packageName = "@trusted/extension";
  const lock = '{"lockfileVersion":3,"packages":{}}';
  const data = archive([{ name: "package/package.json", text: JSON.stringify(manifest({ name: packageName, bin: undefined })) },
    { name: "package/package-lock.json", text: lock }]);
  const f = await setup(t, data), release = await resolved(data, ">=20.0.0", packageName);
  const stager = await f.mod.ArtifactStager.open({ root: f.root, extensionPackages: [packageName], transport: f.transport });
  const receipt = await stager.stage({ installationId: "extension-main", release, expectedIdentity: release.identity });
  assert.equal(receipt.packageLockSha256, createHash("sha256").update(lock).digest("hex"));
  assert.equal(receipt.candidateExecutable, null); assert.deepEqual(receipt.executables, []);
  assert.equal(receipt.dependencyClosure, "not-installed"); assert.equal(receipt.runnable, false);
});

test("known exact and bounded engine ranges are checked, not merely parsed", async t => {
  const f = await setup(t);
  for (const [nodeEngine, good] of [["22.19.0", true], [">=20.0.0 <23.0.0", true], [">=20.0.0 <22.19.0", false], ["22.20.0", false]] as const) {
    const data = archive(entries(manifest({ engines: { node: nodeEngine } }))), release = await resolved(data, nodeEngine);
    const stager = await f.mod.ArtifactStager.open({ root: f.root, nodeVersion: "22.19.0", transport: async ({ url }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() }) });
    const run = stager.stage({ installationId: "pi-main", release, expectedIdentity: release.identity });
    if (good) assert.equal((await run).status, "prepared-unverified");
    else await assert.rejects(run, { code: "node-incompatible" });
  }
});

test("existing stale writer locks and incomplete candidate directories are never automatically reclaimed", async t => {
  const f = await setup(t);
  const installation = createHash("sha256").update("pi-main").digest("hex");
  const request = { installationId: "pi-main", release: f.release, expectedIdentity: f.release.identity };
  const lockPath = path.join(f.root, `.${installation}.lock`);
  await writeFile(lockPath, "orphaned-writer", { mode: 0o600 });
  await assert.rejects(f.stager.stage(request), { code: "writer-busy" });
  assert.equal(await readFile(lockPath, "utf8"), "orphaned-writer");
  await rm(lockPath); // Only the fixture's explicit reconciliation removes this lock.
  const installPath = path.join(f.root, installation);
  await mkdir(installPath, { mode: 0o700 });
  await mkdir(path.join(installPath, f.release.identity), { mode: 0o700 });
  await assert.rejects(f.stager.stage(request), { code: "stage-exists" });
});

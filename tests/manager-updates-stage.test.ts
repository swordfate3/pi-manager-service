import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
async function resolved(data: Buffer, nodeEngine = ">=20.0.0", packageName = PI_PACKAGE, exactVersion = version): Promise<ResolvedRelease> {
  const catalog = new ReleaseCatalog({ extensionPackages: packageName === PI_PACKAGE ? [] : [packageName], transport: async ({ url }) => ({
    statusCode: 200, url, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify({ name: packageName, version: exactVersion,
      engines: { node: nodeEngine }, dist: { tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").at(-1)}-${exactVersion}.tgz`,
        integrity: `sha512-${createHash("sha512").update(data).digest("base64")}` } })); })(),
  }) });
  return catalog.resolve(packageName, exactVersion);
}
async function setup(t: TestContext, data = archive(entries()), quota?: { maxRetainedBytes?: number; maxRetainedEntries?: number; maxCandidates?: number }) {
  const mod = await import("../manager/updates/stage.ts").catch(() => null);
  assert.ok(mod?.ArtifactStager, "ArtifactStager must implement real private artifact preparation");
  const parent = await mkdtemp(path.join(tmpdir(), "manager-update-test-"));
  t.after(async () => {
    async function writable(dir: string) { await chmod(dir, 0o700); for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); }
    await writable(parent); await rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "artifacts");
  const transport = async ({ url }: { url: string }) => ({ url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() });
  const stager = await mod.ArtifactStager.create({ root, transport, nodeVersion: "22.19.0", quota });
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

test("global admission spans installation IDs and separate handles; duplicate stages never overwrite", async t => {
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
    await assert.rejects(second.stage({ ...request, installationId: "separate-install" }), { code: "writer-busy" });
    await assert.rejects(first.stage({ ...request, installationId: "same-handle-other-install" }), { code: "writer-busy" });
  } finally { finish(); await work; }
  const result = await work;
  assert.equal((await second.stage({ ...request, installationId: "separate-install" })).status, "prepared-unverified");
  await assert.rejects(second.stage(request), { code: "stage-exists" });
  assert.equal(await readFile(path.join(f.root, result.candidateKey, "artifact.tgz"), "hex"), f.data.toString("hex"));
});

test("retained candidate quota refuses sequential installations before transport and survives reopen", async t => {
  const f = await setup(t, archive(entries()), { maxCandidates: 2 });
  const request = { installationId: "first", release: f.release, expectedIdentity: f.release.identity };
  await f.stager.stage(request);
  await f.stager.stage({ ...request, installationId: "second" });
  let downloads = 0;
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: async req => { downloads++; return f.transport(req); } });
  await assert.rejects(reopened.stage({ ...request, installationId: "third" }), { code: "resource-limit" });
  assert.equal(downloads, 0, "quota admission precedes download");
  assert.equal((await readdir(f.root)).filter(name => !name.startsWith(".")).length, 2);
});

test("sequential releases of one installation share the retained candidate budget", async t => {
  const f = await setup(t, archive(entries()), { maxCandidates: 1 });
  const first = await f.stager.stage({ installationId: "main", release: f.release, expectedIdentity: f.release.identity });
  const newer = archive(entries(manifest({ version: "2099.10.27" })));
  const release = await resolved(newer, ">=20.0.0", PI_PACKAGE, "2099.10.27");
  let downloads = 0;
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: async ({ url }) => {
    downloads++;
    return { url, statusCode: 200, headers: {}, body: (async function* () { yield newer; })() };
  } });
  await assert.rejects(reopened.stage({ installationId: "main", release, expectedIdentity: release.identity }), { code: "resource-limit" });
  assert.equal(downloads, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, first.candidateKey, "receipt.json"), "utf8")), first);
});

for (const [dimension, quota] of [["bytes", { maxRetainedBytes: 97 * 1024 * 1024 + 4096 }], ["inodes", { maxRetainedEntries: 20008 }]] as const) {
test(`retained ${dimension} limit reserves a worst-case candidate before download`, async t => {
  const data = archive([...entries(), { name: "package/padding", text: "x".repeat(8192) }]);
    const f = await setup(t, data, quota);
    const request = { installationId: "first", release: f.release, expectedIdentity: f.release.identity };
    await f.stager.stage(request);
    let downloads = 0;
    const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: async req => { downloads++; return f.transport(req); } });
    await assert.rejects(reopened.stage({ ...request, installationId: "second" }), { code: "resource-limit" });
    assert.equal(downloads, 0);
});
}

for (const [dimension, quota] of [["candidates", { maxCandidates: 1 }], ["bytes", { maxRetainedBytes: 97 * 1024 * 1024 + 512 * 1024 }]] as const) {
test(`reopen accounts incomplete ${dimension} without overwriting them`, async t => {
    const f = await setup(t, archive(entries()), quota);
    const partial = path.join(f.root, "a".repeat(64), "b".repeat(64));
    await mkdir(partial, { recursive: true, mode: 0o700 });
    const file = await open(path.join(partial, "artifact.tgz"), "wx", 0o600);
    await file.truncate(1024 * 1024); await file.close();
    const before = await lstat(path.join(partial, "artifact.tgz"));
    let downloads = 0;
    const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: async req => { downloads++; return f.transport(req); } });
    await assert.rejects(reopened.stage({ installationId: "new", release: f.release, expectedIdentity: f.release.identity }), { code: "resource-limit" });
    assert.equal(downloads, 0);
    assert.equal((await lstat(path.join(partial, "artifact.tgz"))).ino, before.ino);
    assert.equal((await lstat(path.join(partial, "artifact.tgz"))).size, before.size);
});
}

test("a crashed global admission lock blocks every installation after reopen and is never reclaimed", async t => {
  const f = await setup(t);
  const lock = path.join(f.root, ".artifact-writer.lock");
  await writeFile(lock, "unknown crashed writer", { mode: 0o600 });
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: f.transport });
  await assert.rejects(reopened.stage({ installationId: "other", release: f.release, expectedIdentity: f.release.identity }), { code: "writer-busy" });
  assert.equal(await readFile(lock, "utf8"), "unknown crashed writer");
});

test("admission streams excessive retained directory contents and stops at the entry budget", async t => {
  const f = await setup(t, archive(entries()), { maxRetainedEntries: 16 });
  const partial = path.join(f.root, "a".repeat(64), "b".repeat(64));
  await mkdir(partial, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 128; i++) await writeFile(path.join(partial, `f${i}`), "", { mode: 0o600 });
  let reads = 0;
  const original = fsPromises.opendir;
  // Observe real streamed directory IO, not a replacement scanner or fake filesystem.
  const spy = t.mock.method(fsPromises, "opendir", async (...args: Parameters<typeof original>) => {
    const dir = await original(...args);
    const read = dir.read.bind(dir);
    dir.read = (async () => { reads++; return read(); }) as typeof dir.read;
    return dir;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.stager.stage({ installationId: "new", release: f.release, expectedIdentity: f.release.identity }), { code: "resource-limit" });
    assert.ok(reads > 0 && reads <= 24, `bounded streamed scan, observed ${reads} reads`);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("quota construction settings are copied, persisted and reject unknown or conflicting settings", async t => {
  const f = await setup(t);
  const quota = { maxCandidates: 1 };
  const options = { root: path.join(f.parent, "limited"), quota, transport: f.transport };
  const creating = f.mod.ArtifactStager.create(options);
  quota.maxCandidates = 100;
  const limited = await creating;
  const request = { installationId: "first", release: f.release, expectedIdentity: f.release.identity };
  await limited.stage(request);
  await assert.rejects(limited.stage({ ...request, installationId: "second" }), { code: "resource-limit" });
  await assert.rejects(f.mod.ArtifactStager.open({ ...options, quota: { maxCandidates: 100 } }), { code: "options-invalid" });
});

test("unknown and invalid quota settings fail closed before creating a root", async t => {
  const f = await setup(t);
  for (const bad of [{ maxCandidates: 0 }, { maxRetainedBytes: NaN }, { maxRetainedEntries: 1.5 }, { typo: 1 }, { maxCandidates: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(f.mod.ArtifactStager.create({ root: path.join(f.parent, "invalid"), quota: bad }), { code: "options-invalid" });
  }
  await assert.rejects(f.mod.ArtifactStager.create({ root: path.join(f.parent, "unknown"), unexpected: true } as never), { code: "options-invalid" });
});

test("public stage requests cannot supply quota settings", async t => {
  const f = await setup(t);
  await assert.rejects(f.stager.stage({ installationId: "first", release: f.release, expectedIdentity: f.release.identity,
    quota: { maxCandidates: 100 } } as never), { code: "release-invalid" });
});

test("a real partial write remains charged after an IO failure and reopen", async t => {
  const f = await setup(t, archive(entries()), { maxCandidates: 1 });
  const original = fsPromises.open;
  const spy = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith("/receipt.json")) throw Object.assign(new Error("injected IO failure"), { code: "ENOSPC" });
    return original(...args);
  });
  syncBuiltinESMExports();
  const request = { installationId: "partial", release: f.release, expectedIdentity: f.release.identity };
  try { await assert.rejects(f.stager.stage(request), { code: "stage-io" }); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  const candidate = path.join(f.root, createHash("sha256").update("partial").digest("hex"), f.release.identity);
  assert.deepEqual(await readFile(path.join(candidate, "artifact.tgz")), f.data);
  assert.ok(!(await readdir(f.root)).some(name => name.endsWith(".lock")));
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: f.transport });
  await assert.rejects(reopened.stage(request), { code: "stage-exists" });
  await assert.rejects(reopened.stage({ ...request, installationId: "other" }), { code: "resource-limit" });
});

test("incomplete candidates within quota are counted without prohibiting unrelated preparation", async t => {
  const f = await setup(t, archive(entries()), { maxCandidates: 2 });
  const partial = path.join(f.root, "a".repeat(64), "b".repeat(64));
  await mkdir(partial, { recursive: true, mode: 0o700 });
  await writeFile(path.join(partial, "artifact.tgz"), "partial", { mode: 0o600 });
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: f.transport });
  const request = { installationId: "new", release: f.release, expectedIdentity: f.release.identity };
  assert.equal((await reopened.stage(request)).status, "prepared-unverified");
  await assert.rejects(reopened.stage({ ...request, installationId: "another" }), { code: "resource-limit" });
  assert.equal(await readFile(path.join(partial, "artifact.tgz"), "utf8"), "partial");
});

test("legacy roots receive default quota accounting without rewriting their marker or partial candidates", async t => {
  const f = await setup(t);
  const marker = path.join(f.root, ".artifact-staging-v1");
  await chmod(marker, 0o600);
  await writeFile(marker, "pi-manager private artifact staging v1\n");
  await chmod(marker, 0o400);
  for (let i = 0; i < 8; i++) await mkdir(path.join(f.root, "a".repeat(64), i.toString(16).padStart(64, "0")), { recursive: true, mode: 0o700 });
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: f.transport });
  await assert.rejects(reopened.stage({ installationId: "new", release: f.release, expectedIdentity: f.release.identity }), { code: "resource-limit" });
  assert.equal(await readFile(marker, "utf8"), "pi-manager private artifact staging v1\n");
});

test("retained symlinks and excessively deep partial trees fail closed before transport", async t => {
  const f = await setup(t);
  const partial = path.join(f.root, "a".repeat(64), "b".repeat(64));
  await mkdir(partial, { recursive: true, mode: 0o700 });
  const outside = path.join(f.parent, "outside"); await writeFile(outside, "untouched");
  const link = path.join(partial, "link"); await symlink(outside, link);
  let downloads = 0;
  const reopened = await f.mod.ArtifactStager.open({ root: f.root, transport: async req => { downloads++; return f.transport(req); } });
  const request = { installationId: "new", release: f.release, expectedIdentity: f.release.identity };
  await assert.rejects(reopened.stage(request), { code: "root-unsafe" });
  await rm(link); // Fixture-only reconciliation; the stager never removes it.
  await mkdir(path.join(partial, ...Array.from({ length: 33 }, () => "d")), { recursive: true, mode: 0o700 });
  await assert.rejects(reopened.stage(request), { code: "resource-limit" });
  assert.equal(downloads, 0);
  assert.equal(await readFile(outside, "utf8"), "untouched");
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

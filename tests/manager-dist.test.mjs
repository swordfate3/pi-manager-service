import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-manager-dist-"));
  for (const entry of [
    "bin",
    "hub",
    "manager",
    "protocol",
    "gate/gate",
    "gate/gatectl",
    "runtime",
    "dist",
    "scripts/manager-dist.mjs",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "docs/source-provenance.md",
    "docs/commercial-use.md",
    "docs/migration-inventory.json",
    "NOTICE",
    "LICENSE",
    "README.md",
  ]) {
    cpSync(path.join(root, entry), path.join(directory, entry), { recursive: true });
  }
  rmSync(path.join(directory, "gate", "gate", "__pycache__"), { recursive: true, force: true });
  const module = await import("../scripts/manager-dist.mjs");
  return { directory, module };
}

function listFiles(directory, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(directory, child));
    else files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

async function packFixture(t) {
  const source = await fixture();
  t.after(() => rmSync(source.directory, { recursive: true, force: true }));
  const pythonCache = path.join(source.directory, "gate", "gate", "__pycache__");
  mkdirSync(pythonCache);
  writeFileSync(path.join(pythonCache, "synthetic.cpython-314.pyc"), "synthetic-cache");
  writeFileSync(path.join(source.directory, "gate", "gate", "synthetic.pyc"), "synthetic-bytecode");

  const directory = mkdtempSync(path.join(tmpdir(), "pi-manager-packed-dist-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "npm-cache");
  const testHome = path.join(directory, "home");
  mkdirSync(testHome);
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", directory],
    {
      cwd: source.directory,
      env: {
        PATH: process.env.PATH,
        HOME: testHome,
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        PI_CODING_AGENT_DIR: path.join(directory, "agent"),
        PI_MANAGER_CONFIG: path.join(directory, "manager.json"),
        PI_WEB_UI_HUB_CONFIG: path.join(directory, "legacy.json"),
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_USERCONFIG: path.join(directory, "npmrc"),
        NPM_CONFIG_GLOBALCONFIG: path.join(directory, "global-npmrc"),
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const extracted = path.join(directory, "extracted");
  mkdirSync(extracted);
  const untarred = spawnSync("tar", ["-xzf", path.join(directory, filename), "-C", extracted], {
    encoding: "utf8",
  });
  assert.equal(untarred.error, undefined);
  assert.equal(untarred.status, 0, untarred.stderr);
  return path.join(extracted, "package");
}

test("generated Python caches do not change source identity or clean manifest verification", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  const clean = await f.module.createSourceInventory(f.directory);
  await f.module.verifyManifest(f.directory);
  const pythonCache = path.join(f.directory, "gate", "gate", "__pycache__");
  mkdirSync(pythonCache);
  writeFileSync(path.join(pythonCache, "synthetic.cpython-314.pyc"), "synthetic-cache");
  writeFileSync(path.join(f.directory, "gate", "gate", "synthetic.pyc"), "synthetic-bytecode");

  assert.deepEqual(await f.module.createSourceInventory(f.directory), clean);
  await f.module.verifyManifest(f.directory);
});

test("distribution verification rejects source drift after the bundle manifest is written", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  await f.module.writeManifest(f.directory);
  await f.module.verifyManifest(f.directory);

  const source = path.join(f.directory, "hub", "limits.ts");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
  await assert.rejects(f.module.verifyManifest(f.directory), /Source inventory differs/);
});

test("new manager service sources are fingerprinted and cannot drift unnoticed", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  const inventory = await f.module.createSourceInventory(f.directory);
  assert.equal(inventory.files.some((file) => file.path === "manager/task-store.ts"), true);
  await f.module.writeManifest(f.directory);
  await f.module.verifyManifest(f.directory);
  const source = path.join(f.directory, "manager", "task-store.ts");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
  await assert.rejects(f.module.verifyManifest(f.directory), /Source inventory differs/);
});

test('distribution verification rejects changes to the shipped RPC input guard', async t => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await f.module.writeManifest(f.directory);
  await f.module.verifyManifest(f.directory);
  const guard = path.join(f.directory, 'runtime', 'pi_rpc_guard.mjs');
  writeFileSync(guard, `${readFileSync(guard, 'utf8')}\n// changed shipped guard\n`);
  await assert.rejects(f.module.verifyManifest(f.directory), /Source inventory differs/);
});

test("distribution inventory refuses source symlinks", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const source = path.join(f.directory, "protocol", "runtime-metadata.ts");
  const replacement = path.join(f.directory, "runtime-metadata-copy.ts");
  cpSync(source, replacement);
  unlinkSync(source);
  symlinkSync(replacement, source);

  await assert.rejects(f.module.createSourceInventory(f.directory), /Refusing to follow symlink/);
});

test("distribution inventory refuses cache-named symlinks instead of ignoring them", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const outside = path.join(f.directory, "outside-cache");
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.directory, "gate", "gate", "__pycache__"), "dir");

  await assert.rejects(f.module.createSourceInventory(f.directory), /Refusing to follow symlink/);
});

test("distribution inventory refuses bytecode-named symlinks instead of ignoring them", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const outside = path.join(f.directory, "outside-bytecode");
  writeFileSync(outside, "not-bytecode");
  symlinkSync(outside, path.join(f.directory, "gate", "gate", "synthetic.pyc"));

  await assert.rejects(f.module.createSourceInventory(f.directory), /Refusing to follow symlink/);
});

test("distribution verification refuses output symlinks", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const output = path.join(f.directory, "dist", "hub", "pi-web-hub.mjs");
  const replacement = path.join(f.directory, "outside-output.mjs");
  cpSync(output, replacement);
  unlinkSync(output);
  symlinkSync(replacement, output);

  await assert.rejects(f.module.verifyManifest(f.directory), /Refusing to follow symlink/);
});

test("the actual packed artifact verifies itself and contains the complete runtime probe", async (t) => {
  const packed = await packFixture(t);

  await t.test("ships unchanged MIT terms and the commercial attribution guidance", () => {
    assert.equal(readFileSync(path.join(packed, "LICENSE"), "utf8"), readFileSync(path.join(root, "LICENSE"), "utf8"));
    for (const name of ["NOTICE", "docs/commercial-use.md", "docs/source-provenance.md"]) {
      assert.equal(lstatSync(path.join(packed, name)).isFile(), true, name);
    }
    const notice = readFileSync(path.join(packed, "NOTICE"), "utf8");
    for (const author of ["deflating", "kkkiio", "swordfate3"]) assert.ok(notice.includes(author));
    assert.match(notice, /encouraged, not required/);
  });

  await t.test("includes the manager task store and contracts in the real archive", () => {
    const files = listFiles(packed);
    assert.ok(files.includes("manager/contracts.ts"));
    assert.ok(files.includes("manager/task-store.ts"));
  });

  await t.test("excludes generated Python caches from the archive inventory", () => {
    const files = listFiles(packed);
    assert.equal(files.some((name) => name.split("/").includes("__pycache__")), false);
    assert.equal(files.some((name) => /\.(?:pyc|pyo)$/u.test(name)), false);
  });

  await t.test("contains all three fixed runtime probe files as regular non-symlink files", () => {
    for (const name of ["runtime_probe.py", "runtime_probe_provider.ts", "runtime_probe_ws.mjs"]) {
      const stat = lstatSync(path.join(packed, "runtime", name));
      assert.equal(stat.isFile(), true, name);
      assert.equal(stat.isSymbolicLink(), false, name);
    }
  });

  await t.test("runs the shipped distribution verifier from the extracted tarball", () => {
    const verified = spawnSync(process.execPath, [path.join(packed, "scripts", "manager-dist.mjs")], {
      cwd: packed,
      encoding: "utf8",
    });
    assert.equal(verified.error, undefined);
    assert.equal(verified.status, 0, verified.stderr);
  });

  await t.test("runs archived service with its declared ws runtime and without development dependencies", () => {
    const require = createRequire(import.meta.url);
    cpSync(path.dirname(require.resolve("ws/package.json")), path.join(packed,"node_modules","ws"), { recursive: true });
    const checked = spawnSync(process.execPath, ["--import", "./tests/register-ts.mjs", "--test", "tests/manager-entry.test.ts"], {
      cwd: root, encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH, HOME: path.dirname(packed), PI_MANAGER_TEST_ENTRY: path.join(packed,"dist","manager","pi-manager-service.mjs") },
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  });
});

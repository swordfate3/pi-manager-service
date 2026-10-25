import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-manager-dist-"));
  for (const entry of [
    "bin",
    "hub",
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
  ]) {
    cpSync(path.join(root, entry), path.join(directory, entry), { recursive: true });
  }
  const module = await import("../scripts/manager-dist.mjs");
  return { directory, module };
}

function packFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-manager-packed-dist-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "npm-cache");
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", directory],
    {
      cwd: root,
      env: { ...process.env, NPM_CONFIG_CACHE: cache },
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

test("distribution verification rejects source drift after the bundle manifest is written", async (t) => {
  const f = await fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  await f.module.writeManifest(f.directory);
  await f.module.verifyManifest(f.directory);

  const source = path.join(f.directory, "hub", "limits.ts");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
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

test("the actual packed artifact verifies itself and contains the complete runtime probe", async (t) => {
  const packed = packFixture(t);

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
});

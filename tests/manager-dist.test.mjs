import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
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

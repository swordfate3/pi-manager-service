import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { captureSoftwareMetadata, readSoftwareMetadata } from "../protocol/software-metadata.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-software-metadata-"));
  mkdirSync(path.join(root, "extensions"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@kkkiio/pi-web-ui", version: "0.1.1" }));
  const moduleUrl = pathToFileURL(path.join(root, "extensions", "mirror-server.ts")).href;
  return { root, moduleUrl };
}

test("captures package version and source fingerprint once as immutable display metadata", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const build = "a".repeat(64);
  writeFileSync(path.join(f.root, "dist/build-manifest.json"), JSON.stringify({ source: { sha256: build } }));
  const value = captureSoftwareMetadata("1.3.0+custom", f.moduleUrl);
  assert.deepEqual(value, { piVersion: "1.3.0+custom", webUi: { version: "0.1.1", build } });
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value?.webUi));
  writeFileSync(path.join(f.root, "dist/build-manifest.json"), JSON.stringify({ source: { sha256: "b".repeat(64) } }));
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "@kkkiio/pi-web-ui", version: "0.1.2" }));
  assert.deepEqual(
    value,
    { piVersion: "1.3.0+custom", webUi: { version: "0.1.1", build } },
    "on-disk install changes cannot update an existing captured runtime snapshot",
  );
  assert.deepEqual(captureSoftwareMetadata("1.3.0+custom", f.moduleUrl), {
    piVersion: "1.3.0+custom",
    webUi: { version: "0.1.2", build: "b".repeat(64) },
  });
});

test("keeps Pi version visible when package, build manifest or fingerprint cannot be read", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.deepEqual(captureSoftwareMetadata("1.3.0", f.moduleUrl), {
    piVersion: "1.3.0",
    webUi: { version: "0.1.1" },
  });
  writeFileSync(path.join(f.root, "dist/build-manifest.json"), "malformed");
  assert.deepEqual(captureSoftwareMetadata("1.3.0", f.moduleUrl), {
    piVersion: "1.3.0",
    webUi: { version: "0.1.1" },
  });
  writeFileSync(path.join(f.root, "package.json"), "malformed");
  assert.deepEqual(captureSoftwareMetadata("1.3.0", f.moduleUrl), { piVersion: "1.3.0" });
});

test("strictly validates bounded registration metadata without coercion or extra fields", () => {
  const build = "b".repeat(64);
  assert.deepEqual(readSoftwareMetadata({ piVersion: "1.3.0-beta.2+local", webUi: { version: "0.1.1", build } }), {
    piVersion: "1.3.0-beta.2+local",
    webUi: { version: "0.1.1", build },
  });
  assert.deepEqual(readSoftwareMetadata({ piVersion: "1.3.0" }), { piVersion: "1.3.0" });
  for (const invalid of [
    null,
    [],
    {},
    { piVersion: "1.3.0", unexpected: true },
    { piVersion: "1.3.0-preview!" },
    { piVersion: "1.3.0-01" },
    { piVersion: "99999999999999999.0.0" },
    { piVersion: "1.3.0".repeat(20) },
    { piVersion: 130 },
    { piVersion: "1.3.0", webUi: { version: "0.1.1", build: "A".repeat(64) } },
    { piVersion: "1.3.0", webUi: { version: "0.1.1", build: "a".repeat(63) } },
    { piVersion: "1.3.0", webUi: { version: "0.1.1", build: "a".repeat(64), extra: true } },
  ])
    assert.throws(() => readSoftwareMetadata(invalid), /Invalid software metadata/);
});

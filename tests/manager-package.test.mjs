import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist/hub/pi-web-hub.mjs");
const require = createRequire(import.meta.url);

function temporaryDirectory(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function isolatedEnvironment(home, overrides = {}) {
  const env = { ...process.env, HOME: home };
  delete env.PI_MANAGER_CONFIG;
  delete env.PI_WEB_UI_HUB_CONFIG;
  return Object.assign(env, overrides);
}

test("the real CLI initializes a private zero-Pi manager configuration", () => {
  const directory = temporaryDirectory("pi-manager-init-");
  const home = path.join(directory, "home");
  const configFile = path.join(directory, "private", "config.json");
  mkdirSync(home, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [cli, "init", "--config", configFile, "--port", "0"], {
      encoding: "utf8",
      env: isolatedEnvironment(home),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(configFile).mode & 0o077, 0);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(config.port, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default initialization ignores legacy Hub state and environment", () => {
  const directory = temporaryDirectory("pi-manager-home-");
  const home = path.join(directory, "home");
  const legacyConfig = path.join(home, ".pi", "web-hub", "config.json");
  const managerConfig = path.join(home, ".config", "pi-manager", "config.json");
  mkdirSync(path.dirname(legacyConfig), { recursive: true });
  const legacy = JSON.stringify({ legacy: true, secret: "must-not-be-read-or-overwritten" });
  writeFileSync(legacyConfig, legacy, { mode: 0o600 });
  const env = isolatedEnvironment(home, { PI_WEB_UI_HUB_CONFIG: legacyConfig });
  try {
    const result = spawnSync(process.execPath, [cli, "init", "--port", "0"], { encoding: "utf8", env });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(legacyConfig, "utf8"), legacy);
    assert.equal(statSync(managerConfig).mode & 0o077, 0);
    assert.equal(JSON.parse(result.stdout).configFile, managerConfig);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PI_MANAGER_CONFIG selects an explicit independent configuration", () => {
  const directory = temporaryDirectory("pi-manager-env-");
  const home = path.join(directory, "home");
  const configFile = path.join(directory, "private", "manager.json");
  mkdirSync(home, { recursive: true });
  const env = isolatedEnvironment(home, { PI_MANAGER_CONFIG: configFile });
  try {
    const result = spawnSync(process.execPath, [cli, "init", "--port", "0"], { encoding: "utf8", env });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).configFile, configFile);
    assert.equal(statSync(configFile).mode & 0o077, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the detached bundle runs with only declared runtime dependencies", () => {
  const directory = temporaryDirectory("pi-manager-detached-");
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@modelcontextprotocol/node", "@modelcontextprotocol/server", "ws", "zod"]);

    const detachedCli = path.join(directory, "dist", "hub", "pi-web-hub.mjs");
    mkdirSync(path.dirname(detachedCli), { recursive: true });
    copyFileSync(cli, detachedCli);
    copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));

    const wsPackage = require.resolve("ws/package.json");
    cpSync(path.dirname(wsPackage), path.join(directory, "node_modules", "ws"), { recursive: true });

    const result = spawnSync(process.execPath, [detachedCli, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pi Web Hub/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed CLI help advertises the shipped pi-manager command and README", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pi-manager init/);
  assert.match(result.stdout, /README\.md/);
  assert.doesNotMatch(result.stdout, /pi-web-hub\s/);
  assert.doesNotMatch(result.stdout, /docs\/hub\.md/);
});

test("invalid CLI arguments fail without echoing secret input", () => {
  const directory = temporaryDirectory("pi-manager-invalid-");
  const home = path.join(directory, "home");
  const secret = "manager-secret-do-not-print";
  mkdirSync(home, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [cli, "init", "--unknown", secret], {
      encoding: "utf8",
      env: isolatedEnvironment(home),
    });

    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.match(result.stderr, /Pi Web Hub failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("package metadata exposes only the independent manager CLI", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  assert.equal(manifest.name, "@swordfate/pi-manager");
  assert.equal(manifest.private, true);
  assert.equal(manifest.bin?.["pi-manager"], "dist/hub/pi-web-hub.mjs");
  assert.equal(manifest.pi, undefined);
});

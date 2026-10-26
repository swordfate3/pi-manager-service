import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("packed Manager installs declared production dependencies in a clean prefix and owns four services", {
  skip: process.env.PI_MANAGER_TEST_INSTALL !== "1", timeout: 240_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "manager-clean-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); await mkdir(home);
  const proxy = process.env.PI_MANAGER_TEST_PROXY;
  if (proxy) {
    const u = new URL(proxy);
    assert.equal(u.protocol, "http:"); assert.ok(["127.0.0.1", "[::1]"].includes(u.hostname));
    assert.equal(u.username + u.password + u.search + u.hash, ""); assert.equal(u.pathname, "/");
  }
  const env = { PATH: process.env.PATH, HOME: home, NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(root, "global-npmrc"), NPM_CONFIG_CACHE: path.join(root, "cache"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_UPDATE_NOTIFIER: "false",
    ...(proxy ? { NPM_CONFIG_HTTPS_PROXY: proxy, NPM_CONFIG_PROXY: proxy } : {}) };
  const run = promisify(execFile);
  const packed = await run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", root], {
    cwd: path.resolve("."), env, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const [{ filename }] = JSON.parse(packed.stdout);
  const prefix = path.join(root, "installed");
  await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--fetch-retries=0",
    "--fetch-timeout=20000", path.join(root, filename)], { env, timeout: 180_000, maxBuffer: 1024 * 1024 });
  const installed = path.join(prefix, "node_modules", "@swordfate", "pi-manager");
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "@swordfate/pi-manager");
  const verified = await run(process.execPath, [path.join(installed, "scripts", "manager-dist.mjs")], {
    cwd: installed, env, timeout: 10_000,
  });
  assert.equal(verified.stderr, "");
  const checked = await run(process.execPath, ["--import", "./tests/register-ts.mjs", "--test", "tests/manager-entry.test.ts"], {
    cwd: path.resolve("."), env: { ...env, PI_MANAGER_TEST_ENTRY: path.join(installed, "dist", "manager", "pi-manager-service.mjs") },
    timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.match(checked.stdout, /# pass 2\b/);
  assert.match(checked.stdout, /# fail 0\b/);
});

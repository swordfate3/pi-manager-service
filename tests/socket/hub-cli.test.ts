import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHubCli } from "../helpers/hub-cli.ts";

const cli = fileURLToPath(new URL("../../dist/hub/pi-web-hub.mjs", import.meta.url));
test("CLI initializes once and issues private individual credentials without printing tokens", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--config", config], { encoding: "utf8" });
  assert.equal(run("init", "--port", "0").status, 0);
  assert.notEqual(run("init").status, 0, "existing configuration must not be overwritten");
  const file = path.join(dir, "session.json");
  const result = run("issue", "--output", file, "--label", "Project A");
  assert.equal(result.status, 0, result.stderr);
  const credential = JSON.parse(readFileSync(file, "utf8"));
  assert.match(credential.token, /^[a-f0-9]{64}$/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential.token));
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(run("revoke", "--run-id", credential.run_id).status, 0);
  const grant = JSON.parse(readFileSync(path.join(dir, "state", "grants", `${credential.run_id}.json`), "utf8"));
  assert.equal(grant.revoked, true);
  assert.notEqual(run("issue", "--output", file, "--label", "B").status, 0);
  assert.notEqual(run("serve", "--unknown", "secret-value").status, 0);
});

test("standalone hub serves a portal and shuts down cleanly on SIGTERM", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-"));
  const config = path.join(dir, "config.json");
  assert.equal(spawnSync(process.execPath, [cli, "init", "--config", config, "--port", "0"]).status, 0);
  const child = spawn(process.execPath, [cli, "serve", "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("exit", resolve));
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const ready = await new Promise<{ localUrl: string }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Hub stopped before ready")));
  });
  const response = await fetch(`${ready.localUrl}sessions/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Pi/);
  // A hostile peer need not finish its TCP write half after a rejected upgrade.
  const address = new URL(ready.localUrl);
  const peer = net.createConnection({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
  t.after(() => peer.destroy());
  await new Promise<void>((resolve, reject) => {
    peer.once("error", reject);
    peer.once("data", () => resolve());
    peer.once("connect", () =>
      peer.write(
        `GET /s/${"f".repeat(32)}/ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    );
  });
  const closed = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("shutdown blocked by rejected upgrade"), 2000);
        }),
      ]),
      0,
    );
  } finally {
    clearTimeout(timer);
    peer.destroy();
  }
});

test("detached Hub bundle reports its embedded version/build without package files or network", {
  timeout: 15000,
}, async (t) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const expected = {
    version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
    build: JSON.parse(readFileSync(path.join(root, "dist/build-manifest.json"), "utf8")).source.sha256,
  };
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-detached-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const detached = path.join(dir, "hub.mjs");
  copyFileSync(cli, detached);
  // Only the declared external runtime dependency is available, not repository package metadata.
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(realpathSync(path.join(root, "node_modules", "ws")), path.join(dir, "node_modules", "ws"), "dir");
  for (const adjacentPackage of [undefined, { name: "@kkkiio/pi-web-ui", version: "9.9.9" }]) {
    if (adjacentPackage) writeFileSync(path.join(dir, "package.json"), JSON.stringify(adjacentPackage));
    const config = path.join(dir, adjacentPackage ? "misleading.json" : "absent.json");
    const env = { ...process.env, PI_OFFLINE: "1" };
    assert.equal(spawnSync(process.execPath, [detached, "init", "--config", config, "--port", "0"], { env }).status, 0);
    const child = spawn(process.execPath, [detached, "serve", "--config", config], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready = await new Promise<{ localUrl: string }>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Detached Hub stopped before ready")));
      });
      const response = await fetch(`${ready.localUrl}api/sessions`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.sessions, []);
      assert.deepEqual(body.versions.hub, expected, "bundle identity must not be guessed from adjacent disk files");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const settled = await (await fetch(`${ready.localUrl}api/sessions`)).json();
      assert.equal(settled.versions.status, "unavailable", "offline reference check is unavailable, not fake success");
      assert.deepEqual(settled.versions.hub, expected, "offline reference failure cannot erase running Hub identity");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once("exit", resolve));
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.kill("SIGTERM");
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
});

test("unknown and inherited-object command names never start a hub through the default config", async (t) => {
  for (const command of ["toString", "constructor", "__proto__", "hasOwnProperty", "not-a-command"]) {
    await t.test(command, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-command-"));
      try {
        const config = path.join(dir, "config.json");
        assert.equal(spawnSync(process.execPath, [cli, "init", "--config", config, "--port", "0"]).status, 0);
        // No remaining arguments: the old inherited-property lookup skipped parsing and fell through to serve.
        const result = spawnSync(process.execPath, [cli, command], {
          env: { ...process.env, PI_WEB_UI_HUB_CONFIG: config },
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
        });
        assert.equal(result.error, undefined, "unknown command must exit rather than listen until killed");
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Pi Web Hub failed/);
        assert.equal(existsSync(path.join(dir, "runtime", "registry.sock")), false);
        assert.equal(existsSync(path.join(dir, "runtime", "hub.lock")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("E2E hub helper runs packaged CLI lifecycle without exposing capability tokens", { timeout: 15000 }, async () => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const hub = await startHubCli({ repositoryRoot, runtimeDir: repositoryRoot });
  try {
    const capability = hub.issue("Synthetic CLI fixture");
    assert.deepEqual(Object.keys(capability).sort(), ["credentialFile", "runId", "socketPath"]);
    assert.equal((await fetch(`${hub.url}sessions/`)).status, 200);
    hub.revoke(capability);
    const grantFile = path.join(path.dirname(capability.credentialFile), "state", "grants", `${capability.runId}.json`);
    assert.equal(JSON.parse(readFileSync(grantFile, "utf8")).revoked, true);
    await hub.restart();
    assert.equal((await fetch(`${hub.url}sessions/`)).status, 200);
  } finally {
    await hub.close();
  }
});

test("E2E hub helper honors PI_E2E_RUNTIME_DIR without falling back to repository sources", async () => {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-hub-missing-runtime-"));
  const previousRuntime = process.env.PI_E2E_RUNTIME_DIR;
  process.env.PI_E2E_RUNTIME_DIR = runtimeDir;
  try {
    await assert.rejects(
      startHubCli({ repositoryRoot: fileURLToPath(new URL("../..", import.meta.url)) }),
      /selected runtime's Hub CLI/,
    );
  } finally {
    if (previousRuntime === undefined) delete process.env.PI_E2E_RUNTIME_DIR;
    else process.env.PI_E2E_RUNTIME_DIR = previousRuntime;
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

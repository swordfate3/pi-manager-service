import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, issueSession, readGrant, readHubConfig, revokeSession } from "../../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";
import { storageDiagnostics, withStateWriter } from "../../hub/state-budget.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "bounded-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0 });
  const config = readHubConfig(file);
  const credential = issueSession(config, path.join(dir, "first.json"), { label: "live" });
  return { dir, file, config, credential };
}

function seedActiveGrants(config: { stateDir: string }, total: number) {
  for (let i = 1; i < total; i++) {
    const run_id = i.toString(16).padStart(32, "0");
    writeFileSync(
      path.join(config.stateDir, "grants", `${run_id}.json`),
      JSON.stringify({ run_id, token: "a".repeat(64), label: "existing", backendHost: "127.0.0.1" }),
      { mode: 0o600 },
    );
  }
}

test("pre-existing 513 active grants reject ordinary writes and startup without changing grants", async (t) => {
  const f = fixture(t);
  seedActiveGrants(f.config, 513);
  const grants = path.join(f.config.stateDir, "grants");
  const before = readdirSync(grants)
    .sort()
    .map((name) => [name, readFileSync(path.join(grants, name), "utf8")]);
  assert.equal(storageDiagnostics(f.config).activeGrants, 513);
  assert.equal(storageDiagnostics(f.config).overBudget, true);
  assert.throws(() => issueManagementCode(f.config), /quota/);
  assert.throws(
    () =>
      withStateWriter(f.config, (writer) =>
        writer.write("registry.json", { schema: 2, boot: "a".repeat(32) }, { security: true }),
      ),
    /quota/,
  );
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    await assert.rejects(async () => {
      hub = await startHub(f.config, { versions: { source: async () => ({}) } });
    }, /quota/);
    assert.deepEqual(
      readdirSync(grants)
        .sort()
        .map((name) => [name, readFileSync(path.join(grants, name), "utf8")]),
      before,
    );
    assert.equal(existsSync(path.join(f.config.stateDir, "registry.json")), false);
    revokeSession(f.config, f.credential.run_id);
    assert.equal(storageDiagnostics(f.config).activeGrants, 512);
    assert.equal(readdirSync(grants).length, 513);
    hub = await startHub(f.config, { versions: { source: async () => ({}) } });
    issueManagementCode(f.config);
  } finally {
    await hub?.close();
  }
});

test("pre-existing overcount allows only exact grant revocation until recovery reaches 512", (t) => {
  const f = fixture(t);
  seedActiveGrants(f.config, 514);
  const grant = readGrant(f.config, f.credential.run_id);
  assert.throws(
    () =>
      withStateWriter(f.config, (writer) =>
        writer.write(
          `grants/${grant.run_id}.json`,
          { ...grant, revoked: true, token: "b".repeat(64) },
          { security: true },
        ),
      ),
    /quota/,
  );
  assert.deepEqual(readGrant(f.config, grant.run_id), grant);
  revokeSession(f.config, grant.run_id);
  assert.equal(storageDiagnostics(f.config).activeGrants, 513);
  assert.throws(() => issueManagementCode(f.config), /quota/);
  revokeSession(f.config, "1".padStart(32, "0"));
  assert.equal(storageDiagnostics(f.config).activeGrants, 512);
  assert.equal(readdirSync(path.join(f.config.stateDir, "grants")).length, 514);
  issueManagementCode(f.config);
});

test("pre-existing overcount on a running Hub rejects renewal, fresh registration and bounded issuance", async (t) => {
  const f = fixture(t);
  const hub = await startHub(f.config, { versions: { source: async () => ({}) } });
  let generation = "a".repeat(32);
  const backend = http.createServer((request, response) =>
    response.end(
      JSON.stringify({
        generation,
        proof: createHmac("sha256", f.credential.token)
          .update(`${request.headers["x-pi-web-challenge"]}:${generation}`)
          .digest("hex"),
      }),
    ),
  );
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as net.AddressInfo).port;
  const exchange = (value: Record<string, unknown>) =>
    new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
      const socket = net.createConnection(f.config.socketPath, () =>
        socket.write(`${JSON.stringify({ ...f.credential, ...value })}\n`),
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(data));
        }
      });
      socket.once("error", reject);
    });
  try {
    assert.equal((await exchange({ action: "register", generation, port })).ok, true);
    seedActiveGrants(f.config, 513);
    const before = readGrant(f.config, f.credential.run_id);
    assert.equal(
      (await exchange({ action: "register", generation, port })).code,
      "STATE_QUOTA",
      "renewal must not bypass admission just because it has no disk write",
    );
    generation = "b".repeat(32);
    assert.equal((await exchange({ action: "register", generation, port })).code, "STATE_QUOTA");
    const { boot } = JSON.parse(readFileSync(path.join(f.config.stateDir, "registry.json"), "utf8"));
    assert.equal(
      (
        await exchange({
          action: "bounded_issue",
          protocol: "bounded-v2",
          boot,
          slot: "0".repeat(16),
          request_id: "c".repeat(32),
          port,
        })
      ).code,
      "STATE_QUOTA",
    );
    assert.deepEqual(readGrant(f.config, f.credential.run_id), before);
    assert.equal(existsSync(path.join(f.config.stateDir, "generations", `${generation}.json`)), false);
    assert.equal(readdirSync(path.join(f.config.stateDir, "bounded")).length, 0);
  } finally {
    await hub.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

test("quota refuses growth without altering a live grant or publishing an export", (t) => {
  const f = fixture(t);
  const before = readGrant(f.config, f.credential.run_id);
  writeFileSync(path.join(f.config.stateDir, "unknown-private-data"), Buffer.alloc(8 * 1024 * 1024), { mode: 0o600 });
  assert.throws(() => issueSession(f.config, path.join(f.dir, "denied.json"), { label: "denied" }), /quota|budget/i);
  assert.equal(existsSync(path.join(f.dir, "denied.json")), false);
  assert.equal(JSON.stringify(readGrant(f.config, f.credential.run_id)), JSON.stringify(before));
  assert.equal(readdirSync(path.join(f.config.stateDir, "grants")).length, 1);
  assert.throws(() => issueManagementCode(f.config), /quota|budget/i);
});

test("512 active grants is an atomic admission boundary; revocation still works", (t) => {
  const f = fixture(t);
  for (let i = 1; i < 512; i++) issueSession(f.config, path.join(f.dir, `export-${i}.json`), { label: "offline" });
  assert.throws(() => issueSession(f.config, path.join(f.dir, "denied.json"), { label: "overflow" }), /quota|budget/i);
  revokeSession(f.config, f.credential.run_id);
  assert.equal(readGrant(f.config, f.credential.run_id).revoked, true);
  issueSession(f.config, path.join(f.dir, "replacement.json"), { label: "new" });
  assert.equal(
    readdirSync(path.join(f.config.stateDir, "grants")).length,
    513,
    "revoked grants are preserved without a coordinator proof",
  );
});

test("a crashed writer lock blocks CLI and authentication writers, without auto-stealing", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.config.stateDir, ".writer.lock"), { mode: 0o700 });
  const before = readGrant(f.config, f.credential.run_id);
  assert.throws(() => revokeSession(f.config, f.credential.run_id), /busy|lock/i);
  assert.throws(() => issueManagementCode(f.config), /busy|lock/i);
  assert.throws(() => revokeManagement(f.config), /busy|lock/i);
  const result = spawnSync(
    process.execPath,
    [
      "bin/pi-web-hub.mjs",
      "issue",
      "--config",
      f.file,
      "--label",
      "blocked",
      "--output",
      path.join(f.dir, "blocked.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(f.dir, "blocked.json")), false);
  assert.equal(JSON.stringify(readGrant(f.config, f.credential.run_id)), JSON.stringify(before));
  assert.ok(existsSync(path.join(f.config.stateDir, ".writer.lock")));
});

test("unsafe symlinks and unknown files are never followed or deleted by quota work", (t) => {
  const f = fixture(t);
  const outside = path.join(f.dir, "outside");
  writeFileSync(outside, "DO NOT DELETE", { mode: 0o600 });
  const link = path.join(f.config.stateDir, "foreign-link");
  symlinkSync(outside, link);
  assert.throws(() => issueSession(f.config, path.join(f.dir, "denied.json"), { label: "denied" }));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(outside, "utf8"), "DO NOT DELETE");
});

test("failed export publication never leaves an export without an authoritative grant", (t) => {
  const f = fixture(t);
  const output = path.join(f.dir, "already-exists.json");
  writeFileSync(output, "untouched", { mode: 0o600 });
  assert.throws(() => issueSession(f.config, output, { label: "denied" }));
  assert.equal(readFileSync(output, "utf8"), "untouched");
  assert.equal(readdirSync(path.join(f.config.stateDir, "grants")).length, 1);
});

test("separate CLI issuers cannot oversubscribe the final grant slot", async (t) => {
  const f = fixture(t);
  // Seed private legacy-shaped grants; the tested admissions use the real CLI.
  for (let i = 1; i < 511; i++) {
    const run_id = i.toString(16).padStart(32, "0");
    writeFileSync(
      path.join(f.config.stateDir, "grants", `${run_id}.json`),
      JSON.stringify({ run_id, token: "a".repeat(64), label: "offline", backendHost: "127.0.0.1" }),
      { mode: 0o600 },
    );
  }
  const issue = (index: number) =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "bin/pi-web-hub.mjs",
          "issue",
          "--config",
          f.file,
          "--label",
          "race",
          "--output",
          path.join(f.dir, `race-${index}.json`),
        ],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", resolve);
    });
  const results = await Promise.all([issue(1), issue(2), issue(3), issue(4)]);
  assert.equal(results.filter((status) => status === 0).length, 1);
  assert.equal(storageDiagnostics(f.config).activeGrants, 512);
});

test("external exports are charged conservatively and aggregate diagnostics contain no secrets or paths", (t) => {
  const f = fixture(t);
  const before = storageDiagnostics(f.config);
  assert.ok(before.logicalBytes <= 8388608);
  assert.equal(before.activeGrantLimit, 512);
  assert.equal(before.exportReservedBytes, readFileSync(path.join(f.dir, "first.json")).length);
  rmSync(path.join(f.dir, "first.json"));
  assert.deepEqual(storageDiagnostics(f.config), before, "external deletion cannot subtract an unverified charge");
  for (const secret of [f.dir, f.credential.run_id, f.credential.token, "live"])
    assert.ok(!JSON.stringify(before).includes(secret));
});

test("byte quota reserves room for grant and management revocation and accounts staged replacements", (t) => {
  const f = fixture(t);
  issueManagementCode(f.config);
  const before = storageDiagnostics(f.config);
  writeFileSync(path.join(f.config.stateDir, "unknown-retained"), Buffer.alloc(8388608 - 65536 - before.logicalBytes), {
    mode: 0o600,
  });
  assert.throws(() => issueManagementCode(f.config), /quota/i);
  assert.throws(() => issueSession(f.config, path.join(f.dir, "over.json"), { label: "over" }), /quota/i);
  revokeSession(f.config, f.credential.run_id);
  revokeManagement(f.config);
  assert.equal(readGrant(f.config, f.credential.run_id).revoked, true);
  assert.ok(storageDiagnostics(f.config).logicalBytes <= 8388608);
});

test("live writer ownership excludes every administrative process, then releases normally", (t) => {
  const f = fixture(t);
  withStateWriter(f.config, () => {
    const revoke = spawnSync(
      process.execPath,
      ["bin/pi-web-hub.mjs", "revoke", "--config", f.file, "--run-id", f.credential.run_id],
      { encoding: "utf8" },
    );
    assert.equal(revoke.status, 1);
    assert.equal(readGrant(f.config, f.credential.run_id).revoked, false);
  });
  revokeSession(f.config, f.credential.run_id);
  assert.equal(readGrant(f.config, f.credential.run_id).revoked, true);
});

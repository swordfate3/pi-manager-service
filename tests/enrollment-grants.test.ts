import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";

const key = "12345678-1234-1234-1234-123456789abc";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "enrollment-grants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "hub.json"); initializeHub(file, { port: 0 });
  const config = readHubConfig(file); const output = path.join(root, `registration-${key}.json`);
  const options = { label: "project-one", provisionKey: key };
  return { root, config, output, options };
}

test("provision key retries reuse the durable grant and republish a missing export", async t => {
  const f = await fixture(t);
  const first = issueSession(f.config, f.output, f.options);
  const saved = JSON.parse(await readFile(path.join(f.config.stateDir, "grants", `${first.run_id}.json`), "utf8"));
  assert.equal(saved.provisionKey, key, "key must survive the grant-write/export crash gap");
  assert.deepEqual(issueSession(f.config, f.output, f.options), first);
  await unlink(f.output);
  assert.deepEqual(issueSession(f.config, f.output, f.options), first);
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), first);
  assert.equal((await readdir(path.join(f.config.stateDir, "grants"))).length, 1);
});

test("key tombstones, changed labels and ambiguous exports never mint replacement grants", async t => {
  const f = await fixture(t); const first = issueSession(f.config, f.output, f.options);
  await assert.rejects(async () => issueSession(f.config, f.output, { ...f.options, label: "other" }));
  await writeFile(f.output, JSON.stringify({ ...first, token: "0".repeat(64) }));
  assert.throws(() => issueSession(f.config, f.output, f.options));
  await unlink(f.output); revokeSession(f.config, first.run_id);
  assert.throws(() => issueSession(f.config, f.output, f.options));
  assert.equal((await readdir(path.join(f.config.stateDir, "grants"))).length, 1);
});

test("grant-write/export failure recovers by durable key after restart without another grant", async t => {
  const f = await fixture(t);
  // A stored grant with a missing export models process death after the durable
  // grant write. A new config object must recover without an in-memory index.
  await mkdir(path.join(f.config.stateDir, "grants"), { recursive: true, mode: 0o700 });
  const credential = { run_id: "b".repeat(32), token: "c".repeat(64) };
  await writeFile(path.join(f.config.stateDir, "grants", `${credential.run_id}.json`), JSON.stringify({
    ...credential, label: f.options.label, backendHost: "127.0.0.1", revoked: false,
    provisionKey: key, exportBytes: Buffer.byteLength(JSON.stringify(credential) + "\n"),
  }), { mode: 0o600 });
  assert.deepEqual(issueSession({ ...f.config }, f.output, f.options), credential);
  assert.equal((await readdir(path.join(f.config.stateDir, "grants"))).length, 1);
});

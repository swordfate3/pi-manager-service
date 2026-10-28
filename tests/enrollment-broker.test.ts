import assert from "node:assert/strict";
import http from "node:http";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHub, readHubConfig, revokeSession } from "../hub/config.ts";
import { digest } from "../manager/validation.ts";

const token = "a".repeat(64);
const key = "12345678-1234-1234-1234-123456789abc";
export function enrollmentRequest(socketPath: string, route: string, body: unknown, auth = token, host = "pi-enrollment", method = "POST") {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method, agent: false,
      headers: { host, authorization: `Bearer ${auth}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject); req.end(data);
  });
}
async function modules() {
  let server: any, client: any;
  try { server = await import("../manager/enrollment/server.ts"); client = await import("../manager/enrollment/client.ts"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  assert.ok(server && client, "dedicated enrollment server/client must exist");
  return { ...server, ...client };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "enrollment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "hub.json"); initializeHub(file, { port: 0 });
  const hub = readHubConfig(file); const parent = path.join(root, "ipc");
  await mkdir(parent, { mode: 0o750 });
  const provisioning = { socketPath: path.join(parent, "enroll.sock"), exportDir: path.join(root, "exports"), tokenHash: digest(token), socketMode: 0o660 as const };
  const authorityFile = path.join(root, "authority.json");
  await writeFile(authorityFile, JSON.stringify({ token }), { mode: 0o600 });
  return { root, file, hub, parent, provisioning, authorityFile };
}

test("broker authenticates first, rejects injection and leaks no capabilities; restart is idempotent", async t => {
  const m = await modules(); const f = await fixture(t); let readyRun = "";
  let server = await m.startEnrollmentBroker(f.hub, f.provisioning, async (run: string) => run === readyRun);
  t.after(() => server.close());
  const socket = f.provisioning.socketPath;
  assert.equal((await stat(socket)).mode & 0o777, 0o660);
  assert.equal((await stat(f.parent)).mode & 0o777, 0o750, "existing parent untouched");
  const input = { key, label: "project-one" };
  assert.equal((await enrollmentRequest(socket, "/issue", input, "z".repeat(64))).status, 401);
  assert.deepEqual(await readdir(f.provisioning.exportDir), []);
  for (const body of [{ ...input, output: "/tmp/injected" }, { ...input, backendHost: "other" }, { ...input, key: "../escape" }, { ...input, label: "../bad" }]) {
    assert.equal((await enrollmentRequest(socket, "/issue", body)).status, 400);
  }
  assert.equal((await enrollmentRequest(socket, "/issue", input, token, "wrong")).status, 403);
  assert.equal((await enrollmentRequest(socket, "/issue", input, token, "pi-enrollment", "GET")).status, 404);
  assert.equal((await enrollmentRequest(socket, "/issue?x=1", input)).status, 404);
  assert.deepEqual((await enrollmentRequest(socket, "/issue", input)).body, { ok: true });
  const output = path.join(f.provisioning.exportDir, `registration-${key}.json`);
  const credential = JSON.parse(await readFile(output, "utf8"));
  assert.equal((await stat(output)).uid, 1000); assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual((await enrollmentRequest(socket, "/status", input)).body, { ready: false });
  readyRun = credential.run_id;
  assert.deepEqual((await enrollmentRequest(socket, "/status", input)).body, { ready: true });
  await server.close(); server = await m.startEnrollmentBroker(f.hub, f.provisioning, async () => false);
  assert.deepEqual((await enrollmentRequest(socket, "/issue", input)).body, { ok: true });
  assert.equal((await enrollmentRequest(socket, "/issue", { ...input, label: "changed" })).status, 409);
  revokeSession(f.hub, credential.run_id);
  assert.equal((await enrollmentRequest(socket, "/issue", input)).status, 409);
  assert.deepEqual((await enrollmentRequest(socket, "/status", input)).body, { ready: false });
  assert.equal((await readdir(path.join(f.hub.stateDir, "grants"))).length, 1);
});

test("authority reader rejects symlink, hardlink, FIFO and public mode before reading", async t => {
  const m = await modules(); const f = await fixture(t);
  assert.equal(await m.readEnrollmentAuthority(f.authorityFile), token);
  const alias = path.join(f.root, "alias"); await symlink(f.authorityFile, alias);
  await assert.rejects(m.readEnrollmentAuthority(alias));
  await link(f.authorityFile, path.join(f.root, "hardlink"));
  await assert.rejects(m.readEnrollmentAuthority(f.authorityFile));
  const fifo = path.join(f.root, "fifo"); execFileSync("mkfifo", ["-m", "600", fifo]);
  await assert.rejects(m.readEnrollmentAuthority(fifo));
  const publicFile = path.join(f.root, "public.json"); await writeFile(publicFile, JSON.stringify({ token }), { mode: 0o644 });
  await assert.rejects(m.readEnrollmentAuthority(publicFile));
});

test("broker refuses writable IPC parents and existing socket paths without stealing", async t => {
  const m = await modules(); const f = await fixture(t);
  await chmod(f.parent, 0o770);
  await assert.rejects(m.startEnrollmentBroker(f.hub, f.provisioning, async () => false));
  assert.equal((await stat(f.parent)).mode & 0o777, 0o770);
  await chmod(f.parent, 0o750); await writeFile(f.provisioning.socketPath, "retain");
  await assert.rejects(m.startEnrollmentBroker(f.hub, f.provisioning, async () => false));
  assert.equal(await readFile(f.provisioning.socketPath, "utf8"), "retain");
});

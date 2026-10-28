import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initializeHub, readHubConfig, revokeSession } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { DockerBackend } from "../manager/backends/docker.ts";
import { startEnrollmentBroker } from "../manager/enrollment/server.ts";
import { digest } from "../manager/validation.ts";
import { dockerDaemon } from "./helpers/docker-daemon.ts";

async function fixture(t: test.TestContext) {
  const f = await dockerDaemon(t);
  const hubFile = path.join(f.root, "hub.json"); initializeHub(hubFile, { port: 0 });
  const hubConfig = readHubConfig(hubFile);
  const hub = await startHub(hubConfig, { versions: { source: async () => ({}) } });
  f.cleanups.push(() => hub.close());
  const provisioning = { socketPath: path.join(f.root, "ipc/enroll.sock"), exportDir: path.join(f.root, "exports"), tokenHash: digest("a".repeat(64)) };
  const broker = await startEnrollmentBroker(hubConfig, provisioning, run => hub.isRunReady(run)); f.cleanups.push(() => broker.close());
  const authorityFile = path.join(f.root, "authority.json"); await writeFile(authorityFile, JSON.stringify({ token: "a".repeat(64) }), { mode: 0o600 });
  const packageRoot = path.join(f.root, "web");
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true }); await mkdir(path.join(packageRoot, "dist"));
  await writeFile(path.join(packageRoot, "extensions/mirror-server.ts"), "export default () => {};"); await writeFile(path.join(packageRoot, "dist/index.html"), "html");
  const enrollment = { socketPath: provisioning.socketPath, authorityFile, registryHostDirectory: hubConfig.runtimeDir, exportHostDirectory: provisioning.exportDir };
  const config = { socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host" as const,
    startupTimeoutMs: 100, web: { packageRoot, port: 18310, enrollment } };
  let backend = await DockerBackend.open(config); f.cleanups.push(() => backend.close());
  const register = async () => {
    const definition = f.calls.find(c => c.route.startsWith("/containers/create?"))!.body;
    const source = definition.HostConfig.Mounts.find((m: any) => m.Target === "/run/pi-web/credential.json").Source;
    const credential = JSON.parse(await readFile(source, "utf8")); const generation = "d".repeat(32);
    let validProof = true;
    const pi = http.createServer((req, res) => res.end(JSON.stringify({ generation, proof: validProof ? createHmac("sha256", credential.token).update(`${req.headers["x-pi-web-challenge"]}:${generation}`).digest("hex") : "invalid" })));
    await new Promise<void>((resolve, reject) => { pi.once("error", reject); pi.listen(0, "127.0.0.1", resolve); });
    f.cleanups.push(async () => { pi.closeAllConnections(); await new Promise<void>(r => pi.close(() => r())); });
    const result = await new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(hubConfig.socketPath, () => socket.write(JSON.stringify({ ...credential, action: "register", generation, port: (pi.address() as net.AddressInfo).port }) + "\n"));
      let data = ""; socket.on("data", chunk => { data += chunk; if (data.includes("\n")) { socket.destroy(); resolve(JSON.parse(data)); } }); socket.on("error", reject);
    });
    assert.equal(result.ok, true);
    return { source, credential, invalidProof: () => { validProof = false; } };
  };
  return { ...f, config, hubConfig, hub, provisioning, register, get backend() { return backend; }, reopen: async () => { await backend.close(); backend = await DockerBackend.open(config); } };
}

test("Docker Running alone times out; proved enrollment recovers exact identity after reopen", async t => {
  const f = await fixture(t);
  const request = { instanceId: "one", workspace: { root: "work", path: "project" } };
  await assert.rejects(f.backend.create(request), /readiness/);
  const identity = (await f.backend.list())[0]; assert.ok(identity);
  const definition = f.calls.find(c => c.route.startsWith("/containers/create?"))!.body;
  const registration = definition.HostConfig.Mounts.find((m: any) => m.Target === "/run/pi-web/credential.json");
  assert.match(path.basename(registration.Source), /^registration-[a-f0-9-]{36}\.json$/);
  assert.equal(path.dirname(registration.Source), f.provisioning.exportDir);
  for (const privatePath of [f.hubConfig.stateDir, f.provisioning.socketPath, f.config.web.enrollment.authorityFile, f.provisioning.exportDir]) {
    assert.ok(!definition.HostConfig.Mounts.some((m: any) => m.Source === privatePath));
  }
  const pi = await f.register();
  assert.equal(await f.hub.isRunReady(pi.credential.run_id), true);
  await f.backend.stop("one");
  await assert.rejects(f.backend.create(request), /running|readiness/, "a stale live proof alone cannot make a stopped container ready");
  await unlink(pi.source); await f.reopen();
  assert.equal((await f.backend.start("one")).containerId, identity.containerId);
  assert.deepEqual(JSON.parse(await readFile(pi.source, "utf8")), pi.credential);
  assert.equal((await f.backend.create(request)).containerId, identity.containerId);
  assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
  assert.equal((await readdir(path.join(f.hubConfig.stateDir, "grants"))).length, 1);
  pi.invalidProof(); assert.equal(await f.hub.isRunReady(pi.credential.run_id), false);
  await assert.rejects(f.backend.start("one"), /readiness/);
  revokeSession(f.hubConfig, pi.credential.run_id);
  await assert.rejects(f.backend.start("one"));
  assert.ok(!JSON.stringify(await f.backend.list()).includes(pi.credential.token));
  assert.equal(f.calls.some(c => c.method === "DELETE"), false);
});

test("known start failure retains the container/grant for a later approved start", async t => {
  const f = await fixture(t); f.behavior.failStart = true;
  await assert.rejects(f.backend.create({ instanceId: "failed-start", workspace: { root: "work", path: "project" } }));
  const identity = (await f.backend.list())[0]; assert.ok(identity);
  f.behavior.failStart = false; await f.register(); await f.reopen();
  assert.equal((await f.backend.start("failed-start")).containerId, identity.containerId);
  assert.equal(f.calls.filter(c => c.route.startsWith("/containers/create?")).length, 1);
  assert.equal((await readdir(path.join(f.hubConfig.stateDir, "grants"))).length, 1);
});

test("unknown container-create outcome retains one grant and never issues a duplicate", async t => {
  const f = await fixture(t); f.behavior.loseCreateReply = true;
  const request = { instanceId: "uncertain", workspace: { root: "work", path: "project" } };
  await assert.rejects(f.backend.create(request), /unknown/); f.behavior.loseCreateReply = false;
  await assert.rejects(f.backend.create(request), /reconciliation/);
  assert.equal(f.containers.size, 1); assert.equal(f.volumes.size, 1);
  assert.equal((await readdir(path.join(f.hubConfig.stateDir, "grants"))).length, 1);
  assert.equal((await readdir(f.provisioning.exportDir)).length, 1);
  assert.equal(f.calls.some(c => c.method === "DELETE"), false);
});

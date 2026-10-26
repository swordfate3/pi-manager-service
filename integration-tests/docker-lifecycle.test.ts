import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerBackend } from "../manager/backends/docker.ts";
import { DockerEngine } from "../manager/backends/docker-engine.ts";

const enabled = process.env.PI_MANAGER_DOCKER_TEST === "1";

test("new Docker lifecycle owns exact resources and preserves home across stop/start", { skip: !enabled }, async t => {
  const image = process.env.PI_MANAGER_DOCKER_TEST_IMAGE;
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "explicit existing immutable local test image required");
  const engine = new DockerEngine(process.env.PI_MANAGER_DOCKER_TEST_SOCKET ?? "/var/run/docker.sock", { timeoutMs: 15_000 });
  const before = await engine.call("GET", "/containers/json?all=1") as { Id: string }[];
  const snapshots = new Map<string, unknown>();
  for (const row of before) {
    const c = await engine.call("GET", `/containers/${row.Id}/json`) as any;
    snapshots.set(row.Id, { started: c.State.StartedAt, running: c.State.Running, restarts: c.RestartCount });
  }
  const parent = await mkdtemp(path.join(tmpdir(), "manager-docker-live-"));
  const work = path.join(parent, "work");
  await mkdir(path.join(work, "project"), { recursive: true });
  const state = path.join(parent, "journal");
  const config = { socketPath: process.env.PI_MANAGER_DOCKER_TEST_SOCKET ?? "/var/run/docker.sock", daemonId: (await engine.call("GET", "/info") as any).ID,
    image: image!, pathCoordinates: "host" as const, stateRoot: state, workspaceRoots: { test: work }, timeoutMs: 120_000,
    entrypoint: ["/usr/local/bin/node"], command: ["-e", "const fs=require('node:fs');const p='/home/node/manager-test-marker';const existed=fs.existsSync(p);if(!existed)fs.writeFileSync(p,'retained');fs.writeFileSync('/workspace/restored',existed?fs.readFileSync(p,'utf8'):'new');fs.writeFileSync('/workspace/started','yes');process.stdin.resume();process.on('SIGTERM',()=>process.exit(0));"] };
  let backend: DockerBackend | undefined;
  t.after(async () => {
    await backend?.close();
    // Only deterministic names from this test's own private ownership journal.
    // On any ownership mismatch, retain resources/evidence and fail the test.
    const stateFile = JSON.parse(await readFile(path.join(state, "tasks.json"), "utf8"));
    for (const record of Object.values(stateFile.tasks) as any[]) {
      assert.equal(record.action, "docker.create");
      const name = `pi-manager-${record.id.replaceAll("-", "")}`;
      const found = await engine.call("GET", `/containers/${name}/json`, undefined, { allowMissing: true }) as any;
      const check = (labels: any) => {
        assert.equal(labels["cn.swordfate.pi-manager.owner"], record.requester);
        assert.equal(labels["cn.swordfate.pi-manager.nonce"], record.id);
        assert.equal(labels["cn.swordfate.pi-manager.instance"], record.target);
      };
      if (found) {
        check(found.Config.Labels); assert.equal(found.Image, image); assert.match(found.Id, /^[a-f0-9]{64}$/);
        assert.equal(snapshots.has(found.Id), false);
        if (found.State.Running) await engine.call("POST", `/containers/${found.Id}/stop?t=2`);
        await engine.call("DELETE", `/containers/${found.Id}`);
      }
      const volume = `pi-manager-home-${record.id.replaceAll("-", "")}`;
      const foundVolume = await engine.call("GET", `/volumes/${volume}`, undefined, { allowMissing: true }) as any;
      if (foundVolume) { check(foundVolume.Labels); assert.equal(foundVolume.Name, volume); await engine.call("DELETE", `/volumes/${volume}`); }
    }
    for (const [id, expected] of snapshots) {
      const c = await engine.call("GET", `/containers/${id}/json`) as any;
      assert.deepEqual({ started: c.State.StartedAt, running: c.State.Running, restarts: c.RestartCount }, expected, "preexisting container must stay unchanged");
    }
    engine.close();
    await rm(parent, { recursive: true, force: true });
  });
  backend = await DockerBackend.open(config);
  const identity = await backend.create({ instanceId: "lifecycle", workspace: { root: "test", path: "project" } });
  assert.equal(snapshots.has(identity.containerId), false);
  const deadline = Date.now() + 5000;
  while (true) {
    try { assert.equal(await readFile(path.join(work, "project", "started"), "utf8"), "yes"); break; }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(r => setTimeout(r, 50)); }
  }
  assert.equal((await backend.inspect("lifecycle"))?.status, "running");
  const volume = await engine.call("GET", `/volumes/${identity.homeVolume}`) as any;
  assert.equal(volume.Name, identity.homeVolume);
  await backend.stop("lifecycle");
  assert.equal((await backend.inspect("lifecycle"))?.status, "stopped");
  await backend.close();
  backend = await DockerBackend.open(config);
  await backend.start("lifecycle");
  assert.equal((await backend.inspect("lifecycle"))?.containerId, identity.containerId);
  const restoredDeadline = Date.now() + 5000;
  while (await readFile(path.join(work, "project", "restored"), "utf8") !== "retained") {
    assert.ok(Date.now() < restoredDeadline, "persistent home marker must survive stop/start");
    await new Promise(r => setTimeout(r, 50));
  }
  await backend.stop("lifecycle");
  assert.equal((await engine.call("GET", `/volumes/${identity.homeVolume}`) as any).Name, identity.homeVolume);
  // The persistent marker was checked by the new test container itself and
  // reported only into this test's workspace; no /var/lib/docker host read.
  await writeFile(path.join(parent, "acceptance.json"), JSON.stringify({ containerId: identity.containerId, homeVolume: identity.homeVolume, stopped: true }), { mode: 0o600 });
});

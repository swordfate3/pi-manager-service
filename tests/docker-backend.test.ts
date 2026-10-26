import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { dockerDaemon } from "./helpers/docker-daemon.ts";

async function backendModule() {
  let module: typeof import("../manager/backends/docker.ts") | undefined;
  try { module = await import("../manager/backends/docker.ts"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  assert.ok(module, "Docker lifecycle adapter must exist");
  return module;
}

test("Docker backend pins daemon/image and owns exact containers across reopen; stop preserves home", async t => {
  const f = await dockerDaemon(t);
  const { DockerBackend } = await backendModule();
  const config = { socketPath: f.socketPath, daemonId: f.daemonId, image: f.image,
    stateRoot: f.state, workspaceRoots: { projects: f.work }, pathCoordinates: "host" as const };
  let backend = await DockerBackend.open(config);
  f.cleanups.push(() => backend.close());
  const request = { instanceId: "project-a", workspace: { root: "projects", path: "project" } };
  const identity = await backend.create(request);
  assert.match(identity.containerId, /^[a-f0-9]{64}$/);
  assert.equal((await backend.inspect("project-a"))?.status, "running");
  assert.equal((await backend.create(request)).containerId, identity.containerId);
  assert.equal(f.calls.filter(x => x.route.startsWith("/containers/create?")).length, 1);
  const definition = f.calls.find(x => x.route.startsWith("/containers/create?"))!.body;
  assert.equal(definition.User, "1000:1000");
  assert.equal(definition.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(definition.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(definition.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(definition.HostConfig.NetworkMode, "none");
  assert.ok(definition.HostConfig.Memory > 0);
  assert.ok(definition.HostConfig.PidsLimit > 0);
  assert.equal(definition.HostConfig.Privileged, false);
  assert.equal(definition.HostConfig.Mounts.length, 2);
  assert.deepEqual(definition.HostConfig.Mounts[0], { Type: "bind", Source: path.join(f.work, "project"), Target: "/workspace", ReadOnly: false, BindOptions: { Propagation: "rprivate" } });
  assert.equal((await backend.stop("project-a")).status, "stopped");
  assert.equal(f.volumes.size, 1, "stopping must preserve the persistent home");
  assert.equal(f.calls.some(x => x.method === "DELETE"), false);
  await backend.close();
  backend = await DockerBackend.open(config);
  assert.equal((await backend.inspect("project-a"))?.status, "stopped");
  assert.equal((await backend.start("project-a")).status, "running");
  assert.equal((await backend.list()).length, 1);
  const item = f.containers.get(identity.containerId)!;
  item.Config.Labels["cn.swordfate.pi-manager.owner"] = "foreign";
  const count = f.calls.length;
  await assert.rejects(backend.stop("project-a"), /ownership/);
  assert.equal(f.calls.slice(count).some(x => x.route.endsWith("/stop?t=10")), false);
});

test("Docker backend rejects path escape, state alias, extra fields and changed daemon before mutation", async t => {
  const f = await dockerDaemon(t);
  const { DockerBackend } = await backendModule();
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { projects: f.work }, pathCoordinates: "host" });
  f.cleanups.push(() => backend.close());
  await mkdir(path.join(f.root, "outside"));
  await symlink(path.join(f.root, "outside"), path.join(f.work, "escape"));
  for (const selection of ["../outside", "escape", "/", "../../"]) {
    await assert.rejects(backend.create({ instanceId: "escape", workspace: { root: "projects", path: selection } }));
  }
  await assert.rejects(backend.create({ instanceId: "bad", workspace: { root: "projects", path: "project" }, command: ["sh"] } as any));
  assert.equal(f.calls.some(x => x.method === "POST"), false);
  f.behavior.daemonId = "other-daemon";
  await assert.rejects(backend.create({ instanceId: "bad", workspace: { root: "projects", path: "project" } }), /daemon/);
  assert.equal(f.calls.some(x => x.method === "POST"), false);
  await assert.rejects(DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: path.join(f.work, "private"), workspaceRoots: { projects: f.work }, pathCoordinates: "host" }), /overlap/);
});

test("lost Docker create response is recorded unknown and retry never creates another container", async t => {
  const f = await dockerDaemon(t);
  const { DockerBackend } = await backendModule();
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { projects: f.work }, pathCoordinates: "host", timeoutMs: 200 });
  f.cleanups.push(() => backend.close());
  f.behavior.loseCreateReply = true;
  const request = { instanceId: "lost", workspace: { root: "projects", path: "project" } };
  await assert.rejects(backend.create(request), /unknown/);
  f.behavior.loseCreateReply = false;
  await assert.rejects(backend.create(request), /reconciliation/);
  assert.equal(f.containers.size, 1);
  assert.equal(f.calls.filter(x => x.route.startsWith("/containers/create?")).length, 1);
  assert.equal(f.calls.some(x => x.method === "DELETE"), false);
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerBackend } from "../manager/backends/docker.ts";
import { executorConfig } from "../manager/config.ts";
import { WorkspacePolicy } from "../manager/workspaces.ts";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { dockerDaemon } from "./helpers/docker-daemon.ts";

async function profileFiles(root: string) {
  const packageRoot = path.join(root, "web");
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true }); await mkdir(path.join(packageRoot, "dist"));
  await writeFile(path.join(packageRoot, "extensions/mirror-server.ts"), "export default () => {};");
  await writeFile(path.join(packageRoot, "dist/index.html"), "html");
  const extensionRoot = path.join(root, "extension"); await mkdir(extensionRoot);
  await writeFile(path.join(extensionRoot, "index.ts"), "export default () => {};");
  const modelsFile = path.join(root, "models.json"); await writeFile(modelsFile, "{}");
  const hubConfigFile = path.join(root, "hub.json"); initializeHub(hubConfigFile, { port: 0 });
  await mkdir(readHubConfig(hubConfigFile).runtimeDir, { mode: 0o700 });
  return { web: { packageRoot, hubConfigFile, port: 18310 },
    runtimeProfile: { runtimeVolume: "pi-runtime-test", modelsFile, environment: { CUSTOM_PROVIDER_KEY: "private-fixture-value" }, extensions: [{ packageRoot: extensionRoot, entry: "index.ts" }] } };
}

test("executor accepts fixed profile/enrollment, rejects reserved environment and mutually exclusive authorities", () => {
  const config: any = {
    stateRoot: "/test/tasks", submitSocket: "/test/submit/rpc.sock", adminSocket: "/test/admin/rpc.sock", principals: [{ id: "user", role: "submitter", tokenHash: "a".repeat(64) }],
    trustedLocalNative: false, native: null, workspaces: {}, docker: {
      socketPath: "/test/docker.sock", stateRoot: "/test/docker-state", pathCoordinates: "host", daemonId: "daemon", image: `sha256:${"1".repeat(64)}`, workspaceRoots: { projects: "/test/projects" },
      web: { packageRoot: "/test/web", port: 18310, enrollment: { socketPath: "/test/enrollment/broker.sock", authorityFile: "/test/authority.json", registryHostDirectory: "/test/registry", exportHostDirectory: "/test/exports" } },
      startupTimeoutMs: 100, runtimeProfile: { environment: { CUSTOM_KEY: "secret-value" } },
    },
  };
  assert.doesNotThrow(() => executorConfig(config));
  for (const name of ["HOME", "PATH", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "PI_WEB_UI_PORT", "lowercase"]) {
    const bad = structuredClone(config); bad.docker.runtimeProfile.environment = { [name]: "secret-value" };
    assert.throws(() => executorConfig(bad), e => !(e as Error).message.includes("secret-value"));
  }
  for (const mutate of [
    (c: any) => { c.docker.web.hubConfigFile = "/test/hub.json"; },
    (c: any) => { delete c.docker.web; },
    (c: any) => { delete c.docker.web.enrollment; },
    (c: any) => { c.docker.startupTimeoutMs = 99; },
    (c: any) => { c.docker.startupTimeoutMs = 120001; },
    (c: any) => { c.docker.runtimeProfile.runtimeVolume = "../socket"; },
    (c: any) => { c.docker.runtimeProfile.environment = { X: "a\0b" }; },
    (c: any) => { c.docker.runtimeProfile.environment = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "x"])); },
    (c: any) => { c.docker.runtimeProfile.environment = { KEY: "x".repeat(8192) }; },
    (c: any) => { c.docker.runtimeProfile.extensions = [{ packageRoot: "/test/ext", entry: "../index.ts" }]; },
  ]) { const bad = structuredClone(config); mutate(bad); assert.throws(() => executorConfig(bad)); }
});

test("split-role workspace protection treats private registry/export as lexical host coordinates", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "split-workspaces-"));
  const projects = path.join(root, "projects"); await mkdir(path.join(projects, "normal"), { recursive: true });
  const hidden = path.join(projects, "chat-private"); await mkdir(hidden, { mode: 0 });
  t.after(async () => { await chmod(hidden, 0o700); await rm(root, { recursive: true, force: true }); });
  const enrollment = { socketPath: path.join(root, "ipc/broker.sock"), authorityFile: path.join(root, "authority.json"), registryHostDirectory: path.join(hidden, "runtime"), exportHostDirectory: path.join(hidden, "exports") };
  const config = executorConfig({ stateRoot: path.join(root, "tasks"), submitSocket: path.join(root, "submit/rpc.sock"), adminSocket: path.join(root, "admin/rpc.sock"),
    principals: [{ id: "user", role: "submitter", tokenHash: "a".repeat(64) }], trustedLocalNative: false, native: null, workspaces: {}, workspaceBrowser: { home: root, defaultRoot: "projects" },
    docker: { socketPath: path.join(root, "docker.sock"), daemonId: "daemon", image: `sha256:${"1".repeat(64)}`, stateRoot: path.join(root, "docker-state"), pathCoordinates: "host", workspaceRoots: { projects }, web: { packageRoot: path.join(root, "web"), port: 18310, enrollment } } });
  const policy = await WorkspacePolicy.open(config);
  assert.deepEqual((await policy.browse({ root: "projects", path: "" })).directories, [{ name: "normal", path: "normal" }]);
  await assert.rejects(policy.resolve({ root: "projects", path: "chat-private" }));
});

test("runtime profile validates canonical sources and rejects traversal/symlink entries before Docker", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-files-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "projects")); const profile = await profileFiles(root);
  const config = { socketPath: path.join(root, "docker.sock"), daemonId: "daemon", image: `sha256:${"1".repeat(64)}`, stateRoot: path.join(root, "journal"), pathCoordinates: "host" as const, workspaceRoots: { projects: path.join(root, "projects") }, ...profile };
  const backend = await DockerBackend.open(config); await backend.close();
  await symlink(profile.runtimeProfile.modelsFile, path.join(profile.runtimeProfile.extensions[0].packageRoot, "escape.js"));
  for (const entry of ["../models.json", "./index.ts", "a//b.ts", "a\\b.ts", "escape.js", "missing.ts"]) {
    await assert.rejects(DockerBackend.open({ ...config, runtimeProfile: { extensions: [{ ...profile.runtimeProfile.extensions[0], entry }] } }));
  }
});

test("installed Web/profile packages cannot carry enrollment or executor authority into Pi", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-authority-")); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = await profileFiles(root); await mkdir(path.join(root, "projects"));
  // Code files themselves are harmless, but mounting their parent would expose
  // the broker credential. Checking only the final file type would miss this.
  const authorityFile = path.join(profile.web.packageRoot, "authority.json");
  await writeFile(authorityFile, JSON.stringify({ token: "a".repeat(64) }), { mode: 0o600 });
  await mkdir(path.join(root, "ipc"), { mode: 0o700 });
  const config = { socketPath: path.join(root, "docker.sock"), daemonId: "daemon", image: `sha256:${"1".repeat(64)}`, stateRoot: path.join(root, "journal"), pathCoordinates: "host" as const, workspaceRoots: { projects: path.join(root, "projects") },
    web: { packageRoot: profile.web.packageRoot, port: 18310, enrollment: { socketPath: path.join(root, "ipc/enroll.sock"), authorityFile, registryHostDirectory: path.join(root, "registry"), exportHostDirectory: path.join(root, "exports") } } };
  let opened: DockerBackend | undefined;
  try { await assert.rejects(async () => { opened = await DockerBackend.open(config); }); }
  finally { await opened?.close(); }
});

test("runtime mounts are read-only/no-copy; normal tools and merged image environment survive reopen, tampering fails", async t => {
  const f = await dockerDaemon(t); const profile = await profileFiles(f.root);
  f.imageLabels["cn.swordfate.pi-manager.profile-home"] = "uid1000-v1";
  f.volumes.set("pi-runtime-test", { Name: "pi-runtime-test", Driver: "local", Options: null });
  const config = { socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host" as const, ...profile };
  let backend = await DockerBackend.open(config); f.cleanups.push(() => backend.close());
  const identity = await backend.create({ instanceId: "profile-one", workspace: { root: "work", path: "project" } });
  const definition = f.calls.find(c => c.route.startsWith("/containers/create?"))!.body;
  const mounts = definition.HostConfig.Mounts;
  assert.deepEqual(mounts.find((m: any) => m.Target === "/home/node/.local"), { Type: "volume", Source: "pi-runtime-test", Target: "/home/node/.local", ReadOnly: true, VolumeOptions: { NoCopy: true } });
  assert.equal(mounts.find((m: any) => m.Target === "/home/node/.pi/manager-agent/models.json").Source, profile.runtimeProfile.modelsFile);
  assert.equal(mounts.find((m: any) => m.Target === "/opt/pi-profile/extensions/0").ReadOnly, true);
  assert.ok(definition.Cmd.includes("/opt/pi-profile/extensions/0/index.ts"));
  for (const disabled of ["--no-extensions", "--no-context-files", "--no-mcp", "--no-skills"]) assert.ok(definition.Cmd.includes(disabled));
  assert.ok(!definition.Cmd.includes("--offline") && !definition.Cmd.includes("--no-tools"));
  assert.ok(!definition.Env.some((s: string) => s.startsWith("PI_OFFLINE=")), "Pi enables network only when PI_OFFLINE is undefined"); assert.ok(definition.Env.includes("CUSTOM_PROVIDER_KEY=private-fixture-value"));
  const item = f.containers.get(identity.containerId)!;
  assert.ok(item.Config.Env.includes("NODE_VERSION=24.0.0"), "fake daemon must model image environment merging");
  item.Config.Env.reverse(); await backend.close(); backend = await DockerBackend.open(config);
  assert.equal((await backend.inspect("profile-one"))?.containerId, identity.containerId);
  for (const mutate of [
    (x: any) => x.Config.Env.push("HOME=/other"),
    (x: any) => { x.Config.Env = x.Config.Env.filter((s: string) => !s.startsWith("NODE_VERSION=")); },
    (x: any) => { x.Config.Cmd = ["sh"]; },
    (x: any) => { x.Config.Entrypoint = ["sh"]; },
    (x: any) => { x.Mounts.find((m: any) => m.Destination === "/home/node/.local").RW = true; },
    (x: any) => { x.Mounts.find((m: any) => m.Destination === "/opt/pi-profile/extensions/0").Source = f.socketPath; },
    (x: any) => x.Mounts.push({ Type: "bind", Source: f.socketPath, Destination: "/run/docker.sock", RW: true }),
  ]) {
    const changed = structuredClone(item); mutate(changed); f.containers.set(identity.containerId, changed);
    await assert.rejects(backend.start("profile-one"), /contract|mount|ownership/);
  }
  f.containers.set(identity.containerId, item);
  assert.equal((await backend.stop("profile-one")).status, "stopped");
  assert.equal(f.calls.filter(c => c.route === "/volumes/create").length, 1, "only the independent home is created");
});

test("missing/nonlocal/runtime volume driver options are rejected without auto-create", async t => {
  const f = await dockerDaemon(t); const profile = await profileFiles(f.root);
  f.imageLabels["cn.swordfate.pi-manager.profile-home"] = "uid1000-v1";
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host", ...profile });
  f.cleanups.push(() => backend.close());
  const request = { instanceId: "invalid-volume", workspace: { root: "work", path: "project" } };
  for (const volume of [null, { Name: "pi-runtime-test", Driver: "nfs", Options: null }, { Name: "pi-runtime-test", Driver: "local", Options: { device: "/run/docker.sock", type: "none", o: "bind" } }]) {
    if (volume) f.volumes.set("pi-runtime-test", volume); else f.volumes.delete("pi-runtime-test");
    await assert.rejects(backend.create(request));
    assert.equal(f.calls.some(c => c.method === "POST"), false);
  }
});

test("online profile rejects an inherited PI_OFFLINE image environment instead of pretending 0 unsets it", async t => {
  const f = await dockerDaemon(t); const profile = await profileFiles(f.root);
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host", web: profile.web, runtimeProfile: {} });
  f.cleanups.push(() => backend.close());
  for (const value of ["1", "0", ""]) {
    f.imageEnv.push(`PI_OFFLINE=${value}`);
    await assert.rejects(backend.create({ instanceId: "offline-image", workspace: { root: "work", path: "project" } }), /image contract/);
    assert.equal(f.calls.some(c => c.method === "POST"), false);
    f.imageEnv.pop();
  }
});

test("models file bind requires a prepared UID1000 image home before enrollment or Docker mutation", async t => {
  const f = await dockerDaemon(t); const profile = await profileFiles(f.root);
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image, stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host", web: profile.web, runtimeProfile: { modelsFile: profile.runtimeProfile.modelsFile } });
  f.cleanups.push(() => backend.close());
  const request = { instanceId: "unprepared-home", workspace: { root: "work", path: "project" } };
  for (const label of [undefined, "root-owned", "uid1000-v2"]) {
    if (label === undefined) delete f.imageLabels["cn.swordfate.pi-manager.profile-home"];
    else f.imageLabels["cn.swordfate.pi-manager.profile-home"] = label;
    await assert.rejects(backend.create(request), /image contract/);
    assert.equal(f.calls.some(c => c.method === "POST"), false, "reject before any home/container mutation");
    await assert.rejects(import("node:fs/promises").then(fs => fs.stat(readHubConfig(profile.web.hubConfigFile).stateDir)), { code: "ENOENT" }, "no grant is issued for an unprepared image");
  }
  f.imageLabels["cn.swordfate.pi-manager.profile-home"] = "uid1000-v1";
  assert.ok((await backend.create(request)).containerId, "an administrator-attested prepared image can proceed");
});

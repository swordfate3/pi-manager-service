import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DockerBackend } from "../manager/backends/docker.ts";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { dockerDaemon } from "./helpers/docker-daemon.ts";

test("explicit Docker Web profile mounts only installed code, runtime socket and one instance grant", async t => {
  const f = await dockerDaemon(t);
  const webRoot = path.join(f.root, "installed-web");
  await mkdir(path.join(webRoot, "extensions"), { recursive: true });
  await mkdir(path.join(webRoot, "dist"));
  await writeFile(path.join(webRoot, "extensions", "mirror-server.ts"), "export default () => {};\n");
  await writeFile(path.join(webRoot, "dist", "index.html"), "<html></html>");
  const hubConfigFile = path.join(f.root, "hub.json");
  initializeHub(hubConfigFile, { port: 0 });
  const hub = readHubConfig(hubConfigFile);
  await mkdir(hub.runtimeDir, { recursive: true, mode: 0o700 });
  const backend = await DockerBackend.open({ socketPath: f.socketPath, daemonId: f.daemonId, image: f.image,
    stateRoot: f.state, workspaceRoots: { work: f.work }, pathCoordinates: "host",
    web: { packageRoot: webRoot, hubConfigFile, port: 18310 } } as any);
  f.cleanups.push(() => backend.close());
  const identity = await backend.create({ instanceId: "web-one", workspace: { root: "work", path: "project" } });
  const definition = f.calls.find(c => c.route.startsWith("/containers/create?"))!.body;
  assert.equal(definition.HostConfig.NetworkMode, "host");
  assert.ok(definition.Env.includes("PI_WEB_UI_REGISTRY_SOCKET=/run/pi-registry/registry.sock"));
  assert.ok(definition.Env.includes("PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=/run/pi-web/credential.json"));
  assert.ok(definition.Cmd.includes("/opt/pi-web/extensions/mirror-server.ts"));
  assert.ok(definition.Cmd.includes("--no-extensions"));
  assert.ok(definition.Cmd.includes("--continue"), "owned Web restart must select the retained conversation");
  for (const destination of ["/opt/pi-web", "/run/pi-registry", "/run/pi-web/credential.json"]) {
    assert.equal(definition.HostConfig.Mounts.find((m: any) => m.Target === destination)?.ReadOnly, true);
  }
  const grantMount = definition.HostConfig.Mounts.find((m: any) => m.Target === "/run/pi-web/credential.json");
  const grant = JSON.parse(await readFile(grantMount.Source, "utf8"));
  assert.match(grant.run_id, /^[a-f0-9]{32}$/);
  assert.match(grant.token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(identity).includes(grant.token));
  assert.ok(!definition.HostConfig.Mounts.some((m: any) => [f.state, hub.stateDir, hubConfigFile, f.socketPath].includes(m.Source)));
  await backend.stop("web-one");
  await backend.start("web-one");
  assert.equal((await backend.inspect("web-one"))?.containerId, identity.containerId);
});

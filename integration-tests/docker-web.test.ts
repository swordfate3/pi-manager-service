import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { DockerBackend } from "../manager/backends/docker.ts";
import { DockerEngine } from "../manager/backends/docker-engine.ts";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { listen } from "../manager/http.ts";
import { waitFor } from "../tests/helpers/native-harness.ts";

test("real new Docker Pi registers a packed Web, chats, stops and restores the same home", {
  skip: process.env.PI_MANAGER_DOCKER_TEST !== "1" || !process.env.PI_MANAGER_TEST_WEB_ROOT,
  timeout: 180_000,
}, async t => {
  const image = process.env.PI_MANAGER_DOCKER_TEST_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const socket = process.env.PI_MANAGER_DOCKER_TEST_SOCKET ?? "/var/run/docker.sock";
  const engine = new DockerEngine(socket, { timeoutMs: 120_000 });
  const snapshots = new Map<string, unknown>();
  for (const row of await engine.call("GET", "/containers/json?all=1") as any[]) {
    const c = await engine.call("GET", `/containers/${row.Id}/json`) as any;
    snapshots.set(row.Id, { started: c.State.StartedAt, running: c.State.Running, restarts: c.RestartCount });
  }
  const root = await mkdtemp(path.join(tmpdir(), "manager-docker-web-"));
  const state = path.join(root, "journal");
  let backend: DockerBackend | undefined;
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let ws: WebSocket | undefined;
  t.after(async () => {
    ws?.terminate(); await backend?.close(); await hub?.close();
    const journal = await readFile(path.join(state,"tasks.json"), "utf8").then(JSON.parse, () => ({ tasks: {} }));
    let unresolved = false;
    for (const record of Object.values(journal.tasks) as any[]) {
      const check = (labels: any) => {
        assert.equal(labels["cn.swordfate.pi-manager.owner"], record.requester);
        assert.equal(labels["cn.swordfate.pi-manager.nonce"], record.id);
        assert.equal(labels["cn.swordfate.pi-manager.instance"], record.target);
      };
      const c = await engine.call("GET", `/containers/pi-manager-${record.id.replaceAll("-", "")}/json`, undefined, { allowMissing: true }) as any;
      if (c) {
        check(c.Config.Labels); assert.equal(c.Image,image); assert.equal(snapshots.has(c.Id),false);
        if (c.State.Running) await engine.call("POST", `/containers/${c.Id}/stop?t=2`);
        await engine.call("DELETE", `/containers/${c.Id}`);
      } else if (record.state === "unknown") unresolved = true;
      const name = `pi-manager-home-${record.id.replaceAll("-", "")}`;
      const volume = await engine.call("GET", `/volumes/${name}`, undefined, { allowMissing: true }) as any;
      if (volume && !unresolved) { check(volume.Labels); await engine.call("DELETE", `/volumes/${name}`); }
    }
    for (const [id, expected] of snapshots) {
      const c = await engine.call("GET", `/containers/${id}/json`) as any;
      assert.deepEqual({ started:c.State.StartedAt, running:c.State.Running, restarts:c.RestartCount },expected,"existing container changed");
    }
    engine.close();
    assert.equal(unresolved,false,`Unresolved test outcome; retained evidence at ${root}`);
    await rm(root,{recursive:true,force:true});
  });
  const run = promisify(execFile);
  const packed = await run("npm",["pack","--ignore-scripts","--offline","--json","--pack-destination",root],{
    cwd:process.env.PI_MANAGER_TEST_WEB_ROOT,env:{PATH:process.env.PATH,HOME:root,NPM_CONFIG_USERCONFIG:path.join(root,"npmrc"),NPM_CONFIG_CACHE:path.join(root,"npm-cache")},timeout:15_000,
  });
  const [{filename}] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")));
  await run("tar",["-xzf",path.join(root,filename),"-C",root]);
  const web = path.join(root,"package"), provider = path.join(root,"provider");
  await mkdir(provider);
  await writeFile(path.join(provider,"index.ts"),await readFile(path.resolve("integration-tests/fixtures/native-provider.ts")));
  // Explicit test-image contract verified by a separate disposable --version probe.
  const pi = "/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent";
  for (const directory of [web,provider]) {
    await mkdir(path.join(directory,"node_modules","@earendil-works"),{recursive:true});
    await symlink(pi,path.join(directory,"node_modules","@earendil-works","pi-coding-agent"));
    await symlink(`${pi}/node_modules/@earendil-works/pi-ai`,path.join(directory,"node_modules","@earendil-works","pi-ai"));
  }
  await cp(path.resolve("node_modules/ws"),path.join(web,"node_modules","ws"),{recursive:true,dereference:true});
  const hubFile=path.join(root,"hub.json"); initializeHub(hubFile,{port:0});
  hub=await startHub(readHubConfig(hubFile),{versions:{source:async()=>({})}});
  const probe=await listen(async(_req,res)=>{res.end();},0);const port=probe.port;await probe.close();
  const work=path.join(root,"work");await mkdir(path.join(work,"project"),{recursive:true});
  const config={socketPath:socket,daemonId:(await engine.call("GET","/info") as any).ID,image,stateRoot:state,pathCoordinates:"host" as const,workspaceRoots:{work},timeoutMs:120_000,
    web:{packageRoot:web,hubConfigFile:hubFile,port,provider:{packageRoot:provider,name:"native-fixture",model:"deterministic"}}};
  backend=await DockerBackend.open(config);
  const owned=await backend.create({instanceId:"docker-web",workspace:{root:"work",path:"project"}});
  let session:any;
  await waitFor(async()=>{const value=await(await fetch(`${hub!.url}api/sessions`)).json() as any;session=value.sessions[0];return !!session;},20_000);
  const page=new URL(session.path,hub.url);
  assert.equal((await fetch(page)).status,200);
  ws=new WebSocket(new URL("ws",page).href.replace(/^http/,"ws"),{origin:new URL(hub.url).origin});
  const messages:any[]=[];ws.on("message",v=>messages.push(JSON.parse(v.toString())));
  await new Promise<void>((resolve,reject)=>{ws!.once("open",resolve);ws!.once("error",reject);});
  await waitFor(async()=>messages.some(m=>m.event==="state_sync"));
  ws.send(JSON.stringify({type:"req",id:"chat",method:"prompt",params:{message:"synthetic Docker Web acceptance"}}));
  await waitFor(async()=>JSON.stringify(messages).includes("NATIVE_PI_GENERATION_OK"),15_000);
  await backend.stop("docker-web");ws.terminate();
  assert.equal((await fetch(page)).status,410);
  await backend.close();backend=await DockerBackend.open(config);
  await backend.start("docker-web");
  assert.equal((await backend.inspect("docker-web"))?.containerId,owned.containerId);
  assert.equal((await engine.call("GET",`/volumes/${owned.homeVolume}`) as any).Name,owned.homeVolume);
  await waitFor(async()=>{const value=await(await fetch(`${hub!.url}api/sessions`)).json() as any;session=value.sessions[0];return value.sessions.length===1;},20_000);
  const restoredPage=new URL(session.path,hub.url);
  ws=new WebSocket(new URL("ws",restoredPage).href.replace(/^http/,"ws"),{origin:new URL(hub.url).origin});
  const restored:any[]=[];ws.on("message",v=>restored.push(JSON.parse(v.toString())));
  await new Promise<void>((resolve,reject)=>{ws!.once("open",resolve);ws!.once("error",reject);});
  await waitFor(async()=>restored.some(m=>m.event==="state_sync"));
  assert.ok(JSON.stringify(restored).includes("synthetic Docker Web acceptance"), "restored Pi must load the previous user turn");
  assert.ok(JSON.stringify(restored).includes("NATIVE_PI_GENERATION_OK"), "restored Pi must load the previous assistant turn");
  await backend.stop("docker-web");
});

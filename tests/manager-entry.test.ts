import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorClient } from "../manager/executor/client.ts";

test("independent CLI initializes explicit private paths, owns services, survives client disconnect and shuts down", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manager-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(root,"config"), XDG_DATA_HOME: path.join(root,"data"), XDG_CACHE_HOME:path.join(root,"cache"), PI_MANAGER_CONFIG:path.join(root,"unused.json"), PI_CODING_AGENT_DIR:path.join(root,"agent"), PI_WEB_UI_HUB_CONFIG:path.join(root,"legacy.json") };
  const cli = process.env.PI_MANAGER_TEST_ENTRY ?? path.resolve("bin/pi-manager-service.mjs");
  const directory = path.join(root, "service");
  const init = spawnSync(process.execPath, [cli, "init", "--directory", directory, "--chat-origin", "http://127.0.0.1:18200"], { env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const cfg = JSON.parse(await readFile(path.join(directory, "supervisor.json"), "utf8"));
  assert.equal(cfg.trustedLocalDevelopment, true);
  assert.equal((await stat(path.join(directory,"executor.json"))).mode & 0o077, 0);
  const publicText = await readFile(cfg.publicConfig, "utf8");
  assert.ok(!publicText.includes("admin"));
  const credential = JSON.parse(await readFile(path.join(directory,"requester-credential.json"), "utf8")).credential;
  assert.ok(!init.stdout.includes(credential));
  const publicConfig = JSON.parse(publicText); publicConfig.port = 0;
  await writeFile(cfg.publicConfig, JSON.stringify(publicConfig), {mode:0o600});
  const adminConfig = JSON.parse(await readFile(cfg.adminConfig,"utf8")); adminConfig.port=0;
  await writeFile(cfg.adminConfig,JSON.stringify(adminConfig),{mode:0o600});
  const child = spawn(process.execPath,[cli,"serve","--config",path.join(directory,"supervisor.json")],{env,stdio:["ignore","pipe","pipe"]});
  t.after(async () => { if(child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise(r=>child.once("exit",r)); } });
  let stdout=""; let stderr="";
  child.stderr.on("data",c=>{stderr+=c;});
  const ready = await new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("supervisor readiness timeout")),10000);
    child.once("exit",()=>{clearTimeout(timer);reject(Error("supervisor exited: "+stderr));});
    child.stdout.on("data",c=>{stdout+=c; if(stdout.includes("\n")){clearTimeout(timer);resolve(JSON.parse(stdout.split("\n")[0]));}});
  });
  assert.equal(ready.ready,true); assert.ok(ready.publicPort>0 && ready.adminPort>0);
  const client = new ExecutorClient({socketPath:publicConfig.socketPath,credential});
  assert.equal((await client.capabilities()).native,false);
  await assert.rejects(client.submitTask({key:"no-native",action:"create",target:"sample",workspace:"project"}));
  assert.deepEqual(await client.listTasks(),[]);
  const exited = new Promise<number|null>(resolve=>child.once("exit",resolve)); child.kill("SIGTERM"); assert.equal(await exited,0,stderr);
  await assert.rejects(access(publicConfig.socketPath));
  assert.ok(!stdout.includes(credential));
});

test("owned process entry closes cleanly when its supervisor IPC channel disconnects",async(t)=>{
  const home=await mkdtemp(path.join(tmpdir(),"manager-ipc-"));t.after(()=>rm(home,{recursive:true,force:true}));
  const moduleUrl=new URL("../manager/process-entry.ts",import.meta.url).href;
  const code=`import {runProcess} from ${JSON.stringify(moduleUrl)}; await runProcess(async()=>{const hold=setInterval(()=>{},1000);return {close:async()=>{clearInterval(hold);}};});`;
  const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","ignore","pipe","ipc"],env:{PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),PI_MANAGER_CONFIG:path.join(home,"unused.json"),PI_WEB_UI_HUB_CONFIG:path.join(home,"unused-hub.json"),PI_CODING_AGENT_DIR:path.join(home,"agent")}});
  let stderr="";child.stderr!.on("data",c=>{stderr+=c;});
  const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
  await new Promise<void>((resolve,reject)=>{child.once("message",()=>resolve());child.once("error",reject);});
  child.disconnect();assert.equal(await exited,0,stderr);
});

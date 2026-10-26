import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { absolute, privateDirectory, readPrivateJson, serviceConfig } from "./config.ts";
import { keys, record, requireThat } from "./validation.ts";

export async function supervise(value: unknown, entryUrl: string) {
  const config = record(value); keys(config,["trustedLocalDevelopment","executorConfig","publicConfig","adminConfig"],["chatConfig"]);
  // Native/same-UID ownership is deliberately opt-in. External isolation runs the three entries separately.
  requireThat(config.trustedLocalDevelopment === true,403);
  for (const name of ["executorConfig","publicConfig","adminConfig"]) absolute(config[name]);
  if (config.chatConfig !== undefined) absolute(config.chatConfig);
  const publicConfig=serviceConfig(await readPrivateJson(config.publicConfig as string));
  const adminConfig=serviceConfig(await readPrivateJson(config.adminConfig as string));
  requireThat(publicConfig.origin!==adminConfig.origin && publicConfig.chatOrigin===adminConfig.chatOrigin);
  const children: ChildProcess[]=[]; let stopping=false; let shutdown: Promise<void>|undefined;
  const close = () => shutdown ??= (async()=>{
    stopping=true;
    const outcomes=await Promise.all(children.map(child=>new Promise<boolean>(resolve=>{
      if(child.exitCode!==null || child.signalCode!==null) return resolve(child.exitCode===0);
      const timer=setTimeout(()=>{ child.kill("SIGKILL"); resolve(false); },130_000);
      child.once("exit",code=>{clearTimeout(timer);resolve(code===0);}); child.kill("SIGTERM");
    })));
    requireThat(outcomes.every(Boolean),503);
  })();
  const onSignal=()=>{void close().then(()=>{process.exitCode=0;},()=>{process.stderr.write("Manager shutdown incomplete\n");process.exitCode=1;});};
  process.once("SIGINT",onSignal);process.once("SIGTERM",onSignal);
  async function launch(role: "executor"|"public"|"admin"|"chat", file: string) {
    const home=path.join(path.dirname(file),role+"-home"); await privateDirectory(home);
    const child=spawn(process.execPath,[fileURLToPath(new URL(`pi-manager-${role}.mjs`,entryUrl)),"--config",file],{
      stdio:["ignore","ignore","ignore","ipc"],env:{PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,LANG:"C.UTF-8",HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),XDG_DATA_HOME:path.join(home,"data"),XDG_CACHE_HOME:path.join(home,"cache"),PI_MANAGER_CONFIG:path.join(home,"unused.json"),PI_CODING_AGENT_DIR:path.join(home,"agent"),PI_WEB_UI_HUB_CONFIG:path.join(home,"unused-hub.json")},
    });
    children.push(child);
    child.on("exit",()=>{if(!stopping){process.stderr.write("Manager owned service exited\n");void close().finally(()=>{process.exitCode=1;}).catch(()=>{});}});
    return new Promise<{port?:number}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error("Service startup deadline")),10000);
      child.once("error",()=>{clearTimeout(timer);reject(Error("Service start failed"));});
      child.once("exit",()=>{clearTimeout(timer);reject(Error("Service exited before ready"));});
      child.once("message",message=>{clearTimeout(timer);if(message && typeof message==="object" && "ready" in message && message.ready===true)resolve(message as {port?:number});else reject(Error("Invalid readiness"));});
    });
  }
  try {
    const chat = config.chatConfig ? await launch("chat",config.chatConfig as string) : undefined;
    await launch("executor",config.executorConfig as string);
    const pub=await launch("public",config.publicConfig as string);
    const admin=await launch("admin",config.adminConfig as string);
    return {publicPort:pub.port,adminPort:admin.port,...(chat ? {chatPort:chat.port} : {}),close};
  } catch(error) {await close().catch(()=>{});throw error;}
}

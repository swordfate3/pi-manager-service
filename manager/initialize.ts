import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { absolute, executorConfig, origin, privateDirectory, serviceConfig } from "./config.ts";
import { digest, requireThat } from "./validation.ts";

export async function initialize(options: Map<string, string>) {
  const directory = absolute(options.get("--directory"));
  const chatOrigin = origin(options.get("--chat-origin"));
  const native = options.has("--native-executable");
  requireThat(native ? options.get("--trusted-local-native") === "yes" && options.has("--workspace") : !options.has("--trusted-local-native") && !options.has("--workspace"));
  const submitSocket = path.join(directory,"submit","rpc.sock"), adminSocket = path.join(directory,"admin","rpc.sock");
  requireThat(Buffer.byteLength(submitSocket) <= 100 && Buffer.byteLength(adminSocket) <= 100);
  const requester = randomBytes(32).toString("hex"), admin = randomBytes(32).toString("hex");
  const executor = executorConfig({ stateRoot:path.join(directory,"tasks"),submitSocket,adminSocket,
    principals:[{id:"requester",role:"submitter",tokenHash:digest(requester)},{id:"administrator",role:"admin",tokenHash:digest(admin)}],
    trustedLocalNative:native,
    native:native ? {piExecutable:absolute(options.get("--native-executable")),workspaceRoots:{allowed:absolute(options.get("--workspace"))},stateRoot:path.join(directory,"native-state"),agentRoot:path.join(directory,"native-agents")} : null,
    workspaces:native ? {project:{label:"Allowed project",root:"allowed",path:"."}} : {},
  });
  const publicConfig=serviceConfig({socketPath:submitSocket,origin:options.get("--public-origin") ?? "http://127.0.0.1:18201",chatOrigin,port:Number(new URL(options.get("--public-origin") ?? "http://127.0.0.1:18201").port || 80)});
  const adminConfig=serviceConfig({socketPath:adminSocket,origin:options.get("--admin-origin") ?? "http://127.0.0.1:18202",chatOrigin,port:Number(new URL(options.get("--admin-origin") ?? "http://127.0.0.1:18202").port || 80)});
  requireThat(publicConfig.origin !== adminConfig.origin);
  // Refuse overwrite: init never imports production or legacy configuration.
  await mkdir(directory,{mode:0o700}); await privateDirectory(directory);
  for (const name of ["submit","admin","public-home","admin-home","executor-home"]) await privateDirectory(path.join(directory,name));
  const documents = {"executor.json":executor,"public.json":publicConfig,"admin.json":adminConfig,
    "chat.json": { port: Number(new URL(chatOrigin).port || (chatOrigin.startsWith("https:") ? 443 : 80)), stateDir: path.join(directory,"chat-state"), runtimeDir:path.join(directory,"chat-runtime") },
    "requester-credential.json":{credential:requester},"administrator-credential.json":{credential:admin},
    "supervisor.json":{trustedLocalDevelopment:true,executorConfig:path.join(directory,"executor.json"),publicConfig:path.join(directory,"public.json"),adminConfig:path.join(directory,"admin.json"),chatConfig:path.join(directory,"chat.json")}};
  for (const [name,data] of Object.entries(documents)) await writeFile(path.join(directory,name),JSON.stringify(data,null,2)+"\n",{mode:0o600,flag:"wx"});
}

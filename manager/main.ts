import { initialize } from "./initialize.ts";
import { supervise } from "./supervisor.ts";
import { readPrivateJson } from "./config.ts";
import { requireThat } from "./validation.ts";

export async function main(args: string[], entryUrl: string) {
  if (!args.length || ["help","--help"].includes(args[0])) {
    process.stdout.write(`Pi Manager independent task service (legacy pi-manager Hub CLI is unchanged)\n
pi-manager-service init --directory /private/new-directory --chat-origin http://127.0.0.1:18200
  [--public-origin http://127.0.0.1:18201] [--admin-origin http://127.0.0.1:18202]
  [--trusted-local-native yes --native-executable /absolute/pi --workspace /allowed/project]
pi-manager-service serve --config /private/new-directory/supervisor.json

Init writes credentials into separate private files, never stdout. No legacy state is read.
Serve is opt-in trusted-local development, NOT isolation from same-UID code. It owns three
service children and does not depend on a Pi/client lifetime. Native is unavailable by default.
For separately provisioned isolation, start pi-manager-public, pi-manager-admin and
pi-manager-executor independently, each with --config /its/private/config.json. Provision
distinct OS/container permissions and submit/admin socket directory access externally.
No configuration assertion proves isolation. No host users/groups/sudo are changed here.
Admin UI login uses administrator-credential.json only on the private administrator origin.
Requester credentials never approve. Queued tasks require fresh approval after restart;
unknown tasks are never replayed. Existing Pi PIDs are never adopted.
Pi→Web enrollment/chat, Docker, updates and MCP are not implemented by this service slice.
`); return;
  }
  const command=args[0]; requireThat(command==="init" || command==="serve");
  const allowed=command==="serve" ? ["--config"] : ["--directory","--chat-origin","--public-origin","--admin-origin","--trusted-local-native","--native-executable","--workspace"];
  const options=new Map<string,string>();
  for(let i=1;i<args.length;i+=2){requireThat(allowed.includes(args[i]) && !options.has(args[i]) && args[i+1] && !args[i+1].startsWith("--"));options.set(args[i],args[i+1]);}
  if(command==="init") { await initialize(options); process.stdout.write('{"initialized":true,"scope":"trusted-local-development"}\n'); }
  else { requireThat(options.has("--config")); const supervisor=await supervise(await readPrivateJson(options.get("--config")!),entryUrl); process.stdout.write(JSON.stringify({ready:true,publicPort:supervisor.publicPort,adminPort:supervisor.adminPort,scope:"trusted-local-development"})+"\n"); }
}

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { localConfig } from "./local-config.ts";
import { LocalStore } from "./local-store.ts";
import { hashPassword } from "./local-security.ts";
import { requireThat } from "./validation.ts";

export async function resetLocalAccount(value:unknown,ask:(label:string,hidden:boolean)=>Promise<string>) {
  const config=localConfig(value);
  const user=await ask("新用户名：",false);
  requireThat(/^[\p{L}\p{N}_.@-]{1,64}$/u.test(user));
  const password=await ask("新密码（至少12字符，不显示）：",true);
  const confirmation=await ask("再次输入新密码：",true);requireThat(password === confirmation);
  const hash=await hashPassword(password),store=await LocalStore.open(config.stateRoot);
  try {const account=store.account();if(account) store.changeAccount(user,hash,account.version);else store.createAccount(user,hash);}
  finally {store.close();}
}
export async function terminalQuestion(label:string,hidden:boolean) {
  requireThat(process.stdin.isTTY && process.stderr.isTTY,400);
  const sink=hidden ? new Writable({write(_chunk,_encoding,done){done();}}) : process.stderr;
  const input=createInterface({input:process.stdin,output:sink,terminal:true});
  try {if(hidden) process.stderr.write(label);return await input.question(hidden ? "" : label);}
  finally {input.close();if(hidden) {sink.end();process.stderr.write("\n");}}
}

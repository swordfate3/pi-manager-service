import assert from "node:assert/strict";
import { mkdir,mkdtemp,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resetLocalAccount } from "../manager/local-account-cli.ts";
import { LocalStore } from "../manager/local-store.ts";
import { LocalAuth } from "../manager/local-auth.ts";

test("local terminal recovery initializes without a default and revokes old sessions on reset",async()=> {
  const root=await mkdtemp(path.join(tmpdir(),"pi-account-cli-")),home=path.join(root,"home");await mkdir(path.join(home,"projects"),{recursive:true});
  const config={port:0,chatPort:0,home,workspaceRoots:{projects:path.join(home,"projects")},defaultWorkspace:{root:"projects",path:"demo"},stateRoot:path.join(root,"state"),launcher:path.join(root,"bin","launcher"),hubCli:path.join(root,"hub.mjs")};
  const flags:boolean[]=[];let values=["owner","old-password-long","old-password-long"];
  const ask=async(_label:string,hidden:boolean)=>{flags.push(hidden);return values.shift()!;};
  await resetLocalAccount(config,ask);assert.deepEqual(flags,[false,true,true]);
  const store=await LocalStore.open(config.stateRoot),auth=new LocalAuth(store,false);
  const login=await auth.login({username:"owner",password:"old-password-long"},"test");
  values=["owner","new-password-long","new-password-long"];await resetLocalAccount(config,ask);
  assert.equal(auth.authenticate(login.token),undefined);
  await assert.rejects(auth.login({username:"owner",password:"old-password-long"},"test"));
  assert.ok((await auth.login({username:"owner",password:"new-password-long"},"test")).token);
  const bytes=await readFile(path.join(config.stateRoot,"manager.sqlite3"));
  assert.equal(bytes.includes(Buffer.from("new-password-long")),false);assert.equal(bytes.includes(Buffer.from(login.token)),false);
  store.close();
});

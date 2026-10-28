import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStore } from "../manager/local-store.ts";
import { LocalAuth } from "../manager/local-auth.ts";

test("setup is once only; login token persists and logout invalidates it", async()=> {
  const root=await mkdtemp(path.join(tmpdir(),"local-auth-"));
  let store=await LocalStore.open(root),auth=new LocalAuth(store,false);
  const result=await auth.setup({username:"fate",password:"a-long-test-password"});
  assert.ok(auth.authenticate(result.token));
  await assert.rejects(auth.setup({username:"other",password:"a-long-test-password"}));
  await assert.rejects(auth.login({username:"fate",password:"wrong"},"127.0.0.1"));
  store.close(); store=await LocalStore.open(root); auth=new LocalAuth(store,false);
  assert.ok(auth.authenticate(result.token));
  auth.logout(auth.authenticate(result.token)!); assert.equal(auth.authenticate(result.token),undefined);
  store.close();
});
test("password change requires current password, revokes every session, HTTPS denies initial web setup", async()=> {
  const store=await LocalStore.open(await mkdtemp(path.join(tmpdir(),"local-auth-change-")));
  const auth=new LocalAuth(store,false);
  await assert.rejects(new LocalAuth(store,true).setup({username:"x",password:"a-long-test-password"}));
  const first=await auth.setup({username:"fate",password:"a-long-test-password"});
  const second=await auth.login({username:"fate",password:"a-long-test-password"},"127.0.0.1");
  await assert.rejects(auth.change(auth.authenticate(first.token)!,{currentPassword:"wrong",username:"new",password:"another-long-password"}));
  await auth.change(auth.authenticate(first.token)!,{currentPassword:"a-long-test-password",username:"new",password:"another-long-password"});
  assert.equal(auth.authenticate(first.token),undefined); assert.equal(auth.authenticate(second.token),undefined);
  assert.ok((await auth.login({username:"new",password:"another-long-password"},"127.0.0.1")).token);
  store.close();
});
test("failed anonymous logins cannot hard-ban a correct password behind the same proxy",async()=> {
  const store=await LocalStore.open(await mkdtemp(path.join(tmpdir(),"local-auth-proxy-"))),auth=new LocalAuth(store,false);
  await auth.setup({username:"owner",password:"correct-password-long"});
  for(let i=0;i<5;i++) await assert.rejects(auth.login({username:"attacker",password:"wrong-password-long"},"127.0.0.1"));
  assert.ok((await auth.login({username:"owner",password:"correct-password-long"},"127.0.0.1")).token);
  store.close();
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskEngine } from "../manager/executor/engine.ts";
import { TaskStore } from "../manager/task-store.ts";
import type { ExecutorConfig } from "../manager/config.ts";
import type { TaskBackendAdapter } from "../manager/executor/adapter.ts";

const requester="synthetic-requester-0000000000000001", administrator="synthetic-administrator-000000000001";
async function fixture(t: any) {
  const root=await mkdtemp(path.join(tmpdir(),"manager-engine-"));
  const closers: (()=>Promise<void>)[]=[];
  t.after(async()=>{try{for(const close of closers)await close();}finally{await rm(root,{recursive:true,force:true});}});
  const config:ExecutorConfig={stateRoot:path.join(root,"tasks"),submitSocket:path.join(root,"submit","rpc.sock"),adminSocket:path.join(root,"admin","rpc.sock"),native:null,trustedLocalNative:false,workspaces:{},principals:[{id:"agent",role:"submitter",tokenHash:createHash("sha256").update(requester).digest("hex")},{id:"admin",role:"admin",tokenHash:createHash("sha256").update(administrator).digest("hex")} ]};
  return {root,config,closers};
}

test("executor startup marks stranded running tasks unknown and never replays them",async t=>{
  const f=await fixture(t);const store=await TaskStore.open(f.config.stateRoot);
  const task=await store.submit({key:"one",requester:"agent",action:"create",target:"sample",payload:{workspace:"project"}});
  const queued=await store.transition(task.id,"pending_approval","queued",{expectedRevision:1});
  await store.transition(task.id,"queued","running",{expectedRevision:queued.revision});await store.close();
  const engine=await TaskEngine.open(f.config);f.closers.push(()=>engine.close());
  const result=await engine.dispatch("submit",requester,{op:"get",taskId:task.id}) as any;
  assert.equal(result.state,"unknown");assert.equal(result.revision,4);
  await assert.rejects(engine.dispatch("admin",administrator,{op:"execute",taskId:task.id,revision:4}),{status:409});
  await assert.rejects(engine.dispatch("admin",administrator,{op:"approve",taskId:task.id,revision:4,requestHash:"x",policyHash:"x"}),{status:409});
});

test("executor bypass cannot forge requester, self-approve, cross transport or query another principal",async t=>{
  const f=await fixture(t);const store=await TaskStore.open(f.config.stateRoot);
  const task=await store.submit({key:"one",requester:"admin",action:"create",target:"sample",payload:{workspace:"project"}});await store.close();
  const engine=await TaskEngine.open(f.config);f.closers.push(()=>engine.close());
  await assert.rejects(engine.dispatch("submit",requester,{op:"approve"}),{status:403});
  await assert.rejects(engine.dispatch("submit",administrator,{op:"list"}),{status:403});
  await assert.rejects(engine.dispatch("admin",requester,{op:"list"}),{status:403});
  assert.deepEqual(await engine.dispatch("submit",requester,{op:"list"}),[]);
  await assert.rejects(engine.dispatch("submit",requester,{op:"get",taskId:task.id}),{status:404});
  const review=await engine.dispatch("admin",administrator,{op:"review",taskId:task.id}) as any;
  await assert.rejects(engine.dispatch("admin",administrator,{op:"approve",...review.binding}),{status:403});
  await assert.rejects(engine.dispatch("admin",administrator,{op:"execute",taskId:task.id,revision:1,argv:["evil"]}),{status:400});
});

test("backend close failure is reported but TaskStore writer lock is still released",async t=>{
  const f=await fixture(t);
  // Only the external shutdown failure is injected; the writer and lock are real.
  const adapter:TaskBackendAdapter={policy:{},actions:[],validate:async()=>{throw Error("unavailable");},execute:async()=>{throw Error("unavailable");},resources:()=>[],close:async()=>{throw Error("synthetic shutdown failure");}};
  const engine=await TaskEngine.open(f.config,adapter);
  await assert.rejects(engine.close(),/synthetic shutdown failure/);
  await assert.rejects(engine.dispatch("submit",requester,{op:"list"}),{status:503});
  const reopened=await TaskStore.open(f.config.stateRoot);await reopened.close();
});

test("adapter policy drift after review invalidates approval instead of executing under new policy",async t=>{
  const f=await fixture(t);const store=await TaskStore.open(f.config.stateRoot);
  const task=await store.submit({key:"policy",requester:"agent",action:"create",target:"sample",payload:{workspace:"project"}});await store.close();
  const policy={revision:"one"};
  const adapter:TaskBackendAdapter={policy,actions:["create"],validate:async()=>{},execute:async()=>{throw Error("must not execute");},resources:()=>[],close:async()=>{}};
  const engine=await TaskEngine.open(f.config,adapter);f.closers.push(()=>engine.close());
  const review=await engine.dispatch("admin",administrator,{op:"review",taskId:task.id}) as any;
  policy.revision="two";
  await assert.rejects(engine.dispatch("admin",administrator,{op:"approve",...review.binding}),{status:409});
  assert.equal((await engine.dispatch("submit",requester,{op:"get",taskId:task.id}) as any).state,"pending_approval");
});

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NativeBackend } from "../manager/backends/native.ts";
import { assertDead, harness } from "./helpers/native-harness.ts";

test("explicit native resume launches a fresh owned child with the exact retained private state", async t => {
  const f = await harness(t);
  assert.equal(typeof (f.backend as any).resume, "function", "native resume is not implemented");
  const first = await f.backend.create(f.request);
  await assert.rejects((f.backend as any).resume(f.request, first), /owned|starting|active/i);
  const cannotAdopt = new NativeBackend(f.config);
  await assert.rejects(cannotAdopt.resume(f.request, first), /active/i);
  assert.deepEqual(cannotAdopt.list(), []);
  await writeFile(path.join(first.stateDir, "sessions", "retained-marker"), "retained conversation");
  await f.backend.stop(f.request.instanceId); assertDead(first.pid);
  const fresh = new NativeBackend(f.config);
  t.after(async () => { await fresh.stop(f.request.instanceId); });
  const resumed = await (fresh as any).resume(f.request, first);
  assert.notEqual(resumed.pid, first.pid);
  assert.equal(resumed.stateDir, first.stateDir); assert.equal(resumed.agentDir, first.agentDir);
  assert.equal(await readFile(path.join(resumed.stateDir, "sessions", "retained-marker"), "utf8"), "retained conversation");
  assert.equal((await fresh.inspect(f.request.instanceId))?.status, "ready");
});

test("native recovery is data-only authority and uncertain generations remain blocked", async t => {
  const f = await harness(t);
  const { NativeTaskAdapter } = await import("../manager/executor/native-adapter.ts");
  const identity = await f.backend.create(f.request);
  await f.backend.stop(f.request.instanceId);
  const cfg = { stateRoot: path.join(f.parent,"tasks"), submitSocket:path.join(f.parent,"submit","rpc.sock"), adminSocket:path.join(f.parent,"admin","rpc.sock"), principals:[], trustedLocalNative:true,
    native:{...f.config,web:{extensionPath:path.join(f.parent,"web.ts"),hubConfigFile:path.join(f.parent,"chat.json"),port:18881}},
    workspaces:{project:{label:"Project",root:"work",path:"project"}} };
  const saved = { workspace:"project", identity };
  const base = {id:"11111111-1111-4111-8111-111111111111",key:"create",action:"create",target:f.request.instanceId,requester:"alice",payload:{workspace:"project"},state:"succeeded",revision:4,
    createdAt:"2026-10-26T00:00:00.000Z",updatedAt:"2026-10-26T00:00:00.000Z",result:{status:"created",instanceId:f.request.instanceId,saved}} as any;
  const adapter = new NativeTaskAdapter(cfg);
  t.after(()=>adapter.close()); adapter.restore([base]);
  const start = { ...base, action:"start",payload:{} };
  await adapter.validate(start);
  await assert.rejects(adapter.validate({...start,requester:"bob"}),{status:403});
  assert.deepEqual(adapter.resources("alice"),[],"recovery never adopts an audit PID");
  const uncertain = new NativeTaskAdapter(cfg);
  t.after(()=>uncertain.close());
  uncertain.restore([base,{...start,id:"22222222-2222-4222-8222-222222222222",state:"unknown",result:undefined}]);
  await assert.rejects(uncertain.validate(start),{status:409});
});

test("native resume refuses forged audit identities and cannot select a different workspace", async t => {
  const f = await harness(t);
  assert.equal(typeof (f.backend as any).resume, "function", "native resume is not implemented");
  const first = await f.backend.create(f.request);
  await f.backend.stop(f.request.instanceId);
  const fresh = new NativeBackend(f.config);
  for (const change of [{ pid: process.pid }, { stateDir: f.workspace }, { agentDir: first.stateDir }, { workspace: f.parent }, { auditFile: "../identity.json" }]) {
    await assert.rejects((fresh as any).resume(f.request, { ...first, ...change }));
    assert.deepEqual(fresh.list(), []);
  }
  await writeFile(path.join(first.stateDir, "identity.json"), "{}");
  await assert.rejects((fresh as any).resume(f.request, first));
  assert.deepEqual(fresh.list(), []);
});

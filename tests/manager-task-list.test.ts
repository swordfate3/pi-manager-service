import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../manager/task-store.ts";

test("TaskStore list returns a durable independent snapshot and rejects reads after close", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(),"manager-list-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let store = await TaskStore.open(root);
  const first = await store.submit({key:"one",requester:"agent",action:"create",target:"sample",payload:{workspace:"project"}});
  const snapshot = await store.list();
  assert.equal(snapshot.length,1);
  (snapshot[0].payload as Record<string,unknown>).workspace="changed";
  assert.deepEqual((await store.list())[0].payload,{workspace:"project"});
  await store.close(); await assert.rejects(store.list());
  store=await TaskStore.open(root);
  assert.equal((await store.list())[0].id,first.id); await store.close();
});

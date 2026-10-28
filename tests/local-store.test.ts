import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStore } from "../manager/local-store.ts";

test("SQLite imports runs once, preserves a byte-identical backup and survives reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-local-store-"));
  const rows = [{id:"pi-local-"+"a".repeat(24),key:"first",workspace:{root:"projects",path:"demo"},state:"stopped",created:1}];
  const source = JSON.stringify(rows, null, 2);
  await writeFile(path.join(root,"runs.json"),source);
  let store = await LocalStore.open(root);
  assert.deepEqual(store.runs(),rows);
  assert.equal(await readFile(path.join(root,"runs.json.pre-sqlite.bak"),"utf8"),source);
  store.saveRuns([]); store.preference("workspace",{root:"projects",path:"next"}); store.close();
  store = await LocalStore.open(root);
  assert.deepEqual(store.runs(),[]);
  assert.deepEqual(store.preference("workspace"),{root:"projects",path:"next"});
  assert.equal((await stat(path.join(root,"manager.sqlite3"))).mode & 0o777,0o600);
  store.close();
});
test("corrupt migration fails closed without claiming it was imported", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"pi-local-corrupt-"));
  await writeFile(path.join(root,"runs.json"),'[{"id":"bad"}]');
  await assert.rejects(LocalStore.open(root));
  await writeFile(path.join(root,"runs.json"),'[]');
  const store = await LocalStore.open(root); assert.deepEqual(store.runs(),[]); store.close();
});
test("account generation and session hashes persist; password update atomically revokes sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"pi-local-account-"));
  let store = await LocalStore.open(root);
  assert.equal(store.account(),undefined);
  store.createAccount("user","hashed-password");
  assert.throws(()=>store.createAccount("other","hash"));
  const account = store.account()!;
  store.addSession({hash:"1".repeat(64),csrf:"c".repeat(43),expires:Date.now()+60000,version:account.version});
  store.addSession({hash:"2".repeat(64),csrf:"d".repeat(43),expires:1,version:account.version});
  assert.equal(store.session("2".repeat(64)),undefined);
  store.close(); store = await LocalStore.open(root);
  assert.equal(store.session("1".repeat(64))?.csrf,"c".repeat(43));
  store.changeAccount("new-user","new-hash",account.version);
  assert.equal(store.session("1".repeat(64)),undefined);
  assert.equal(store.account()!.username,"new-user");
  assert.throws(()=>store.changeAccount("old","hash",account.version));
  store.close();
});

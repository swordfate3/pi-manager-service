import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { TaskRecord } from "../manager/contracts.ts";
import { NativeTaskAdapter } from "../manager/executor/native-adapter.ts";
import { harness } from "./helpers/native-harness.ts";

function task(action: string, requester = "alice"): TaskRecord {
  return { id: "11111111-1111-4111-8111-111111111111", key: action, action, target: "owned-name", requester,
    payload: action === "create" ? { workspace: "project" } : {}, state: "running", revision: 3, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" } as TaskRecord;
}
async function adapter(t: any, scenario = "normal") {
  const cleanups: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any, scenario);
  const a = new NativeTaskAdapter({ stateRoot: path.join(f.parent, "tasks"), submitSocket: path.join(f.parent, "submit.sock"), adminSocket: path.join(f.parent, "admin.sock"),
    trustedLocalNative: true, native: f.config, principals: [], workspaces: { project: { label: "Project", root: "work", path: "project" } } });
  t.after(async () => { await a.close(); for (const cleanup of cleanups) await cleanup(); });
  return { ...f, adapter: a };
}

test("a native target is reserved before await and cannot be reused by another principal", async t => {
  const f = await adapter(t);
  const create = f.adapter.execute(task("create"));
  try { await assert.rejects(f.adapter.validate(task("create", "bob")), { status: 409 }); }
  finally { await create; }
  await f.adapter.execute(task("stop"));
  await assert.rejects(f.adapter.validate(task("create", "bob")), { status: 409 });
  assert.deepEqual(f.adapter.resources("alice"), []);
});

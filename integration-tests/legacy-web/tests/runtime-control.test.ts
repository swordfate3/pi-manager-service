import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import "../extensions/runtime-stdin-guard.mjs";
import { type RuntimeSnapshot, startRuntimeControl } from "../extensions/runtime-control.ts";

const token = "a".repeat(64);
const operation = "b".repeat(32);
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-runtime-adapter-"));
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, "saved\n");
  let snapshot: RuntimeSnapshot = {
    run_id: "c".repeat(32),
    runtime_id: "runtime-1",
    session_id: "session-1",
    leaf_id: "leaf-1",
    session_file: file,
    cwd: directory,
    version: "1.1.0",
    idle: true,
    pending: false,
    busy: false,
    provider: "faux",
    model: "faux-1",
    thinking: "off",
  };
  const socket = path.join(directory, "extension.sock");
  const adapter = await startRuntimeControl(
    {
      PI_RUNTIME_RUN_ID: snapshot.run_id,
      PI_RUNTIME_CHILD_TOKEN: token,
      PI_RUNTIME_EXTENSION_SOCKET: socket,
    },
    () => snapshot,
  );
  assert.ok(adapter);
  const request = (value: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socket);
      let data = "";
      client.on("connect", () => client.end(`${JSON.stringify({ token, ...value })}\n`));
      client.on("data", (chunk) => {
        data += chunk;
      });
      client.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
      client.on("error", reject);
    });
  return {
    directory,
    adapter,
    request,
    set: (value: Partial<RuntimeSnapshot>) => {
      snapshot = { ...snapshot, ...value };
    },
    close: async () => {
      await adapter.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("runtime IPC is opt-in and rejects partially configured supervision", async () => {
  assert.equal(await startRuntimeControl({}, () => null), undefined);
  await assert.rejects(startRuntimeControl({ PI_RUNTIME_CHILD_TOKEN: token }, () => null));
});

test("only the current child token can read a fresh runtime snapshot", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request({ action: "snapshot", token: "d".repeat(64) })).ok, false);
    assert.equal((await f.request({ action: "snapshot" })).result.runtime_id, "runtime-1");
    f.set({ runtime_id: "runtime-2", session_id: "session-2" });
    assert.equal((await f.request({ action: "snapshot" })).result.session_id, "session-2");
    assert.equal(statSync(path.join(f.directory, "extension.sock")).mode & 0o077, 0);
  } finally {
    await f.close();
  }
});

test("prepare freezes one exact saved session and only a matching cancel releases it", async () => {
  const f = await fixture();
  try {
    const expected = { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" };
    const prepare = { action: "prepare", operation_id: operation, expected };
    assert.equal((await f.request({ ...prepare, expected: { ...expected, leaf_id: "other" } })).ok, false);
    assert.equal(f.adapter.prepared, false);
    assert.equal((await f.request(prepare)).ok, true);
    assert.equal(f.adapter.prepared, true);
    assert.equal((await f.request(prepare)).ok, true);
    assert.equal((await f.request({ ...prepare, operation_id: "e".repeat(32) })).ok, false);
    assert.equal((await f.request({ action: "cancel", operation_id: "f".repeat(32) })).ok, false);
    assert.equal(f.adapter.prepared, true);
    assert.equal((await f.request({ action: "cancel", operation_id: operation })).ok, true);
    assert.equal(f.adapter.prepared, false);
  } finally {
    await f.close();
  }
});

test("stable future releases use the intact guard contract, not a version allowlist", async () => {
  const f = await fixture();
  try {
    f.set({ version: "1.3.0" });
    assert.equal((await f.request({ action: "snapshot" })).result.busy, false);
    const expected = { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" };
    assert.equal((await f.request({ action: "prepare", operation_id: operation, expected })).ok, true);
    assert.equal((await f.request({ action: "cancel", operation_id: operation })).ok, true);
    f.set({ version: "99.0.0" });
    assert.equal((await f.request({ action: "snapshot" })).result.busy, false);
    assert.equal((await f.request({ action: "prepare", operation_id: operation, expected })).ok, true);
    assert.equal((await f.request({ action: "cancel", operation_id: operation })).ok, true);
    f.set({ version: "nightly-unversioned" });
    assert.equal((await f.request({ action: "snapshot" })).result.busy, true);
    assert.equal((await f.request({ action: "prepare", operation_id: operation, expected })).ok, false);
  } finally {
    await f.close();
  }
});

for (const state of [{ idle: false }, { pending: true }, { busy: true }, { session_file: null }]) {
  test(`prepare refuses unsafe state ${JSON.stringify(state)}`, async () => {
    const f = await fixture();
    try {
      f.set(state);
      const reply = await f.request({
        action: "prepare",
        operation_id: operation,
        expected: { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" },
      });
      assert.equal(reply.ok, false);
      assert.equal(f.adapter.prepared, false);
      assert.ok(!JSON.stringify(reply).includes(f.directory));
    } finally {
      await f.close();
    }
  });
}

test("snapshot failures are generic and close removes only the owned socket", async () => {
  const f = await fixture();
  const saved = readFileSync(path.join(f.directory, "session.jsonl"), "utf8");
  f.set({ version: "\nsecret" });
  assert.equal((await f.request({ action: "snapshot" })).ok, false);
  await f.adapter.close();
  assert.equal(readFileSync(path.join(f.directory, "session.jsonl"), "utf8"), saved);
  rmSync(f.directory, { recursive: true, force: true });
});

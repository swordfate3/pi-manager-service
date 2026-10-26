import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./helpers/rpc-guard-child.mjs", import.meta.url));
const preload = fileURLToPath(new URL("../runtime/pi_rpc_guard.mjs", import.meta.url));
const operation = "a".repeat(32);

async function fixture(t: any) {
  const child = fork(helper, [preload], { execArgv: [], silent: true, env: { PATH: path.dirname(process.execPath), LANG: "C.UTF-8" } });
  child.stdout!.resume(); child.stderr!.resume();
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } });
  await once(child, "message");
  let sequence = 0;
  const control = (action: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { child.off("message", listener); reject(Error("Fixture control deadline")); }, 2000);
    const listener = (message: any) => { if (message.id === id) { clearTimeout(timer); child.off("message", listener); resolve(message.value); } };
    child.on("message", listener); child.send({ id, action, ...fields });
  });
  const write = (data: string) => new Promise<void>((resolve, reject) => child.stdin!.write(data, e => e ? reject(e) : resolve()));
  const until = async (predicate: (state: any) => boolean) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const state = await control("state"); if (predicate(state)) return state;
      if (Date.now() >= deadline) assert.fail(`Guard state did not settle: ${JSON.stringify(state)}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { child, control, write, until };
}

test("RPC fence permits completed correlated reads but not partial input or output frames", async t => {
  const f = await fixture(t);
  const initial = await f.control("state");
  assert.equal(initial.safe, true, "A real RPC guard must report the untouched channel safe");
  assert.equal(initial.frozen, true); assert.equal(initial.intact, true);
  assert.equal(initial.transport, "pi-rpc-v1:stdin-stdout-jsonl");
  await f.write('{"id":"read-1","type":"get_');
  await f.until(s => s.delivered === 1);
  assert.equal((await f.control("state")).safe, false);
  assert.equal(await f.control("freeze", { operation }), false);
  await f.write('state"}\n'); await f.until(s => s.safe);
  await f.control("output", { chunk: '{"type":"message_' });
  assert.equal((await f.control("state")).safe, false);
  await f.control("output", { chunk: 'update"}\n' });
  assert.equal((await f.control("state")).safe, true);
});

test("RPC generation remains fenced through agent_end until agent_settled", async t => {
  const f = await fixture(t);
  await f.write('{"id":"prompt-1","type":"prompt","message":"synthetic"}\n');
  await f.until(s => s.delivered === 1);
  assert.equal(await f.control("freeze", { operation }), false);
  await f.control("agent_end"); assert.equal((await f.control("state")).safe, false);
  await f.control("settle"); assert.equal((await f.control("state")).safe, true);
  assert.equal(await f.control("freeze", { operation }), true);
  assert.equal(await f.control("release", { operation, stranger: true }), false);
  assert.equal(await f.control("release", { operation }), true);
});

test("RPC fence observes the real output sink when Pi redirects ordinary stdout", async t => {
  const f = await fixture(t); await f.control("takeover");
  assert.equal((await f.control("state")).intact, true);
  await f.write('{"id":"read-redirect","type":"get_state"}\n');
  await f.until(s => s.safe);
  await f.write('{"id":"generation-redirect","type":"prompt","message":"synthetic"}\n');
  await f.until(s => s.delivered === 2);
  assert.equal((await f.control("state")).safe, false);
  await f.control("settle");
  assert.equal((await f.control("state")).safe, true);
});

test("RPC oversized transport chunks fail closed without buffering their contents", async t => {
  const f = await fixture(t);
  await f.control("output", { chunk: '{"type":"message_update"}\n'.repeat(50_000) });
  assert.equal((await f.control("state")).safe, false);
  assert.equal(await f.control("freeze", { operation }), false);
});

test("RPC input arriving under a barrier is not delivered and permanently taints the generation", async t => {
  const f = await fixture(t);
  assert.equal(await f.control("freeze", { operation }), true);
  await f.write('{"id":"unexpected","type":"prompt","message":"must not run"}\n');
  await f.until(s => !s.safe);
  assert.equal((await f.control("state")).delivered, 0);
  assert.equal(await f.control("release", { operation }), true);
  assert.equal((await f.control("state")).safe, false);
  assert.equal(await f.control("freeze", { operation }), false);
});

test("RPC unknown commands, malformed frames and channel replacement fail closed", async t => {
  for (const input of ['{"id":"x","type":"bash","command":"ignored"}\n', '{bad}\n', '{"type":"get_state"}\n']) {
    const f = await fixture(t); await f.write(input); await f.until(s => s.delivered === 1);
    assert.equal((await f.control("state")).safe, false);
    assert.equal(await f.control("freeze", { operation }), false);
  }
  for (const channel of ["stdin", "stdout"]) {
    const f = await fixture(t); await f.control("tamper", { channel });
    assert.equal((await f.control("state")).intact, false);
    assert.equal(await f.control("freeze", { operation }), false);
  }
});

test("RPC handled prompts and late generation under a barrier cannot produce update eligibility", async t => {
  const handled = await fixture(t);
  await handled.write('{"id":"handled-1","type":"prompt","message":"handled"}\n');
  await handled.until(s => s.delivered === 1);
  await handled.control("settle");
  assert.equal((await handled.control("state")).safe, false);
  assert.equal(await handled.control("freeze", { operation }), false);
  const late = await fixture(t);
  assert.equal(await late.control("freeze", { operation }), true);
  await late.control("output", { chunk: '{"type":"agent_start"}\n' });
  assert.equal((await late.control("state")).safe, false);
  await late.control("settle");
  assert.equal((await late.control("state")).safe, false);
  assert.equal(await late.control("release", { operation }), true);
});

test("RPC shutdown keeps input blocked even after an attempted owner release", async t => {
  const f = await fixture(t);
  assert.equal(await f.control("freeze", { operation }), true);
  await f.control("shutdown");
  assert.equal(await f.control("release", { operation }), false);
  await f.write('{"id":"late","type":"get_state"}\n');
  assert.equal((await f.until(s => !s.safe)).delivered, 0);
});

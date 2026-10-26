import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function fixture(t: any, respond: (request: any, peer: net.Socket) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "manager-runtime-client-"));
  const socketPath = path.join(root, "control.sock"); const token = "a".repeat(64);
  const peers = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, peer => {
    peers.add(peer); peer.once("close", () => peers.delete(peer));
    peer.on("error", () => {}); let data = "";
    peer.on("data", chunk => { data += chunk.toString(); const newline = data.indexOf("\n"); if (newline >= 0) respond(JSON.parse(data.slice(0, newline)), peer); });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { socketPath, token };
}

test("private runtime client sends only fixed credential-bound commands and authenticates the local endpoint", async t => {
  const { RuntimeClient } = await import("../manager/backends/runtime-client.ts");
  const endpoint = await fixture(t, (request, peer) => {
    assert.deepEqual(request, { token: "a".repeat(64), action: "snapshot" });
    peer.end(JSON.stringify({ ok: true, result: { observed: true } }) + "\n");
  });
  const client = new RuntimeClient(endpoint);
  assert.equal((await client.request({ action: "snapshot" }) as any).observed, true);
  await chmod(endpoint.socketPath, 0o666);
  await assert.rejects(client.request({ action: "snapshot" }), /endpoint/);
});

test('private runtime endpoint replacement cannot inherit authority from its predecessor', async t => {
  const { RuntimeClient } = await import('../manager/backends/runtime-client.ts');
  const endpoint = await fixture(t, (_request, peer) => peer.end('{"ok":true,"result":{}}\n'));
  const client = new RuntimeClient(endpoint);
  await client.request({ action: 'snapshot' });
  await rename(endpoint.socketPath, endpoint.socketPath + '.old');
  let replacements = 0;
  const replacement = net.createServer(peer => { replacements++; peer.destroy(); });
  await new Promise<void>(resolve => replacement.listen(endpoint.socketPath, resolve)); await chmod(endpoint.socketPath, 0o600);
  t.after(() => new Promise<void>(resolve => replacement.close(() => resolve())));
  await assert.rejects(client.request({ action: 'snapshot' }), /Changed runtime endpoint/);
  assert.equal(replacements, 0, 'A different same-UID socket must never receive the credential');
});

test('private runtime requests freeze authority before awaits and reject concurrent channel use', async t => {
  const { RuntimeClient } = await import('../manager/backends/runtime-client.ts');
  let observed: any, release!: () => void;
  const endpoint = await fixture(t, (request, peer) => {
    observed = request;
    release = () => peer.end('{"ok":true,"result":{"held":true}}\n');
  });
  const client = new RuntimeClient(endpoint);
  const request = { action: 'prepare' as const, operation_id: 'b'.repeat(32),
    expected: { runtime_id: 'runtime-before', session_id: 'session-before', leaf_id: null } };
  const pending = client.request(request);
  request.expected.session_id = 'injected-after-call';
  await assert.rejects(client.request({ action: 'snapshot' }), /refused/);
  const deadline = Date.now() + 1000;
  while (!release) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(observed.expected.session_id, 'session-before');
  release(); assert.equal((await pending as any).held, true);
});

test("private runtime client refuses malformed, oversized, multi-frame and rejected responses", async t => {
  const { RuntimeClient } = await import("../manager/backends/runtime-client.ts");
  for (const text of ["{bad}\n", JSON.stringify({ ok: false, error: "private details must not escape" }) + "\n",
    JSON.stringify({ ok: true, result: {}, extra: true }) + "\n", '{"ok":true,"result":{}}\n{}\n', "x".repeat(16385)]) {
    const endpoint = await fixture(t, (_request, peer) => peer.end(text));
    const client = new RuntimeClient(endpoint);
    await assert.rejects(client.request({ action: "snapshot" }), error => /Runtime request refused/.test(String(error)) && !String(error).includes("private details"));
  }
});

test("private runtime client bounds connected IPC time and refuses request authority fields before connecting", async t => {
  const { RuntimeClient } = await import("../manager/backends/runtime-client.ts");
  let calls = 0;
  const endpoint = await fixture(t, () => { calls++; });
  const client = new RuntimeClient({ ...endpoint, timeoutMs: 50 });
  await assert.rejects(client.request({ action: "snapshot", token: "b".repeat(64) } as never), /request/);
  assert.equal(calls, 0);
  const started = Date.now();
  await assert.rejects(client.request({ action: "snapshot" }), /Runtime request refused/);
  assert.ok(Date.now() - started >= 40, "A silent connected server must actually reach the deadline");
  assert.equal(calls, 1);
});

test('private final commit transmits only an immutable complete snapshot on the existing credential-bound channel', async t => {
  const { RuntimeClient } = await import('../manager/backends/runtime-client.ts');
  let observed: any;
  const endpoint = await fixture(t, (request, peer) => {
    observed = request;
    peer.end(JSON.stringify({ ok: true, result: { [request.action === 'admit' ? 'admitted' : 'committed']: true,
      operation_id: request.operation_id, snapshot: request.expected } }) + '\n');
  });
  const expected = { run_id: 'c'.repeat(32), runtime_id: 'runtime', session_id: 'session', leaf_id: 'leaf',
    session_file: '/private/sessions/dialogue.jsonl', cwd: '/workspace', version: '1.4.0', idle: true,
    pending: false, busy: false, provider: 'test', model: 'fixture', thinking: 'off' };
  const client = new RuntimeClient(endpoint), before = structuredClone(expected);
  const pending = client.request({ action: 'commit', operation_id: 'b'.repeat(32), expected } as never);
  expected.thinking = 'injected-after-call';
  const result: any = await pending;
  assert.equal(result.committed, true); assert.deepEqual(observed.expected, before);
  assert.deepEqual(Object.keys(observed).sort(), ['action', 'expected', 'operation_id', 'token']);
  const admitted = await client.request({ action: 'admit', operation_id: 'b'.repeat(32), expected: before });
  // strictJson deliberately returns null-prototype records. Compare wire data,
  // not prototypes; action-specific acknowledgement enforcement is in NativeBackend.
  assert.deepEqual(structuredClone(admitted), { admitted: true, operation_id: 'b'.repeat(32), snapshot: before });
  assert.equal(observed.action, 'admit'); assert.deepEqual(observed.expected, before);
  for (const altered of [{ ...before, extra: 'forbidden' }, { ...before, busy: true }, { ...before, run_id: 'invalid' },
    { ...before, session_file: '/private/../escape' }, { ...before, idle: false }]) {
    await assert.rejects(client.request({ action: 'commit', operation_id: 'b'.repeat(32), expected: altered } as never), /Invalid runtime request/);
  }
});

test('private admission rejects coercible operation and run identities before opening the credential channel', async t => {
  const { RuntimeClient } = await import('../manager/backends/runtime-client.ts');
  let delivered = 0;
  const endpoint = await fixture(t, (_request, peer) => { delivered++; peer.end('{"ok":true,"result":{}}\n'); });
  const client = new RuntimeClient(endpoint);
  const expected = { run_id: 'c'.repeat(32), runtime_id: 'runtime', session_id: 'session', leaf_id: null,
    session_file: '/private/sessions/dialogue.jsonl', cwd: '/workspace', version: '1.4.0', idle: true,
    pending: false, busy: false, provider: 'test', model: 'fixture', thinking: 'off' };
  for (const action of ['prepare', 'cancel', 'commit', 'admit']) {
    const full = action === 'prepare' ? { runtime_id: 'runtime', session_id: 'session', leaf_id: null } : expected;
    await assert.rejects(client.request({ action, operation_id: ['b'.repeat(32)], ...(action === 'cancel' ? {} : { expected: full }) } as never), /Invalid runtime request/);
  }
  await assert.rejects(client.request({ action: 'admit', operation_id: 'b'.repeat(32), expected: { ...expected, run_id: ['c'.repeat(32)] } } as never), /Invalid runtime request/);
  assert.equal(delivered, 0, 'Malformed identities must not receive the runtime credential');
});

test('executor pre-write refusal sends no request and never awaits a promise guard', async t => {
  const { RuntimeClient } = await import('../manager/backends/runtime-client.ts');
  const delivered: unknown[] = [];
  const endpoint = await fixture(t, (request, peer) => { delivered.push(request); peer.end('{"ok":true,"result":{}}\n'); });
  const client = new RuntimeClient(endpoint);
  await assert.rejects(client.request({ action: 'snapshot' }, () => { throw Error('local fence refused'); }), /refused/);
  await assert.rejects(client.request({ action: 'snapshot' }, (() => Promise.resolve()) as never), /refused/);
  assert.deepEqual(delivered, []);
  await client.request({ action: 'snapshot' }, () => undefined);
  assert.deepEqual(delivered, [{ token: endpoint.token, action: 'snapshot' }], 'The executor callback is not wire authority');
});

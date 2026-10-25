import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

// The controllable socket models the two independent ws conditions: send
// callback completion and outbound-buffer drainage. It is not an alternate queue.
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: { bytes: number; first: number; done: (error?: Error) => void }[] = [];
  closes: number[] = [];
  send(data: Buffer, _options: unknown, done: (error?: Error) => void) {
    this.sent.push({ bytes: data.length, first: data[0], done });
  }
  close(code: number) {
    this.closes.push(code);
    this.readyState = 2;
    this.emit("close");
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
}
async function queue(t: test.TestContext) {
  const module = await import("../hub/forward-queue.ts").catch(() => undefined);
  assert.ok(module?.ForwardQueue, "bounded forwarding implementation is missing");
  const socket = new Socket();
  const q = new module.ForwardQueue(socket);
  t.after(() => q.dispose());
  return { socket, q };
}

test("incoming waiting bytes are reserved before send; exactly 512KiB waits and the next byte closes", async (t) => {
  const { socket, q } = await queue(t);
  assert.equal(q.enqueue(Buffer.alloc(16 * 1024 * 1024, 1), true), true);
  assert.equal(q.enqueue(Buffer.alloc(512 * 1024, 2), true), true);
  assert.deepEqual(q.snapshot(), { inFlightBytes: 16777216, waitingBytes: 524288, waitingMessages: 1 });
  assert.equal(socket.sent.length, 1);
  assert.equal(q.enqueue(Buffer.alloc(1), true), false);
  assert.deepEqual(socket.closes, [1013]);
  assert.deepEqual(q.snapshot(), { inFlightBytes: 0, waitingBytes: 0, waitingMessages: 0 });
});

test("callback alone never releases credit; drainage releases FIFO without double admission", async (t) => {
  const { socket, q } = await queue(t);
  q.enqueue(Buffer.alloc(1024 * 1024, 1), true);
  q.enqueue(Buffer.alloc(32, 2), true);
  q.enqueue(Buffer.alloc(32, 3), true);
  socket.bufferedAmount = 50;
  socket.sent[0].done();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(socket.sent.length, 1);
  assert.equal(q.snapshot().inFlightBytes, 1048576);
  socket.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].first, 2);
  socket.sent[1].done();
  assert.equal(socket.sent[2].first, 3);
  socket.sent[2].done();
  assert.deepEqual(q.snapshot(), { inFlightBytes: 0, waitingBytes: 0, waitingMessages: 0 });
});

test("a second large frame cannot wait and a frame one byte above 16MiB cannot enter", async (t) => {
  for (const size of [1024 * 1024, 16777217]) {
    const { socket, q } = await queue(t);
    if (size === 1024 * 1024) q.enqueue(Buffer.alloc(size), true);
    assert.equal(q.enqueue(Buffer.alloc(size), true), false);
    assert.deepEqual(socket.closes, [1013]);
  }
});

test("empty frames have a count cap and late callbacks after close cannot resurrect work", async (t) => {
  const { socket, q } = await queue(t);
  q.enqueue(Buffer.alloc(1), true);
  for (let i = 0; i < 512; i++) assert.equal(q.enqueue(Buffer.alloc(0), true), true);
  assert.equal(q.enqueue(Buffer.alloc(0), true), false);
  socket.sent[0].done();
  assert.equal(socket.sent.length, 1);
  assert.equal(q.snapshot().waitingMessages, 0);
});

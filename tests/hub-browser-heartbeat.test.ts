import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { browserHeartbeat } from "../hub/browser-heartbeat.ts";

class Socket extends EventEmitter {
  readyState = 1;
  pings = 0;
  terminated = false;
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.readyState = 3; this.emit("close"); }
}

test("heartbeat retires a silent browser only after three unanswered probes", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const socket = new Socket();
  browserHeartbeat(socket);
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(20_000);
    assert.equal(socket.pings, i);
    assert.equal(socket.terminated, false);
  }
  t.mock.timers.tick(20_000);
  assert.equal(socket.terminated, true);
  assert.equal(socket.listenerCount("pong"), 0);
  t.mock.timers.tick(100_000);
  assert.equal(socket.pings, 3);
});

test("pong resets the missed-probe budget without forwarding Pi traffic", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const socket = new Socket();
  const dispose = browserHeartbeat(socket);
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(20_000);
    socket.emit("pong");
  }
  assert.equal(socket.pings, 12);
  assert.equal(socket.terminated, false);
  dispose();
});

for (const event of ["close", "error", "dispose"] as const) {
  test(`heartbeat ${event} cleans up all listeners and scheduled work`, t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const socket = new Socket();
    const dispose = browserHeartbeat(socket);
    if (event === "dispose") dispose(); else socket.emit(event);
    dispose();
    t.mock.timers.tick(100_000);
    assert.equal(socket.pings, 0);
    for (const name of ["pong", "close", "error"]) assert.equal(socket.listenerCount(name), 0);
  });
}

test("a failed ping is contained and a closing socket never gets a new probe", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failing = new Socket();
  failing.ping = () => { throw new Error("closed transport"); };
  browserHeartbeat(failing);
  t.mock.timers.tick(20_000);
  assert.equal(failing.terminated, true);
  const closing = new Socket();
  browserHeartbeat(closing);
  closing.readyState = 2;
  t.mock.timers.tick(20_000);
  assert.equal(closing.pings, 0);
  assert.equal(closing.listenerCount("pong"), 0);
});

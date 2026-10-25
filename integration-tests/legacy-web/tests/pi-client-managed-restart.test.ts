import assert from "node:assert/strict";
import test from "node:test";
import { PiClient } from "../src/web/src/core/pi-client.ts";

for (const generation of ["a".repeat(32), `b2-${"a".repeat(32)}-${"0".repeat(15)}1-${"b".repeat(32)}`]) {
  test(`trusted managed restart gets 120 seconds from close; ordinary route restores 15 seconds (${generation.slice(0, 3)})`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const saved = new Map(
      ["window", "location", "WebSocket", "fetch"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    let socket: any;
    const waits: number[] = [];
    const clients: PiClient[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor() {
        socket = this;
      }
      close() {}
      send() {}
    }
    try {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: new URL(`http://localhost/s/${generation}/`),
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          setTimeout: (_fn: unknown, ms: number) => {
            waits.push(ms);
            return 1;
          },
          clearTimeout() {},
        },
      });
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => ({ status: 410 }) });
      for (const [restart, expected, ended] of [
        [undefined, 15_000],
        [{ id: "b".repeat(32), timeoutMs: 120_000 }, 120_000],
        [{ id: "b".repeat(32), timeoutMs: 120_000 }, 15_000, true],
        [{ id: "b".repeat(32), timeoutMs: 999_999 }, 15_000],
        [{ id: "bad", timeoutMs: 120_000 }, 15_000],
        [{ id: `b2-${"a".repeat(32)}-${"0".repeat(15)}1-${"b".repeat(32)}`, timeoutMs: 120_000 }, 15_000],
      ] as const) {
        const client = new PiClient({
          onConnectionChange() {},
          onError() {},
          onEvent() {},
          onOpen() {},
          onPromptResponse() {},
        });
        clients.push(client);
        client.connect();
        socket.onmessage({
          data: JSON.stringify({
            type: "event",
            event: "hub_route",
            payload: { generation, token: "c".repeat(48), ...(restart ? { restart } : {}) },
          }),
        });
        now += 200_000;
        if (ended) {
          socket.onmessage({
            data: JSON.stringify({
              type: "event",
              event: "hub_route",
              payload: { generation, token: "c".repeat(48) },
            }),
          });
        }
        socket.onclose();
        assert.ok(
          waits.at(-1)! <= expected && waits.at(-1)! >= expected - 100,
          `expected ${expected}, got ${waits.at(-1)}`,
        );
        client.disconnect();
        await Promise.resolve();
      }
    } finally {
      for (const client of clients) client.disconnect();
      await new Promise((r) => setImmediate(r));
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

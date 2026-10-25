import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";

const script = Buffer.from('export const text = "hello world";\n'.repeat(4096));
const asset = "assets/index-AbCd1234.js";

async function fixture(t: test.TestContext, options: { backendCompression?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-hub-transfer-"));
  const configFile = path.join(directory, "config.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  const credentialFile = path.join(directory, "session.json");
  issueSession(config, credentialFile, { label: "Transfer fixture" });
  const registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile });
  let status = 200;
  let responseHeaders: http.OutgoingHttpHeaders = { "Content-Type": "application/javascript" };
  let responseBody = script;
  let interrupted = false;
  let held = false;
  const releases: (() => void)[] = [];
  const server = http.createServer((request, response) => {
    if (!registration.guard(request, response)) return;
    response.writeHead(status, { "Content-Length": responseBody.length, ...responseHeaders });
    if (held) {
      response.write(responseBody.subarray(0, 16384));
      releases.push(() => response.end(responseBody.subarray(16384)));
    } else if (interrupted) {
      response.write(responseBody.subarray(0, 16));
      setImmediate(() => response.destroy());
    } else {
      response.end(request.method === "HEAD" ? undefined : responseBody);
    }
  });
  // Pi normally offers no compression. The optional compression-capable backend
  // verifies that browser negotiation cannot leak onto this separate local hop.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: options.backendCompression ?? false });
  let backendExtensions = "";
  server.on("upgrade", (request, socket, head) => {
    if (!registration.guard(request)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (client) => {
      backendExtensions = client.extensions;
      client.send(script);
      client.on("message", (data, binary) => client.send(data, { binary }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let sessionUrl = "";
  await registration.start((server.address() as net.AddressInfo).port, (value) => {
    sessionUrl = value ?? "";
  });
  t.after(async () => {
    for (const release of releases) release();
    await registration.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hub.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    registration,
    get backendExtensions() {
      return backendExtensions;
    },
    get url() {
      return sessionUrl;
    },
    respond(code: number, headers: http.OutgoingHttpHeaders, body = script) {
      status = code;
      responseHeaders = headers;
      responseBody = body;
    },
    interrupt(value: boolean) {
      interrupted = value;
    },
    hold(value: boolean) {
      held = value;
    },
    release() {
      held = false;
      for (const release of releases.splice(0)) release();
    },
  };
}

// Observe the real Hub's async upgrade completion without replacing network
// transport or adding production-only test hooks. Backend sockets stay real.
async function handshakeFixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-hub-handshake-"));
  const configFile = path.join(directory, "config.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  let hubServer: http.Server | undefined;
  const original = http.createServer;
  const capture = t.mock.method(http, "createServer", (...args: Parameters<typeof http.createServer>) => {
    const server = Reflect.apply(original, http, args) as http.Server;
    hubServer = server;
    return server;
  });
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  capture.mock.restore();
  assert.ok(hubServer);
  const upgrades = new Map<number, { socket: net.Socket; done: Promise<unknown> }>();
  const handler = hubServer.listeners("upgrade")[0];
  hubServer.removeListener("upgrade", handler);
  hubServer.on("upgrade", (request, socket, head) => {
    const raw = socket as net.Socket;
    const done = Promise.resolve(handler.call(hubServer, request, socket, head));
    assert.ok(raw.remotePort);
    upgrades.set(raw.remotePort, { socket: raw, done });
  });
  const credentialFile = path.join(directory, "session.json");
  issueSession(config, credentialFile, { label: "Handshake fixture" });
  const registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile });
  const events = new EventEmitter();
  const held: Array<() => void> = [];
  const pending = new Set<Duplex>();
  let holdProof = false;
  let peak = 0;
  let total = 0;
  const backend = http.createServer((request, response) => {
    if (holdProof && request.url === "/.pi-web-identity") {
      held.push(() => {
        registration.guard(request, response);
      });
      events.emit("proof");
      return;
    }
    if (registration.guard(request, response)) response.end("OK");
  });
  backend.on("upgrade", (_request, socket) => {
    pending.add(socket);
    total++;
    peak = Math.max(peak, pending.size);
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.destroy());
    socket.once("close", () => {
      pending.delete(socket);
      events.emit("backend-close");
    });
    socket.resume();
    events.emit("handshake");
    // Intentionally never send a WebSocket handshake response.
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  let url = "";
  await registration.start((backend.address() as net.AddressInfo).port, (value) => {
    url = value ?? "";
  });
  const clients: net.Socket[] = [];
  t.after(async () => {
    holdProof = false;
    for (const release of held.splice(0)) release();
    for (const client of clients) client.destroy();
    for (const socket of pending) socket.destroy();
    await registration.stop();
    await hub.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    events,
    upgrades,
    url,
    get pending() {
      return pending.size;
    },
    get peak() {
      return peak;
    },
    get total() {
      return total;
    },
    hold(value: boolean) {
      holdProof = value;
    },
    release() {
      const release = held.shift();
      assert.ok(release);
      release();
    },
    async browser() {
      const address = new URL(url);
      const socket = net.createConnection({ host: "127.0.0.1", port: Number(address.port) });
      clients.push(socket);
      await once(socket, "connect");
      const localPort = socket.localPort;
      assert.ok(localPort);
      socket.write(
        `GET ${address.pathname}ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      );
      return { socket, localPort };
    },
  };
}

test("browser abort during held proof never creates orphan backend handshakes", { timeout: 10000 }, async (t) => {
  const f = await handshakeFixture(t);
  f.hold(true);
  for (let i = 0; i < 9; i++) {
    const proof = once(f.events, "proof");
    const browser = await f.browser();
    await proof;
    const upgrade = f.upgrades.get(browser.localPort);
    assert.ok(upgrade);
    const closed = new Promise<void>((resolve) => upgrade.socket.once("close", () => resolve()));
    browser.socket.resetAndDestroy();
    await closed; // Hub has observed the cancellation before proof is released.
    f.release();
    await upgrade.done;
  }
  f.hold(false);
  await request(f.url); // real round trip after all nine upgrade continuations
  t.diagnostic(`cancelled=9, backend handshakes=${f.total}, peak=${f.peak}, pending=${f.pending}`);
  assert.equal(f.total, 0, "cancelled proof must never construct an upstream");
  assert.equal(f.pending, 0);
  assert.ok(f.peak <= 8);
});

test("browser abort retains pair credit until held proof settles", { timeout: 10000 }, async (t) => {
  const f = await handshakeFixture(t);
  // Four live handshakes plus four cancelled proofs fill eight pair credits
  // without exceeding the independent four-probe cap.
  for (let i = 0; i < 4; i++) {
    const handshake = once(f.events, "handshake");
    await f.browser();
    await handshake;
  }
  f.hold(true);
  for (let i = 0; i < 4; i++) {
    const proof = once(f.events, "proof");
    const browser = await f.browser();
    await proof;
    const upgrade = f.upgrades.get(browser.localPort);
    assert.ok(upgrade);
    const closed = new Promise<void>((resolve) => upgrade.socket.once("close", () => resolve()));
    browser.socket.resetAndDestroy();
    await closed;
  }
  const browser = await f.browser();
  const [reply] = await once(browser.socket, "data");
  assert.match(reply.toString(), /^HTTP\/1\.1 503/, "unfinished proofs must retain all eight admission credits");
  assert.equal(f.total, 4);
});

test("browser abort after upstream construction cleans hanging handshakes before capacity reuse", {
  timeout: 10000,
}, async (t) => {
  const f = await handshakeFixture(t);
  for (let i = 0; i < 12; i++) {
    const handshake = once(f.events, "handshake");
    const browser = await f.browser();
    await handshake;
    const closed = once(f.events, "backend-close");
    browser.socket.resetAndDestroy();
    await closed;
    assert.equal(f.pending, 0);
  }
  for (let i = 0; i < 8; i++) {
    const handshake = once(f.events, "handshake");
    await f.browser();
    await handshake;
  }
  const rejected = await f.browser();
  const [reply] = await once(rejected.socket, "data");
  assert.match(reply.toString(), /^HTTP\/1\.1 503/);
  assert.equal(f.pending, 8);
  assert.equal(f.peak, 8);
});

function request(url: string, headers: http.OutgoingHttpHeaders = {}, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const outgoing = http.request(url, { method, headers, timeout: 3000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
      );
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("transfer timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function binaryMessage(client: WebSocket) {
  return new Promise<Buffer>((resolve, reject) => {
    const receive = (data: Buffer, binary: boolean) => {
      if (!binary) return;
      client.removeListener("message", receive);
      client.removeListener("error", reject);
      resolve(Buffer.from(data));
    };
    client.on("message", receive);
    client.once("error", reject);
  });
}

test("explicit 1MiB JSON file previews pass intact in both directions on a draining connection", async (t) => {
  const f = await fixture(t);
  const client = new WebSocket(f.url.replace("http:", "ws:") + "ws", {
    origin: new URL(f.url).origin,
    perMessageDeflate: false,
  });
  t.after(() => client.terminate());
  await binaryMessage(client);
  const frame = JSON.stringify({
    type: "res",
    id: "file-preview",
    ok: true,
    result: { content: "文".repeat(Math.floor(1048576 / 3)) },
  });
  assert.ok(Buffer.byteLength(frame) > 1048576);
  const received = new Promise<string>((resolve, reject) => {
    client.on("message", (data, binary) => {
      if (!binary && data.toString().includes('"file-preview"')) resolve(data.toString());
    });
    client.once("error", reject);
    client.once("close", () => reject(new Error("preview connection closed")));
  });
  client.send(frame);
  assert.equal(await received, frame);
});

test("browser admission includes pending handshakes and caps retained forwarding pairs at eight", async (t) => {
  const f = await fixture(t);
  const clients: WebSocket[] = [];
  t.after(() => {
    for (const client of clients) client.terminate();
  });
  for (let i = 0; i < 8; i++) {
    const client = new WebSocket(f.url.replace("http:", "ws:") + "ws", { origin: new URL(f.url).origin });
    clients.push(client);
    await binaryMessage(client);
  }
  const rejected = new WebSocket(f.url.replace("http:", "ws:") + "ws", { origin: new URL(f.url).origin });
  clients.push(rejected);
  await new Promise<void>((resolve, reject) => {
    rejected.once("error", (error) => {
      assert.match(error.message, /503/);
      resolve();
    });
    rejected.once("open", () => reject(new Error("ninth pair admitted")));
  });
});

test("a stalled upstream send closes the browser with a reconnectable slow-consumer reason", {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t);
  const client = new WebSocket(f.url.replace("http:", "ws:") + "ws", {
    origin: new URL(f.url).origin,
    perMessageDeflate: false,
  });
  t.after(() => client.terminate());
  await binaryMessage(client);
  const frame = Buffer.alloc(1024 * 1024, 42);
  let admitted!: () => void;
  const firstSend = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const original = WebSocket.prototype.send;
  // Hold the real Hub's upstream send, not the queue. The second incoming
  // frame must hit its occupied in-flight slot and close the real browser.
  t.mock.method(WebSocket.prototype, "send", function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    if (this !== client && Buffer.isBuffer(args[0]) && args[0].equals(frame)) {
      admitted();
      return;
    }
    return original.apply(this, args);
  });
  const closed = once(client, "close");
  client.send(frame);
  await firstSend;
  client.send(frame);
  const [code, reason] = await closed;
  assert.equal(code, 1013);
  assert.equal(reason.toString(), "Slow consumer; reconnect");
});

test("only two HTTP compressors run concurrently; excess assets stream identity without a body cache", async (t) => {
  const f = await fixture(t);
  f.hold(true);
  const responses: http.IncomingMessage[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      responses.push(
        await new Promise<http.IncomingMessage>((resolve, reject) => {
          const req = http.get(f.url + asset, { headers: { "Accept-Encoding": "gzip" } }, resolve);
          req.once("error", reject);
        }),
      );
    }
    assert.deepEqual(
      responses.map((r) => r.headers["content-encoding"]),
      ["gzip", "gzip", undefined],
    );
  } finally {
    f.release();
    for (const response of responses) response.resume();
  }
});

for (const [accept, coding] of [
  ["gzip", "gzip"],
  ["br, gzip", "br"],
  ["br;q=0, gzip;q=0.5", "gzip"],
  ["br;q=0.2, gzip;q=0.8", "gzip"],
]) {
  test(`hashed static script is compressed before the tunnel for ${accept}`, async (t) => {
    const f = await fixture(t);
    const response = await request(f.url + asset, { "Accept-Encoding": accept });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], coding);
    assert.deepEqual(coding === "br" ? brotliDecompressSync(response.body) : gunzipSync(response.body), script);
    assert.ok(response.body.length < script.length / 4, "the wire body, not just a header, must shrink");
    assert.equal(response.headers["content-length"], undefined, "identity length must not describe compressed bytes");
    assert.match(response.headers.vary ?? "", /Accept-Encoding/i);
  });
}

test("only hashed static assets receive private bounded caching, with identity clients preserved", async (t) => {
  const f = await fixture(t);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip;q=0, br;q=0" });
  assert.deepEqual(response.body, script);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.headers["cache-control"], "private, max-age=86400, immutable");
  for (const resource of [
    "",
    "index.html",
    "assets/unversioned.js",
    "api/downloads/private",
    `${asset}?token=private`,
  ]) {
    const dynamic = await request(f.url + resource, { "Accept-Encoding": "gzip" });
    assert.equal(dynamic.headers["cache-control"], "no-store", resource);
    assert.equal(dynamic.headers["content-encoding"], undefined, resource);
    assert.deepEqual(dynamic.body, script, resource);
  }
  await f.registration.stop();
  const expired = await request(f.url + asset, { "Accept-Encoding": "gzip" });
  assert.equal(expired.status, 410);
  assert.equal(expired.headers["cache-control"], "no-store");
});

test("HEAD negotiates static representation without a response body", async (t) => {
  const f = await fixture(t);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip" }, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.body.length, 0);
});

test("errors, ranges, downloads and backend privacy policies never become cacheable assets", async (t) => {
  const f = await fixture(t);
  for (const [status, headers] of [
    [404, { "Content-Type": "application/javascript" }],
    [
      206,
      { "Content-Type": "application/javascript", "Content-Range": `bytes 0-${script.length - 1}/${script.length}` },
    ],
    [200, { "Content-Type": "application/json" }],
    [200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" }],
    [200, { "Content-Type": "application/javascript", "Set-Cookie": "private=value" }],
    [200, { "Content-Type": "application/javascript", "Content-Disposition": "attachment" }],
  ] as [number, http.OutgoingHttpHeaders][]) {
    f.respond(status, headers);
    const response = await request(f.url + asset, { "Accept-Encoding": "gzip" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.body, script);
    assert.equal(response.headers["set-cookie"], undefined, "existing cookie stripping remains in effect");
  }
  f.respond(200, { "Content-Type": "application/javascript" });
  const ranged = await request(f.url + asset, { Range: "bytes=0-99", "Accept-Encoding": "gzip" });
  assert.equal(ranged.headers["cache-control"], "no-store");
  assert.equal(ranged.headers["content-encoding"], undefined);
});

test("CSS compression preserves Vary and drops identity-only validators", async (t) => {
  const f = await fixture(t);
  f.respond(200, {
    "Content-Type": "text/css; charset=utf-8",
    Vary: "Origin",
    ETag: '"original"',
    "Content-MD5": "original-md5",
    Digest: "sha-256=original",
  });
  const compressed = await request(`${f.url}assets/index-AbCd1234.css`, { "Accept-Encoding": "*;q=0.5" });
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.equal(compressed.headers.vary, "Origin, Accept-Encoding");
  for (const name of ["etag", "content-md5", "digest"]) assert.equal(compressed.headers[name], undefined);
  assert.deepEqual(brotliDecompressSync(compressed.body), script);
  f.respond(200, { "Content-Type": "text/css", Vary: "*" });
  const wildcard = await request(`${f.url}assets/index-AbCd1234.css`);
  assert.equal(wildcard.headers.vary, "*");
});

test("already compressed backend bytes are forwarded unchanged without private caching", async (t) => {
  const f = await fixture(t);
  const encoded = gzipSync(script);
  f.respond(200, { "Content-Type": "application/javascript", "Content-Encoding": "gzip" }, encoded);
  const response = await request(f.url + asset, { "Accept-Encoding": "br, gzip" });
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, encoded);
});

test("interrupted static streams fail promptly without affecting subsequent sessions", async (t) => {
  const f = await fixture(t);
  f.interrupt(true);
  await assert.rejects(request(f.url + asset, { "Accept-Encoding": "gzip" }), /aborted|socket hang up|ECONNRESET/);
  f.interrupt(false);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip" });
  assert.deepEqual(gunzipSync(response.body), script);
});

for (const compress of [true, false]) {
  test(`browser WebSocket compression=${compress} preserves complete frames and session routing`, async (t) => {
    const f = await fixture(t);
    const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
      origin: new URL(f.url).origin,
      perMessageDeflate: compress,
    });
    t.after(() => client.terminate());
    const initial = binaryMessage(client);
    let negotiated = "";
    client.once("upgrade", (response) => {
      negotiated = response.headers["sec-websocket-extensions"] ?? "";
    });
    await once(client, "open");
    assert.deepEqual(await initial, script);
    assert.equal(client.extensions.includes("permessage-deflate"), compress);
    if (compress) {
      assert.match(negotiated, /server_no_context_takeover/);
      assert.match(negotiated, /client_no_context_takeover/);
      assert.match(negotiated, /server_max_window_bits=12/);
      assert.match(negotiated, /client_max_window_bits=12/);
    }
    const reply = binaryMessage(client);
    client.send(script);
    assert.deepEqual(await reply, script);
    const closed = once(client, "close");
    await f.registration.stop();
    await closed;
  });
}

test("compressed WebSocket input still enforces the decompressed payload limit", async (t) => {
  const f = await fixture(t);
  const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
    origin: new URL(f.url).origin,
    perMessageDeflate: true,
  });
  t.after(() => client.terminate());
  const initial = binaryMessage(client);
  await once(client, "open");
  await initial;
  const closed = once(client, "close");
  client.send(Buffer.alloc(16 * 1024 * 1024 + 1, "a"));
  const [code] = await closed;
  assert.equal(code, 1009);
  const response = await request(f.url + asset);
  assert.equal(response.status, 200, "one rejected client must not stop the Hub");
});

test("a compression-capable Pi backend connects without inheriting the browser offer", async (t) => {
  const f = await fixture(t, { backendCompression: true });
  const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
    origin: new URL(f.url).origin,
    perMessageDeflate: true,
  });
  t.after(() => client.terminate());
  const [, message] = await Promise.all([once(client, "open"), binaryMessage(client)]);
  assert.deepEqual(message, script);
  assert.equal(client.extensions, "permessage-deflate");
  assert.equal(f.backendExtensions, "", "the local hop must not receive the browser compression offer");
});

for (const offer of [
  "permessage-deflate",
  "permessage-deflate; client_max_window_bits=10",
  "permessage-deflate; client_max_window_bits; server_max_window_bits=10",
]) {
  test(`incompatible bounded compression offer ${offer} falls back to ordinary WebSocket`, async (t) => {
    const f = await fixture(t);
    const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
      origin: new URL(f.url).origin,
      perMessageDeflate: false,
      headers: { "Sec-WebSocket-Extensions": offer },
    });
    t.after(() => client.terminate());
    const [, message] = await Promise.all([once(client, "open"), binaryMessage(client)]);
    assert.deepEqual(message, script);
    assert.equal(client.extensions, "");
    const reply = binaryMessage(client);
    client.send(script);
    assert.deepEqual(await reply, script);
  });
}

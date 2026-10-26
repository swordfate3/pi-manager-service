import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import { ReleaseCatalog, PI_PACKAGE } from "../manager/updates/catalog.ts";
import { boundedDownload, type OfficialTransport } from "../manager/updates/transport.ts";
import { strictJson } from "../manager/updates/json.ts";

const url = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
test("transport deadline covers both connection and stalled body, aborting trusted transports", async () => {
  for (const bodyStall of [false, true]) {
    let signal: AbortSignal | undefined;
    const transport: OfficialTransport = async request => {
      signal = request.signal;
      if (!bodyStall) return new Promise(() => {});
      return { statusCode: 200, url: request.url, headers: {}, body: (async function* () { yield Buffer.from("a"); await new Promise(() => {}); })() };
    };
    await assert.rejects(boundedDownload(url, 100, 20, transport), { code: "timeout" });
    assert.equal(signal?.aborted, true);
  }
});

test("rejects redirect, declared/chunked overflow, length mismatch and nonidentity encoding", async () => {
  for (const variant of ["redirect", "url", "declared", "chunked", "mismatch", "encoding"]) {
    let signal: AbortSignal | undefined;
    const transport: OfficialTransport = async request => {
      signal = request.signal;
      return { url: variant === "url" ? url + "?secret=credential" : url, statusCode: variant === "redirect" ? 302 : 200,
        headers: variant === "declared" ? { "content-length": "4" } : variant === "mismatch" ? { "content-length": "1" } : variant === "encoding" ? { "content-encoding": "gzip" } : {},
        body: (async function* () { yield Buffer.from("ab"); if (variant === "chunked") yield Buffer.from("cd"); })() };
    };
    await assert.rejects(boundedDownload(url, 3, 100, transport));
    assert.equal(signal?.aborted, true);
  }
  for (const unsafe of [url.replace("https:", "http:"), url + "#fragment", url.replace("https://", "https://secret@"), url.replace("npmjs.org", "evil.test")]) {
    await assert.rejects(boundedDownload(unsafe, 3, 100, async () => { assert.fail("unsafe destination reached transport"); }));
  }
});

test("metadata always has 8 MiB/8 second bounds and recovers after unavailable retry", async () => {
  let now = 0, fail = true, calls = 0;
  const c = new ReleaseCatalog({ now: () => now, transport: async request => {
    calls++;
    assert.equal(request.maxBytes, 8 * 1024 * 1024); assert.equal(request.timeoutMs, 8000);
    assert.equal(request.url, `https://registry.npmjs.org/${encodeURIComponent(PI_PACKAGE)}`);
    if (fail) throw new Error("private credential");
    return { url: request.url, statusCode: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify({ name: PI_PACKAGE, versions: {} })); })() };
  } });
  assert.equal((await c.list(PI_PACKAGE)).status, "unavailable");
  now = 29999; fail = false;
  assert.equal((await c.list(PI_PACKAGE)).status, "unavailable"); assert.equal(calls, 1);
  now = 30000;
  assert.equal((await c.list(PI_PACKAGE)).status, "fresh"); assert.equal(calls, 2);
});

test("strict JSON rejects invalid Unicode, nonfinite numbers, duplicates and excessive nesting", () => {
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', 'NaN', '1e9999', '[1,]', '{"a":}', '[01]',
    '['.repeat(66) + '0' + ']'.repeat(66), '{"a":{"b":1,"b":2}}', 'true trailing']) {
    assert.throws(() => strictJson(Buffer.from(input)));
  }
  assert.throws(() => strictJson(Buffer.from([0xff])));
  const value = strictJson(Buffer.from('{"__proto__":{"safe":true},"text":"a\\\"b","values":[null,true,false,1.5e2]}')) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(value.text, 'a"b'); assert.deepEqual(value.values, [null, true, false, 150]);
});

test("default HTTPS transport uses an isolated agent, explicit TLS trust and abbreviated npm metadata", async t => {
  const captured: https.RequestOptions[] = [];
  t.mock.method(https, "request", (_url: string, options: https.RequestOptions, callback: (res: unknown) => void) => {
    captured.push(options);
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const res = Object.assign(Readable.from([Buffer.from("{}")] ), { statusCode: 200, headers: {} });
      queueMicrotask(() => callback(res));
    };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await boundedDownload("https://registry.npmjs.org/example", 100, 100);
  await boundedDownload(url, 100, 100);
  assert.notEqual(captured[0].agent, https.globalAgent);
  assert.notEqual(captured[0].agent, captured[1].agent);
  assert.equal(captured[0].rejectUnauthorized, true);
  assert.deepEqual(captured[0].ca, [...rootCertificates]);
  assert.equal(captured[0].auth, undefined);
  assert.deepEqual(captured[0].headers, { accept: "application/vnd.npm.install-v1+json", "accept-encoding": "identity" });
  assert.deepEqual(captured[1].headers, { accept: "application/octet-stream", "accept-encoding": "identity" });
});

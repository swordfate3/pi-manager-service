import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Docker Engine transport bounds replies, distinguishes missing reads and ambiguous writes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manager-engine-test-"));
  const sock = path.join(dir, "daemon.sock");
  const server = http.createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(404); return res.end('{"message":"private daemon path"}'); }
    if (req.url === "/oversized") return res.end("x".repeat(10000));
    if (req.url === "/lost") return req.socket.destroy();
    if (req.url === "/slow") return;
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(sock, resolve); });
  let module: typeof import("../manager/backends/docker-engine.ts") | undefined;
  try { module = await import("../manager/backends/docker-engine.ts"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  assert.ok(module, "Docker Engine transport must exist");
  const engine = new module.DockerEngine(sock, { timeoutMs: 100, maxBytes: 4096 });
  assert.deepEqual(await engine.call("GET", "/ok"), { ok: true });
  assert.equal(await engine.call("GET", "/missing", undefined, { allowMissing: true }), null);
  await assert.rejects(engine.call("GET", "/missing"), /Docker operation rejected/);
  await assert.rejects(engine.call("GET", "/oversized"), /response limit/);
  await assert.rejects(engine.call("GET", "/slow"), /unavailable/);
  await assert.rejects(engine.call("POST", "/lost", {}), (e: unknown) => e instanceof module!.DockerOutcomeUnknownError);
  await assert.rejects(engine.call("POST", "/slow", {}), (e: unknown) => e instanceof module!.DockerOutcomeUnknownError);
});

test("Docker Engine rejects unsafe paths and error messages never echo request or daemon secrets", async () => {
  let module: typeof import("../manager/backends/docker-engine.ts") | undefined;
  try { module = await import("../manager/backends/docker-engine.ts"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  assert.ok(module, "Docker Engine transport must exist");
  const engine = new module.DockerEngine("/nonexistent/synthetic-docker.sock", { timeoutMs: 100 });
  await assert.rejects(engine.call("GET", "https://evil.invalid/"), /Invalid Docker operation/);
  await assert.rejects(engine.call("GET", "/containers/../host"), /Invalid Docker operation/);
  await assert.rejects(engine.call("POST", "/create", { secret: "NEVER_ECHO_THIS" }), (e: unknown) => {
    assert.doesNotMatch(String(e), /NEVER_ECHO_THIS|nonexistent/);
    return e instanceof module!.DockerOutcomeUnknownError;
  });
});

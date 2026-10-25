import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GateLifecycle } from "../../hub/lifecycle.ts";

test("lifecycle provider uses a private distinct credential and sends only exact restart identities", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-lifecycle-"));
  const credentialFile = path.join(directory, "credential.json");
  const token = "a".repeat(64);
  writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
  const requests: any[] = [];
  const run = "b".repeat(32);
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push({ auth: request.headers.authorization, url: request.url, value: raw ? JSON.parse(raw) : null });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.method === "POST"
            ? { id: "d".repeat(32), run_id: run, status: "queued", stage: "queued", secret: "not-public" }
            : {
                managed: true,
                run_id: run,
                runtime_id: "old",
                session_id: "saved",
                leaf_id: null,
                version: "1.1.0",
                idle: true,
                pending: false,
                busy: false,
                mode: "auto",
                session_file: "/private/session.jsonl",
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const provider = new GateLifecycle({ endpoint, credentialFile });
  const target = await provider.target(run);
  assert.equal(target.runtime_id, "old");
  assert.ok(!JSON.stringify(target).includes("session_file"));
  const payload = {
    run_id: run,
    runtime_id: "old",
    session_id: "saved",
    leaf_id: null,
    idempotency_key: "c".repeat(32),
  };
  const job = await provider.restart(payload);
  assert.equal(job.status, "queued");
  assert.ok(!JSON.stringify(job).includes("not-public"));
  assert.equal(requests[0].auth, `Bearer ${token}`);
  assert.deepEqual(requests[1].value, payload);
  assert.equal(requests[1].url, "/v1/pi-lifecycle/restarts");
  await assert.rejects(provider.target("../../admin"));
  chmodSync(credentialFile, 0o644);
  await assert.rejects(provider.target(run));
});

test("lifecycle provider rejects non-loopback, URLs with credentials and redirects", () => {
  for (const endpoint of [
    "https://example.com",
    "http://localhost:16182",
    "http://user:pass@127.0.0.1:16182",
    "http://127.0.0.1:16182/admin",
    "http://127.0.0.1:16182/?secret=x",
  ])
    assert.throws(() => new GateLifecycle({ endpoint, credentialFile: "/private/token.json" }));
});

// Real Pi and packaged Hub; temporary files and a faux provider only.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { FileDownloadResult } from "../src/web/src/core/types.ts";
import { startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

for (const mode of ["direct", "hub"]) {
  test(`${mode}: real file download streams binary bytes and enforces path, identity, verb and Origin boundaries`, {
    timeout: 45000,
  }, async (t) => {
    const hub = mode === "hub" ? await startHubCli({ repositoryRoot }) : undefined;
    let agent: PiWebUiHarness | undefined;
    let socket: WebSocket | undefined;
    const pending = new Map<
      string,
      { resolve: (value: FileDownloadResult) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
    >();
    t.after(async () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Test ended"));
      }
      socket?.terminate();
      try {
        await agent?.stop();
      } finally {
        await hub?.close();
      }
    });
    agent = await startPiWebUi("chat-lifecycle", {
      repositoryRoot,
      git: false,
      registration: hub?.issue("download-integration"),
    });
    const name = "documents/求职/计算机硕士秋招简历-优化版.pdf";
    mkdirSync(path.join(agent.workspaceDir, "documents/求职"), { recursive: true });
    const bytes = Buffer.alloc(5 * 1024 * 1024, 127);
    writeFileSync(path.join(agent.workspaceDir, name), bytes);
    writeFileSync(path.join(agent.workspaceDir, ".env"), "DO_NOT_DOWNLOAD");
    symlinkSync(path.join(agent.workspaceDir, ".env"), path.join(agent.workspaceDir, "aliased.pdf"));
    let base = `${agent.pageUrl}/`;
    if (hub) {
      const deadline = Date.now() + 10000;
      let route: string | undefined;
      do {
        route = (await (await fetch(`${hub.url}api/sessions`)).json()).sessions[0]?.path;
        if (!route) await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!route && Date.now() < deadline);
      assert.ok(route);
      base = new URL(route, hub.url).href;
    }
    const endpoint = new URL("ws", base);
    endpoint.protocol = "ws:";
    const ws = new WebSocket(endpoint, { origin: new URL(base).origin });
    socket = ws;
    const snapshot = await new Promise<{ sessionId: string; runtimeId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing initial state")), 10000);
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type === "event" && value.event === "state_sync") {
          clearTimeout(timer);
          resolve(value.payload);
        }
        if (value.type === "res") {
          const request = pending.get(value.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(value.id);
          if (value.ok) request.resolve(value.result);
          else request.reject(new Error(value.error));
        }
      });
    });
    let count = 0;
    const request = (params: Record<string, unknown>) =>
      new Promise<FileDownloadResult>((resolve, reject) => {
        const id = `file-${++count}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Missing download response"));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ type: "req", id, method: "prepare_file_download", params }));
      });
    const scope = { sessionId: snapshot.sessionId, runtimeId: snapshot.runtimeId };
    const file = await request({ ...scope, path: name });
    const url = new URL(file.downloadUrl.slice(1), base);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition") ?? "", /attachment;.*filename\*=UTF-8''/);
    assert.ok(
      response.headers
        .get("cache-control")
        ?.split(",")
        .every((value) => value.trim() === "no-store"),
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, name)), bytes);
    writeFileSync(path.join(agent.workspaceDir, "empty.txt"), "");
    const empty = await request({ ...scope, path: "empty.txt" });
    const emptyResponse = await fetch(new URL(empty.downloadUrl.slice(1), base));
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyResponse.headers.get("content-length"), "0");
    assert.equal((await emptyResponse.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(url, { method: "HEAD", headers: { Origin: new URL(base).origin } })).status, 200);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal((await fetch(url, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(new URL("api/downloads/00000000-0000-4000-8000-000000000000", base))).status, 404);
    await assert.rejects(request({ ...scope, path: "../outside.pdf" }));
    await assert.rejects(request({ ...scope, path: ".env" }));
    await assert.rejects(request({ ...scope, path: "aliased.pdf" }));
    await assert.rejects(request({ ...scope, path: name, sessionId: "stale" }));
    await assert.rejects(request({ ...scope, path: name, runtimeId: "stale" }));
    await assert.rejects(request({ path: name }));
    writeFileSync(path.join(agent.workspaceDir, name), "replacement");
    assert.equal((await fetch(url)).status, 404);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });
}

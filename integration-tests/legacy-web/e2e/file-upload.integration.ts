// Real Pi + optional packaged Hub, isolated workspaces and faux LLM only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";
import { startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

// Importing the real SDK installs its Undici dispatcher. Node 22's bundled
// fetch is incompatible with that dispatcher's zero-length PUT headers; use
// the same installed implementation (no extra dependency or protocol change).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const fetch: typeof globalThis.fetch = piRequire("undici").fetch;

type Prepared = { uploadId: string; url: string; relativePath: string; maxBytes: number };
type PreparedV2 = Prepared & {
  protocol: 2;
  chunkSize: number;
  nextChunk: number;
  complete: boolean;
};
const MIB = 1024 * 1024;
const CHUNK_SIZE = 8 * MIB;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function createSyntheticFile(filename: string, size: number) {
  const fd = openSync(filename, "wx", 0o600);
  const fileHash = createHash("sha256");
  const chunkHashes: string[] = [];
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const bytes = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index++) bytes[index] = (offset + index) % 251;
      fileHash.update(bytes);
      chunkHashes.push(createHash("sha256").update(bytes).digest("hex"));
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
      offset += length;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: fileHash.digest("hex"), chunkHashes };
}

async function hashFile(filename: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

function interruptChunk(target: URL, length: number, origin: string) {
  return new Promise<void>((resolve) => {
    const request = http.request(target, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(length),
        Origin: origin,
      },
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    request.on("error", finish);
    request.on("response", (response) => {
      response.resume();
      response.on("end", finish);
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish();
    }, 50);
    request.write(Buffer.alloc(Math.max(1, Math.min(64 * 1024, length - 1)), 0x6b));
  });
}

function putFileChunk(target: URL, filename: string, start: number, length: number, origin: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      target,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          Origin: origin,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    const source = createReadStream(filename, { start, end: start + length - 1 });
    source.on("error", (error) => request.destroy(error));
    source.pipe(request);
  });
}
const runtimeRoot = path.resolve(process.env.PI_E2E_RUNTIME_DIR ?? repositoryRoot);
for (const mode of ["direct", "hub"]) {
  test(`${mode}: HTTP file upload preserves binary bytes; prompt carries only verified workspace paths`, {
    timeout: 180000,
  }, async (t) => {
    const hub = mode === "hub" ? await startHubCli({ repositoryRoot }) : undefined;
    let agent: PiWebUiHarness | undefined;
    let ws: WebSocket | undefined;
    const pending = new Map<
      string,
      { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    t.after(async () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Test ended"));
      }
      ws?.terminate();
      try {
        await agent?.stop();
      } finally {
        await hub?.close();
      }
    });
    agent = await startPiWebUi("file-upload", {
      repositoryRoot,
      git: false,
      registration: hub?.issue("upload-integration"),
    });
    let base = `${agent.pageUrl}/`;
    if (hub) {
      const routeDeadline = Date.now() + 10000;
      let route: string | undefined;
      do {
        route = (await (await fetch(`${hub.url}api/sessions`)).json()).sessions[0]?.path;
        if (!route) await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!route && Date.now() < routeDeadline);
      assert.ok(route);
      base = new URL(route, hub.url).href;
    }
    const endpoint = new URL("ws", base);
    endpoint.protocol = "ws:";
    const socket = new WebSocket(endpoint, { origin: new URL(base).origin });
    ws = socket;
    const userMessages: string[] = [];
    const scope = await new Promise<{ sessionId: string; runtimeId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing state")), 10000);
      socket.on("error", reject);
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "event" && event.event === "state_sync") {
          clearTimeout(timer);
          resolve({ sessionId: event.payload.sessionId, runtimeId: event.payload.runtimeId });
        }
        if (event.type === "event" && event.event === "message_start" && event.payload.message.role === "user")
          userMessages.push(JSON.stringify(event.payload.message.content));
        if (event.type === "res") {
          const request = pending.get(event.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(event.id);
          if (event.ok) request.resolve(event.result);
          else request.reject(new Error(event.error));
        }
      });
    });
    let count = 0;
    const request = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = `upload-${++count}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Missing response"));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      });
    const prepare = (filename: string, size: number, identity = scope) =>
      request("prepare_upload", { ...identity, filename, size }) as Promise<Prepared>;
    const prepareV2 = (filename: string, size: number, sha256: string, chunkHashes: string[], identity = scope) =>
      request("prepare_upload", {
        ...identity,
        protocol: 2,
        filename,
        size,
        sha256,
        chunkHashes,
      }) as Promise<PreparedV2>;
    // Exercise the exact configured ceiling through both real HTTP paths.
    const bytes = Buffer.alloc(50 * 1024 * 1024);
    for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
    const file = await prepare("合成图片.png", bytes.length);
    assert.equal(file.maxBytes, 50 * 1024 * 1024);
    assert.match(file.url, /^\/api\/uploads\/[0-9a-f-]{36}$/);
    assert.ok(JSON.stringify(file).length < 1024);
    const url = new URL(file.url.slice(1), base);
    const put = (target: URL, body: Buffer) =>
      fetch(target, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
          Origin: new URL(base).origin,
        },
        body: new Uint8Array(body),
      });
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: "PUT", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(url, { method: "PUT", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal(
      (await fetch(`${url}?path=escape`, { method: "PUT", headers: { "Content-Length": "0" } })).status,
      404,
    );
    await assert.rejects(request("prompt", { ...scope, uploads: [file.uploadId], message: "Not complete" }));
    const response = await put(url, bytes);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      uploadId: file.uploadId,
      relativePath: file.relativePath,
      filename: "合成图片.png",
      size: bytes.length,
    });
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, file.relativePath)), bytes);
    assert.equal((await put(url, bytes)).status, 400);
    const empty = await prepare("empty.txt", 0);
    assert.equal((await put(new URL(empty.url.slice(1), base), Buffer.alloc(0))).status, 200);
    assert.equal(readFileSync(path.join(agent.workspaceDir, empty.relativePath)).length, 0);
    await assert.rejects(prepare(".env", 1));
    await assert.rejects(prepare("../escape", 1));
    await assert.rejects(prepare("too-large", 50 * 1024 * 1024 + 1));
    await assert.rejects(prepare("stale", 0, { ...scope, sessionId: "stale" }));
    await assert.rejects(prepare("stale", 0, { ...scope, runtimeId: "stale" }));
    await assert.rejects(request("prepare_upload", { filename: "missing-scope", size: 0 }));
    await assert.rejects(
      request("prompt", { ...scope, uploads: [file.uploadId, "unknown"], message: "Bad attachment" }),
    );
    await assert.rejects(
      request("prompt", { ...scope, runtimeId: "stale", uploads: [file.uploadId], message: "Stale scope" }),
    );
    // Failed dispatch policy must leave a completed receipt retryable.
    await assert.rejects(
      request("prompt", { ...scope, uploads: [file.uploadId], executePiCommand: true, message: "/new" }),
    );
    await request("prompt", {
      ...scope,
      uploads: [file.uploadId, empty.uploadId],
      message: "UPLOAD_INTEGRATION_MARKER",
      path: "/untrusted-client-path",
    });
    const firstMessageDeadline = Date.now() + 10000;
    while (!userMessages.length && Date.now() < firstMessageDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(userMessages.length, 1);
    assert.ok(userMessages[0].includes(file.relativePath));
    assert.ok(userMessages[0].includes(empty.relativePath));
    assert.ok(userMessages[0].includes("UPLOAD_INTEGRATION_MARKER"));
    assert.ok(!userMessages[0].includes("untrusted-client-path"));
    assert.ok(userMessages[0].length < 4096);
    await assert.rejects(request("prompt", { ...scope, uploads: [file.uploadId], message: "Already consumed" }));
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, file.relativePath)), bytes);

    // Exercise the real v2 transport with a synthetic file strictly larger
    // than the legacy 50 MiB single-PUT ceiling, streamed in bounded chunks.
    const largePath = path.join(agent.sessionDir, "resumable-large.bin");
    const largeSize = 65 * MIB;
    const digest = createSyntheticFile(largePath, largeSize);
    const large = await prepareV2("resumable-large.bin", largeSize, digest.sha256, digest.chunkHashes);
    assert.equal(large.protocol, 2);
    assert.equal(large.chunkSize, CHUNK_SIZE);
    assert.equal(large.maxBytes, MIB * 1024);
    assert.equal(large.nextChunk, 0);
    assert.equal(large.complete, false);
    assert.equal(digest.chunkHashes.length, 9);
    const chunkUrl = (upload: PreparedV2, index: number) => new URL(`${upload.url.slice(1)}/chunks/${index}`, base);
    assert.equal(
      (
        await fetch(`${chunkUrl(large, 1)}?unexpected=query`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "0",
            Origin: new URL(base).origin,
          },
        })
      ).status,
      404,
    );
    assert.equal(
      (await putFileChunk(chunkUrl(large, 1), largePath, CHUNK_SIZE, CHUNK_SIZE, new URL(base).origin)).status,
      400,
    );
    assert.equal(
      (await putFileChunk(chunkUrl(large, 0), largePath, 0, CHUNK_SIZE - 1, new URL(base).origin)).status,
      400,
    );
    const wrongFirstChunk = Buffer.alloc(CHUNK_SIZE, 0x5a);
    const wrongHashResponse = await fetch(chunkUrl(large, 0), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(wrongFirstChunk.length),
        Origin: new URL(base).origin,
      },
      body: new Uint8Array(wrongFirstChunk),
    });
    assert.equal(wrongHashResponse.status, 400);
    assert.equal((await prepareV2("resumable-large.bin", largeSize, digest.sha256, digest.chunkHashes)).nextChunk, 0);
    const firstChunk = await putFileChunk(chunkUrl(large, 0), largePath, 0, CHUNK_SIZE, new URL(base).origin);
    assert.equal(firstChunk.status, 200);
    assert.deepEqual(JSON.parse(firstChunk.body), { uploadId: large.uploadId, nextChunk: 1 });
    const duplicateChunk = await putFileChunk(chunkUrl(large, 0), largePath, 0, CHUNK_SIZE, new URL(base).origin);
    assert.equal(duplicateChunk.status, 200);
    assert.equal(JSON.parse(duplicateChunk.body).nextChunk, 1);
    const changedChunk = Buffer.alloc(CHUNK_SIZE, 0x5a);
    const wrongDuplicate = await fetch(chunkUrl(large, 0), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(changedChunk.length),
        Origin: new URL(base).origin,
      },
      body: new Uint8Array(changedChunk),
    });
    assert.equal(wrongDuplicate.status, 400);
    const resumed = await prepareV2("resumable-large.bin", largeSize, digest.sha256, digest.chunkHashes);
    assert.equal(resumed.uploadId, large.uploadId);
    assert.equal(resumed.nextChunk, 1);
    await assert.rejects(
      prepareV2("resumable-large.bin", largeSize, digest.sha256, digest.chunkHashes, {
        ...scope,
        sessionId: "stale",
      }),
    );
    for (let index = resumed.nextChunk; index < digest.chunkHashes.length; index++) {
      const start = index * CHUNK_SIZE;
      const length = Math.min(CHUNK_SIZE, largeSize - start);
      const chunk = await putFileChunk(chunkUrl(large, index), largePath, start, length, new URL(base).origin);
      assert.equal(chunk.status, 200, `chunk ${index}: ${chunk.body}`);
      assert.deepEqual(JSON.parse(chunk.body), { uploadId: large.uploadId, nextChunk: index + 1 });
    }
    const completed = await request("complete_upload", {
      ...scope,
      uploadId: large.uploadId,
    });
    assert.deepEqual(completed, {
      uploadId: large.uploadId,
      relativePath: large.relativePath,
      filename: "resumable-large.bin",
      size: largeSize,
    });
    assert.equal(await hashFile(path.join(agent.workspaceDir, large.relativePath)), digest.sha256);

    // Complete and attach a separate original-text fixture. The real Pi read
    // tool must consume only its verified workspace path, not client bytes.
    const uploadedText = Buffer.from("UPLOAD_TEXT_CONTENT_MARKER：续传协议原始文本。\n", "utf8");
    const textHash = createHash("sha256").update(uploadedText).digest("hex");
    const uploadedTextFile = await prepareV2("中文说明.txt", uploadedText.length, textHash, [textHash]);
    const textChunk = await fetch(chunkUrl(uploadedTextFile, 0), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(uploadedText.length),
        Origin: new URL(base).origin,
      },
      body: new Uint8Array(uploadedText),
    });
    assert.equal(textChunk.status, 200);
    const textReceipt = await request("complete_upload", { ...scope, uploadId: uploadedTextFile.uploadId });
    assert.deepEqual(textReceipt, {
      uploadId: uploadedTextFile.uploadId,
      relativePath: uploadedTextFile.relativePath,
      filename: "中文说明.txt",
      size: uploadedText.length,
    });
    await request("prompt", {
      ...scope,
      uploads: [large.uploadId, uploadedTextFile.uploadId],
      message: "V2_UPLOAD_INTEGRATION_MARKER",
    });
    const secondMessageDeadline = Date.now() + 10000;
    while (userMessages.length < 2 && Date.now() < secondMessageDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(userMessages.length, 2);
    assert.ok(userMessages[1].includes(large.relativePath));
    assert.ok(userMessages[1].includes(uploadedTextFile.relativePath));
    assert.ok(userMessages[1].includes("V2_UPLOAD_INTEGRATION_MARKER"));
    const readDeadline = Date.now() + 15000;
    let sessionLog = "";
    do {
      const sessionFiles = (await import("node:fs"))
        .readdirSync(agent.sessionDir)
        .filter((name) => name.endsWith(".jsonl"));
      sessionLog = sessionFiles
        .map((name) => readFileSync(path.join(agent?.sessionDir ?? "", name), "utf8"))
        .join("\n");
      if (sessionLog.includes('"name":"read"') && sessionLog.includes("UPLOAD_TEXT_CONTENT_MARKER")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < readDeadline);
    assert.ok(sessionLog.includes('"name":"read"'), "Pi should call the real read tool for the uploaded text path");
    assert.ok(sessionLog.includes("UPLOAD_TEXT_CONTENT_MARKER"));
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, uploadedTextFile.relativePath)), uploadedText);

    // Cancellation during a later chunk retains only previously confirmed data.
    const recoveryPath = path.join(agent.sessionDir, "recover-after-disconnect.bin");
    const recoverySize = CHUNK_SIZE + 257;
    const recoveryDigest = createSyntheticFile(recoveryPath, recoverySize);
    const recovery = await prepareV2(
      "recover-after-disconnect.bin",
      recoverySize,
      recoveryDigest.sha256,
      recoveryDigest.chunkHashes,
    );
    const confirmedChunk = await putFileChunk(chunkUrl(recovery, 0), recoveryPath, 0, CHUNK_SIZE, new URL(base).origin);
    assert.equal(confirmedChunk.status, 200);
    await interruptChunk(chunkUrl(recovery, 1), recoverySize - CHUNK_SIZE, new URL(base).origin);
    // Socket destruction returns before the backend's async truncate/fsync
    // cleanup necessarily settles. Query progress only after that busy lease
    // is released; do not mistake connection close for a confirmed offset.
    let afterInterrupt: PreparedV2 | undefined;
    const recoveryDeadline = Date.now() + 10000;
    while (!afterInterrupt && Date.now() < recoveryDeadline) {
      try {
        afterInterrupt = await prepareV2(
          "recover-after-disconnect.bin",
          recoverySize,
          recoveryDigest.sha256,
          recoveryDigest.chunkHashes,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("busy")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(afterInterrupt, "interrupted chunk must release its write lease");
    assert.equal(afterInterrupt.uploadId, recovery.uploadId);
    assert.equal(afterInterrupt.nextChunk, 1);
    await assert.rejects(request("complete_upload", { ...scope, runtimeId: "stale", uploadId: recovery.uploadId }));
    const finalChunk = await putFileChunk(
      chunkUrl(recovery, 1),
      recoveryPath,
      CHUNK_SIZE,
      recoverySize - CHUNK_SIZE,
      new URL(base).origin,
    );
    assert.equal(finalChunk.status, 200);
    const recoveryReceipt = await request("complete_upload", { ...scope, uploadId: recovery.uploadId });
    assert.deepEqual(recoveryReceipt, {
      uploadId: recovery.uploadId,
      relativePath: recovery.relativePath,
      filename: "recover-after-disconnect.bin",
      size: recoverySize,
    });
    assert.equal(await hashFile(path.join(agent.workspaceDir, recovery.relativePath)), recoveryDigest.sha256);

    // Exact declared maximum is accepted; the first byte above it is rejected
    // before any 1 GiB payload is allocated or sent.
    const declaredMaximum = 1024 * MIB;
    const exactLimit = await prepareV2(
      "declared-maximum.bin",
      declaredMaximum,
      "a".repeat(64),
      Array.from({ length: declaredMaximum / CHUNK_SIZE }, () => "b".repeat(64)),
    );
    assert.equal(exactLimit.maxBytes, declaredMaximum);
    assert.equal(exactLimit.chunkSize, CHUNK_SIZE);
    await assert.rejects(
      prepareV2(
        "over-declared-maximum.bin",
        declaredMaximum + 1,
        "a".repeat(64),
        Array.from({ length: Math.ceil((declaredMaximum + 1) / CHUNK_SIZE) }, () => "b".repeat(64)),
      ),
    );

    // Invalid Hub generation/proof cannot bypass the original transport guard.
    assert.equal(
      (
        await fetch(`${agent.pageUrl}${empty.url}`, {
          method: "PUT",
          headers: { "x-pi-web-generation": "stale", "x-pi-web-proof": "invalid" },
        })
      ).status,
      409,
    );
  });
}

// In-process real Pi SDK lets the test hold compaction/input hooks and observe
// runner.onError, which is deliberately not available to mirror-server itself.
// All provider/model work stays on the same isolated faux provider as RPC tests.
test("real Pi: compaction refusal is retryable; async dispatch failure never ACKs or replays receipts", {
  timeout: 45000,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-upload-acceptance-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const env = {
    PI_OFFLINE: "1",
    PI_WEB_UI_HOST: "127.0.0.1",
    PI_WEB_UI_PORT: String(port),
    PI_WEB_UI_DISABLED: "false",
    PI_WEB_UI_PUBLIC_URL: "",
    PI_WEB_UI_REGISTRY_SOCKET: "",
    PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "",
    PI_WEB_UI_STATIC_DIR: path.join(runtimeRoot, "dist"),
    PI_WEB_UI_E2E_FIXTURE: "chat-lifecycle",
  };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let api!: ExtensionAPI;
  let releaseCompaction!: () => void;
  let enteredCompaction!: () => void;
  const compactionEntered = new Promise<void>((resolve) => {
    enteredCompaction = resolve;
  });
  const compactionGate = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      path.join(repositoryRoot, "e2e/fixtures/faux-provider-extension.ts"),
      path.join(runtimeRoot, "extensions/mirror-server.ts"),
    ],
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.on("session_before_compact", async () => {
          enteredCompaction();
          await compactionGate;
          return { cancel: true };
        });
      },
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  t.after(async () => {
    releaseCompaction();
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const runtimeErrors: string[] = [];
  await session.bindExtensions({
    mode: "rpc",
    onError: (event) => {
      runtimeErrors.push(`${event.event}: ${event.error}`);
    },
  });
  const model = modelRuntime.getModel("faux", "faux-1");
  assert.ok(model);
  await session.setModel(model);
  await session.prompt("Seed a real conversation for compaction");
  await session.prompt("Another turn to leave compactable history");
  const base = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
  t.after(() => socket.terminate());
  const replies = new Map<string, (response: { ok: boolean; error?: string; result?: unknown }) => void>();
  let userStarts = 0;
  const scope = await new Promise<{ sessionId: string; runtimeId: string }>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "event" && event.event === "state_sync") resolve(event.payload);
      if (event.type === "event" && event.event === "message_start" && event.payload.message.role === "user")
        userStarts++;
      if (event.type === "res") replies.get(event.id)?.(event);
    });
  });
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; error?: string; result?: unknown }>((resolve, reject) => {
      const id = `accept-${++sequence}`;
      const timer = setTimeout(() => reject(new Error("Missing response")), 12000);
      replies.set(id, (result) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const prepared = await request("prepare_upload", { ...scope, filename: "recoverable.txt", size: 0 });
  assert.equal(prepared.ok, true);
  const upload = prepared.result as Prepared;
  assert.equal(
    (
      await fetch(`${base}${upload.url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "0" },
      })
    ).status,
    200,
  );
  const compacting = session.compact().catch(() => {});
  await Promise.race([
    compactionEntered,
    compacting.then(() => {
      throw new Error("Compaction never reached hook");
    }),
  ]);
  assert.equal(session.isIdle, false);
  // This is a real compaction refusal, not executePiCommand policy.
  const refused = await request("prompt", { ...scope, uploads: [upload.uploadId], message: "Busy attachment" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /compaction/);
  assert.equal(userStarts, 0);
  releaseCompaction();
  await compacting;
  const accepted = await request("prompt", { ...scope, uploads: [upload.uploadId], message: "Retry after compaction" });
  assert.equal(accepted.ok, true);
  assert.equal(userStarts, 1, "ACK must follow the actual matching user event");
  await session.waitForIdle();
  const second = await request("prepare_upload", { ...scope, filename: "unknown.txt", size: 0 });
  const unknown = second.result as Prepared;
  assert.equal(
    (
      await fetch(`${base}${unknown.url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "0" },
      })
    ).status,
    200,
  );
  // An auth resolution failure before dispatch leaves the same receipt retryable.
  const providerConfig = modelRuntime.getRegisteredProviderConfig("faux");
  assert.ok(providerConfig);
  modelRuntime.registerProvider("faux", { ...providerConfig, apiKey: "!exit 1", authHeader: true });
  const authRefused = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "Auth preflight" });
  assert.equal(authRefused.ok, false);
  assert.match(authRefused.error ?? "", /authentication failed/);
  assert.equal(userStarts, 1);
  modelRuntime.registerProvider("faux", providerConfig);
  await modelRuntime.refresh({ allowNetwork: false });
  // Remove the synthetic provider inside input, AFTER mirror's auth preflight.
  // Pi's async model/auth validation fails and only runner.onError sees it.
  const unsubscribe = api.on("input", async (event) => {
    if (event.text.includes("FAIL_UPLOAD_AUTH")) {
      modelRuntime.unregisterProvider("faux");
      await modelRuntime.refresh({ allowNetwork: false });
    }
  });
  const result = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "FAIL_UPLOAD_AUTH" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /acceptance is unknown/);
  unsubscribe();
  const retry = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "Must not duplicate" });
  assert.equal(retry.ok, false);
  assert.match(retry.error ?? "", /Do not resend/);
  assert.equal(userStarts, 1);
  assert.equal(readFileSync(path.join(cwd, unknown.relativePath)).length, 0);
  assert.ok(
    runtimeErrors.some((error) => error.startsWith("send_user_message:")),
    "must exercise Pi's real async failure channel",
  );
});

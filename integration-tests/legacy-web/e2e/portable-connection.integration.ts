// Backend integration only; browser product E2E is the Playwright-BDD suite.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDir = process.env.PI_E2E_RUNTIME_DIR ? path.resolve(process.env.PI_E2E_RUNTIME_DIR) : root;
const credential = { run_id: "1".repeat(32), token: "2".repeat(64) };
const proof = (text: string) => createHmac("sha256", credential.token).update(text).digest("hex");

async function eventually(predicate: () => boolean | Promise<boolean>, message: string | (() => string)) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(typeof message === "function" ? message() : message);
}

async function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

type RegistrationFixture =
  | "working"
  | "missing"
  | "off"
  | "missing-capability"
  | "malformed-capability"
  | "array-run-id"
  | "array-token";

async function fixture(t: test.TestContext, registration: RegistrationFixture, reservedPort?: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-portable-"));
  const agentDir = path.join(dir, "agent");
  const workspaceDir = path.join(dir, "workspace");
  mkdirSync(agentDir);
  mkdirSync(workspaceDir);
  const socketPath = path.join(dir, "registry.sock");
  const credentialFile = path.join(dir, "capability.json");
  if (registration !== "missing-capability") {
    const contents =
      registration === "malformed-capability"
        ? "not-json"
        : JSON.stringify({
            run_id: registration === "array-run-id" ? [credential.run_id] : credential.run_id,
            token: registration === "array-token" ? [credential.token] : credential.token,
          });
    writeFileSync(credentialFile, contents, { mode: 0o600 });
  }
  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  const registry = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.split("\n")[0]);
      requests.push(request);
      socket.end(
        `${JSON.stringify({ ok: true, result: { url: `https://gateway.example/s/${request.generation}/` } })}\n`,
      );
    });
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited = Promise.resolve();
  let processClosed = false;
  const output: string[] = [];
  const closed = () => exited;
  t.after(async () => {
    // Also runs after assertions/timeouts and spawn errors; close drains diagnostic output.
    const forceStop = setTimeout(() => {
      if (!processClosed) child?.kill("SIGKILL");
    }, 2000);
    try {
      if (!processClosed) child?.kill("SIGTERM");
      await exited;
    } finally {
      clearTimeout(forceStop);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => registry.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  if (registration !== "missing" && registration !== "off") {
    await new Promise<void>((resolve) => registry.listen(socketPath, resolve));
  }
  let port = reservedPort;
  if (port === undefined) {
    const probe = http.createServer();
    try {
      port = await listen(probe, 0);
    } finally {
      await closeServer(probe);
    }
  }
  const start = () => {
    child = spawn(
      process.env.PI_E2E_BIN || path.join(root, "node_modules/.bin/pi"),
      [
        "--mode",
        "rpc",
        "--model",
        "faux/faux-1",
        "--api-key",
        "faux-key",
        "--approve",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--extension",
        path.join(root, "e2e/fixtures/faux-provider-extension.ts"),
        "--extension",
        path.join(root, "e2e/fixtures/connection-lifecycle-extension.ts"),
        "--extension",
        path.join(runtimeDir, "extensions/mirror-server.ts"),
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_E2E: "1",
          PI_WEB_UI_HOST: "127.0.0.1",
          PI_WEB_UI_PORT: String(port),
          PI_WEB_UI_DISABLED: "false",
          PI_WEB_UI_STATIC_DIR: path.join(runtimeDir, "dist"),
          PI_WEB_UI_PUBLIC_URL: undefined,
          PI_WEB_UI_REGISTRY_SOCKET: registration === "off" ? undefined : socketPath,
          PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: registration === "off" ? undefined : credentialFile,
        },
      },
    );
    exited = new Promise<void>((resolve) => {
      child?.once("close", () => {
        processClosed = true;
        resolve();
      });
    });
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    child.on("error", (error) => output.push(error.message));
  };
  const send = (message: string) => {
    if (!child) throw new Error("Pi test process is not started");
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  };
  const ready = async (actualPort = port) => {
    let lastProbe = "not attempted";
    const diagnostic = () =>
      `Pi Web did not start on 127.0.0.1:${actualPort} (configured ${port}; last probe: ${lastProbe}; ` +
      `exit=${child?.exitCode}, signal=${child?.signalCode}):\n${output.join("").slice(-8000)}`;
    await eventually(async () => {
      if (processClosed) assert.fail(diagnostic());
      try {
        const response = await fetch(`http://127.0.0.1:${actualPort}/`, { signal: AbortSignal.timeout(1000) });
        lastProbe = `HTTP ${response.status}`;
        await response.body?.cancel();
        return response.ok;
      } catch (error) {
        lastProbe = error instanceof Error ? error.message : String(error);
        return false;
      }
    }, diagnostic);
  };
  return { port, start, send, ready, requests, closed, stop: () => child?.kill("SIGTERM") };
}

test("real Pi registers natively, guards WebSockets, and unregisters on stop", { timeout: 30_000 }, async (t) => {
  const pi = await fixture(t, "working");
  pi.start();
  await pi.ready();
  await eventually(() => pi.requests.length > 0, "No native registration request received");
  assert.equal(pi.requests[0].port, pi.port);
  const version = spawnSync(process.env.PI_E2E_BIN || path.join(root, "node_modules/.bin/pi"), ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(version.status, 0);
  const software = {
    piVersion: version.stdout.trim(),
    webUi: {
      version: JSON.parse(readFileSync(path.join(runtimeDir, "package.json"), "utf8")).version,
      build: JSON.parse(readFileSync(path.join(runtimeDir, "dist/build-manifest.json"), "utf8")).source.sha256,
    },
  };
  assert.deepEqual(pi.requests[0].software, software, "unmanaged real Pi registers its loaded software versions");
  assert.equal(pi.requests[0].runtime, undefined, "display metadata does not manufacture managed restart capability");
  const generation = String(pi.requests[0].generation);
  const challenge = "3".repeat(48);
  const identity = await fetch(`http://127.0.0.1:${pi.port}/.pi-web-identity`, {
    headers: {
      "x-pi-web-challenge": challenge,
      "x-pi-web-challenge-proof": proof(challenge),
    },
  });
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { generation, proof: proof(`${challenge}:${generation}`) });
  const blocked = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, { headers: { "x-pi-web-generation": "4".repeat(32) } });
  await new Promise<void>((resolve, reject) => {
    blocked.once("error", () => resolve());
    blocked.once("open", () => {
      blocked.close();
      reject(new Error("Wrong generation upgraded"));
    });
  });
  const allowed = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, {
    headers: {
      "x-pi-web-generation": generation,
      "x-pi-web-proof": proof(generation),
    },
  });
  await new Promise<void>((resolve, reject) => {
    allowed.once("message", () => resolve());
    allowed.once("error", reject);
  });
  allowed.close();
  pi.send("/webui-stop");
  await eventually(() => pi.requests.some((value) => value.action === "unregister"), "Stop did not unregister");
  pi.send("/webui-start");
  await pi.ready();
  await eventually(
    () => pi.requests.filter((value) => value.action === "register").length >= 2,
    "Restart did not register",
  );
  const next = pi.requests.filter((value) => value.action === "register")[1];
  assert.notEqual(next.generation, generation);
  pi.send("/connection-test-reload");
  await eventually(
    () => pi.requests.filter((value) => value.action === "register").length >= 3,
    "Reload did not register a fresh generation",
  );
  const reloaded = pi.requests.filter((value) => value.action === "register")[2];
  assert.notEqual(reloaded.generation, next.generation);
  assert.deepEqual(reloaded.software, software, "the new extension runtime recaptures the same installed build");
  assert.equal(pi.requests.filter((value) => value.action === "unregister").length, 2);
  await pi.ready();
  const exited = pi.closed();
  pi.stop();
  await exited;
  assert.equal(pi.requests.at(-1)?.action, "unregister");
});

for (const registration of [
  "missing-capability",
  "malformed-capability",
  "array-run-id",
  "array-token",
  "off",
] as const) {
  test(`real Pi fails closed for routed requests with ${registration}`, { timeout: 20_000 }, async (t) => {
    const pi = await fixture(t, registration);
    pi.start();
    await pi.ready();
    const url = `http://127.0.0.1:${pi.port}`;
    const generation = "4".repeat(32);
    const claims: Record<string, string>[] = [
      { "x-pi-web-generation": generation, "x-pi-web-proof": proof(generation) },
      { "x-pi-web-generation": generation },
      { "x-pi-web-proof": proof(generation) },
      { "x-pi-web-generation": "" },
      { "x-pi-web-proof": "" },
    ];
    for (const headers of claims) {
      const response = await fetch(`${url}/`, { headers });
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
      const ws = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, { headers, handshakeTimeout: 5000 });
      try {
        await assert.rejects(
          new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
          }),
          /Unexpected server response: 409/,
        );
      } finally {
        ws.terminate();
      }
    }
    const challenge = "3".repeat(48);
    for (const headers of [
      {},
      { "x-pi-web-challenge": challenge, "x-pi-web-challenge-proof": proof(challenge) },
    ] as Record<string, string>[]) {
      const identity = await fetch(`${url}/.pi-web-identity?probe=1`, { headers });
      assert.equal(identity.status, 403);
      assert.equal(identity.headers.get("cache-control"), "no-store");
      assert.equal(await identity.text(), "");
    }
    // Failed remote routing must neither expose session data nor disable local use.
    assert.equal((await fetch(`${url}/`)).status, 200);
    const local = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, { handshakeTimeout: 5000 });
    try {
      const message = await new Promise<string>((resolve, reject) => {
        local.once("message", (data) => resolve(data.toString()));
        local.once("error", reject);
      });
      assert.equal(JSON.parse(message).type, "event");
    } finally {
      local.terminate();
    }
    assert.equal(pi.requests.length, 0);
  });
}

test("real Pi remains locally usable when configured registry is missing", { timeout: 20_000 }, async (t) => {
  const pi = await fixture(t, "missing");
  pi.start();
  await pi.ready();
  assert.equal((await fetch(`http://127.0.0.1:${pi.port}/`)).status, 200);
});

test("real Pi advances an occupied port without registration", { timeout: 20_000 }, async (t) => {
  // An OS-selected ephemeral port does not imply port+1 is free. Reserve both
  // before starting Pi; keep the first occupied and release only its successor.
  let occupied: http.Server | undefined;
  let successor: http.Server | undefined;
  t.after(async () => {
    if (occupied) await closeServer(occupied);
    if (successor) await closeServer(successor);
  });
  let port: number | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    occupied = http.createServer((_req, res) => res.writeHead(503).end());
    successor = http.createServer();
    const candidate = await listen(occupied, 0);
    if (candidate < 65535) {
      try {
        await listen(successor, candidate + 1);
        port = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    await closeServer(occupied);
    await closeServer(successor);
  }
  assert.ok(port !== undefined && successor, "Could not reserve two consecutive loopback ports");
  const pi = await fixture(t, "off", port);
  await closeServer(successor);
  successor = undefined;
  pi.start();
  await pi.ready(pi.port + 1);
  assert.equal((await fetch(`http://127.0.0.1:${pi.port}/`)).status, 503);
});

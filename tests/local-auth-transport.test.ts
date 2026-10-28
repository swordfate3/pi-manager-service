import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { startLocalService } from "../manager/local-service.ts";
import { LocalStore } from "../manager/local-store.ts";

type Session = { cookie: string; csrf: string };
type HttpResult = { status: number; text: string; value: unknown; headers: import("node:http").IncomingHttpHeaders };

function bounded<T>(value: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    timer.unref();
  });
  return Promise.race([value, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function rawUpgrade(port: number, route: string, headers: Record<string, string>): Promise<number> {
  return bounded(
    new Promise<number>((resolve, reject) => {
      const socket = net.createConnection(port, "127.0.0.1");
      let data = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk;
        const first = /^HTTP\/1\.1 (\d{3})\b/.exec(data);
        if (!first) return;
        socket.destroy();
        resolve(Number(first[1]));
      });
      socket.once("connect", () => {
        socket.write(
          [
            `GET ${route} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            "",
            "",
          ].join("\r\n"),
        );
      });
    }),
    `raw WebSocket upgrade for ${route}`,
  );
}

function startRawUpgrade(port: number, route: string, headers: Record<string, string>): Promise<net.Socket> {
  return bounded(
    new Promise((resolve, reject) => {
      const socket = net.createConnection(port, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          [
            `GET ${route} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            "",
            "",
          ].join("\r\n"),
        );
        resolve(socket);
      });
    }),
    `opening raw WebSocket upgrade for ${route}`,
  );
}

function socketClosed(socket: WebSocket, label: string): Promise<void> {
  return bounded(
    new Promise((resolve, reject) => {
      socket.once("close", () => resolve());
      socket.once("error", reject);
    }),
    `${label} close`,
  );
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-local-auth-transport-"));
  const home = path.join(root, "home");
  const projects = path.join(home, "projects");
  const stateRoot = path.join(root, "state");
  const bin = path.join(root, "bin");
  const launcher = path.join(bin, "launcher");
  await mkdir(path.join(projects, "demo"), { recursive: true });
  await mkdir(bin);
  await writeFile(launcher, "#!/bin/sh\nexit 7\n", { mode: 0o700 });

  const service = await startLocalService({
    port: 0,
    chatPort: 0,
    home,
    workspaceRoots: { projects },
    defaultWorkspace: { root: "projects", path: "demo" },
    stateRoot,
    launcher,
    hubCli: path.resolve("dist/hub/pi-web-hub.mjs"),
  });
  const origin = new URL(service.url).origin;
  const hub = readHubConfig(path.join(stateRoot, "chat.json"));
  const generation = randomBytes(16).toString("hex");
  const received: Array<{ url: string; headers: import("node:http").IncomingHttpHeaders }> = [];
  let upstreamWebSockets = 0;
  const liveUpstreamWebSockets = new Set<WebSocket>();
  const upstreamDrainWaiters = new Set<() => void>();
  let lastWebSocketHeaders: import("node:http").IncomingHttpHeaders | undefined;
  let nextIdentityHold:
    | { entered: () => void; release: Promise<void>; settled: () => void }
    | undefined;
  const backend = createServer((req, res) => {
    if (req.url === "/.pi-web-identity") {
      const challenge = req.headers["x-pi-web-challenge"];
      assert.equal(typeof challenge, "string");
      const hold = nextIdentityHold;
      const reply = () =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            generation,
            proof: createHmac("sha256", credential.token).update(`${challenge}:${generation}`).digest("hex"),
          }),
        );
      if (hold) {
        nextIdentityHold = undefined;
        hold.entered();
        res.once("close", hold.settled);
        void hold.release.then(reply);
      } else reply();
      return;
    }
    received.push({ url: req.url ?? "", headers: { ...req.headers } });
    const isDownload = req.url === "/files/report.txt";
    res
      .writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        ...(isDownload ? { "Content-Disposition": 'attachment; filename="report.txt"' } : {}),
        "Set-Cookie": "upstream-session=malicious; HttpOnly",
        "Server-Timing": "upstream;dur=1",
        "WWW-Authenticate": "Basic realm=malicious",
        "X-Pi-Web-Proof": "malicious",
      })
      .end(`fake Pi ${req.url}`);
  });
  const wss = new WebSocketServer({ server: backend });
  wss.on("connection", (socket, req) => {
    upstreamWebSockets++;
    liveUpstreamWebSockets.add(socket);
    lastWebSocketHeaders = { ...req.headers };
    socket.once("close", () => {
      liveUpstreamWebSockets.delete(socket);
      if (liveUpstreamWebSockets.size === 0) {
        for (const resolve of upstreamDrainWaiters) resolve();
        upstreamDrainWaiters.clear();
      }
    });
    socket.on("message", (message, binary) => socket.send(message, { binary }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;
  const credential = issueSession(hub, path.join(root, "fake-pi-capability.json"), { label: "local transport fake Pi" });

  const register = await bounded(
    new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = net.createConnection(hub.socketPath, () => {
        socket.write(`${JSON.stringify({ action: "register", ...credential, generation, port: backendPort })}\n`);
      });
      let data = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk;
        if (!data.includes("\n")) return;
        socket.destroy();
        resolve(JSON.parse(data));
      });
    }),
    "legacy fake Pi registration",
  );
  assert.equal(register.ok, true);

  const call = (route: string, body?: unknown, extra: Record<string, string | undefined> = {}): Promise<HttpResult> =>
    bounded(
      new Promise((resolve, reject) => {
        const req = request(
          origin + route,
          {
            method: body === undefined ? "GET" : "POST",
            headers: Object.fromEntries(
              Object.entries({ Origin: origin, "Content-Type": "application/json", ...extra }).filter(([, value]) => value !== undefined),
            ),
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (text += chunk));
            res.once("error", reject);
            res.once("end", () => {
              let value: unknown = text;
              try {
                value = JSON.parse(text);
              } catch {
                // Non-JSON Pi responses are intentionally exercised as transport bytes.
              }
              resolve({ status: res.statusCode ?? 0, text, value, headers: res.headers });
            });
          },
        );
        req.once("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }),
      `HTTP ${route}`,
    );

  const authenticate = async (setup = false): Promise<Session> => {
    const initial = await call("/api/auth/state");
    const csrf = (initial.value as { csrfToken: string }).csrfToken;
    const response = await call(
      setup ? "/api/auth/setup" : "/api/auth/login",
      { username: "tester", password: "transport-password" },
      { "X-Pi-Local-Csrf": csrf },
    );
    assert.equal(response.status, 200, response.text);
    const setCookie = response.headers["set-cookie"];
    assert.ok(setCookie);
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const state = await call("/api/auth/state", undefined, { Cookie: cookie });
    assert.equal(state.status, 200);
    return { cookie, csrf: (state.value as { csrfToken: string }).csrfToken };
  };

  const authenticated = (session: Session, route: string, body?: unknown, extra: Record<string, string | undefined> = {}) =>
    call(route, body, { Cookie: session.cookie, ...(body === undefined ? {} : { "X-Pi-Local-Csrf": session.csrf }), ...extra });

  const openWebSocket = async (session: Session, socketOrigin = origin) => {
    const socket = new WebSocket(`ws://127.0.0.1:${service.port}/s/${generation}/ws`, {
      headers: {
        Origin: socketOrigin,
        Cookie: session.cookie,
        Authorization: "Bearer browser-secret",
        "X-Pi-Hub-User": "spoofed-browser-user",
        "X-Forwarded-For": "198.51.100.45",
      },
    });
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      "authenticated WebSocket open",
    );
    return socket;
  };

  const clients = new Set<WebSocket>();
  const track = (socket: WebSocket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    return socket;
  };
  const holdNextIdentity = () => {
    let entered!: () => void;
    let release!: () => void;
    let settled!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responseClosed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    nextIdentityHold = { entered, release: wait, settled };
    return { seen, release, responseClosed };
  };
  const waitForNoLiveUpstreamWebSockets = () =>
    liveUpstreamWebSockets.size === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => upstreamDrainWaiters.add(resolve));
  const settleUpstreamWebSockets = async () => {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const started = upstreamWebSockets;
      await bounded(waitForNoLiveUpstreamWebSockets(), "late fake Pi WebSocket close", 3_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (started === upstreamWebSockets && liveUpstreamWebSockets.size === 0) return;
    }
    throw new Error("fake Pi WebSocket transport did not quiesce after browser disconnect");
  };
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    await service.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    stateRoot,
    service,
    origin,
    generation,
    call,
    authenticate,
    authenticated,
    openWebSocket: async (session: Session, socketOrigin?: string) => track(await openWebSocket(session, socketOrigin)),
    received,
    upstreamWebSockets: () => upstreamWebSockets,
    liveUpstreamWebSockets: () => liveUpstreamWebSockets.size,
    settleUpstreamWebSockets,
    lastWebSocketHeaders: () => lastWebSocketHeaders,
    holdNextIdentity,
    revoke: () => revokeSession(hub, credential.run_id),
  };
}

test("local login gates the real Hub transport and strips browser authority before fake Pi HTTP and WebSocket", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const base = `/s/${f.generation}`;
  assert.equal((await f.call(`${base}/`)).headers.location, "/login");
  for (const route of [`${base}/api/history`, `${base}/files/report.txt`])
    assert.equal((await f.call(route)).status, 401, route);
  assert.equal(await rawUpgrade(f.service.port, `${base}/ws`, { Origin: f.origin }), 401);

  const session = await f.authenticate(true);
  const page = await f.authenticated(session, `${base}/hello`, undefined, {
    Authorization: "Bearer browser-secret",
    "X-Pi-Hub-User": "spoofed-browser-user",
    "X-Forwarded-For": "198.51.100.45",
  });
  assert.equal(page.status, 200);
  assert.equal(page.text, "fake Pi /hello");
  assert.equal(page.headers["set-cookie"], undefined);
  assert.equal(page.headers["www-authenticate"], undefined);
  assert.equal(page.headers["x-pi-web-proof"], undefined);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(String(page.headers["server-timing"]), /app;dur=/);
  assert.doesNotMatch(String(page.headers["server-timing"]), /upstream/);
  const download = await f.authenticated(session, `${base}/files/report.txt`);
  assert.equal(download.status, 200);
  assert.equal(download.text, "fake Pi /files/report.txt");
  assert.match(String(download.headers["content-disposition"]), /report\.txt/);
  for (const observed of f.received) {
    assert.equal(observed.headers.cookie, undefined);
    assert.equal(observed.headers.authorization, undefined);
    assert.equal(observed.headers["x-pi-hub-user"], undefined);
    assert.equal(observed.headers["x-forwarded-for"], undefined);
    assert.equal(observed.headers["x-pi-web-generation"], f.generation);
    assert.match(String(observed.headers["x-pi-web-proof"]), /^[a-f0-9]{64}$/);
  }

  const beforeWrongOrigin = f.upstreamWebSockets();
  assert.equal(
    await rawUpgrade(f.service.port, `${base}/ws`, { Origin: "http://wrong-origin.invalid", Cookie: session.cookie }),
    403,
  );
  assert.equal(f.upstreamWebSockets(), beforeWrongOrigin, "wrong-Origin request must not reach the fake Pi");

  const socket = await f.openWebSocket(session);
  const echo = bounded(
    new Promise<string>((resolve, reject) => {
      const onMessage = (message: WebSocket.RawData) => {
        if (message.toString() !== "through-local-hub") return;
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(message.toString());
      };
      const onError = (error: Error) => {
        socket.off("message", onMessage);
        reject(error);
      };
      socket.on("message", onMessage);
      socket.once("error", onError);
    }),
    "echoed WebSocket message",
  );
  socket.send("through-local-hub");
  assert.equal(await echo, "through-local-hub");
  const webSocketHeaders = f.lastWebSocketHeaders();
  assert.ok(webSocketHeaders);
  assert.equal(webSocketHeaders.cookie, undefined);
  assert.equal(webSocketHeaders.authorization, undefined);
  assert.equal(webSocketHeaders["x-pi-hub-user"], undefined);
  assert.equal(webSocketHeaders["x-forwarded-for"], undefined);
});

test("workbench state includes terminal-origin registered sessions without adopting them as managed runs", async t => {
  const f = await fixture(t);
  const session = await f.authenticate(true);
  const state = await f.authenticated(session, "/api/local/state");
  assert.equal(state.status, 200);
  const value = state.value as any;
  assert.deepEqual(value.runs, []);
  assert.ok(Array.isArray(value.sessions), "terminal sessions are missing from workbench state");
  assert.equal(value.sessions.length, 1);
  assert.equal(value.sessions[0].generation, f.generation);
  assert.equal(value.sessions[0].path, `/s/${f.generation}/`);
  assert.equal(value.sessions[0].label, "local transport fake Pi");
  assert.deepEqual(Object.keys(value.sessions[0]).sort(), ["generation", "label", "path", "sessionName", "since"]);
  assert.equal((await f.authenticated(session, "/api/local/stop", { id: f.generation })).status, 404);
  assert.equal((await f.authenticated(session, `/s/${f.generation}/`)).status, 200);
  f.revoke();
  const after = await f.authenticated(session, "/api/local/state");
  assert.equal(after.status, 200); assert.deepEqual((after.value as any).sessions, []);
});

test("logout, logout-all, and an external LocalStore revocation close authenticated tunnel sockets", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const one = await f.authenticate(true);
  const first = await f.openWebSocket(one);
  const firstClosed = socketClosed(first, "logout-owned WebSocket");
  assert.equal((await f.authenticated(one, "/api/auth/logout", {})).status, 200);
  await firstClosed;
  assert.equal((await f.authenticated(one, "/api/local/state")).status, 401);

  const two = await f.authenticate();
  const three = await f.authenticate();
  const second = await f.openWebSocket(two);
  const third = await f.openWebSocket(three);
  const secondClosed = socketClosed(second, "logout-all other owned WebSocket");
  const thirdClosed = socketClosed(third, "logout-all caller WebSocket");
  const openedBeforeLogoutAll = f.upstreamWebSockets();
  assert.equal((await f.authenticated(three, "/api/auth/logout-all", {})).status, 200);
  await Promise.all([secondClosed, thirdClosed]);
  await bounded(new Promise<void>((resolve) => setTimeout(resolve, 100)), "no WebSocket reconnect after logout-all", 1_000);
  assert.equal(f.upstreamWebSockets(), openedBeforeLogoutAll, "logout must not cause a reconnect");

  const four = await f.authenticate();
  const externallyRevoked = await f.openWebSocket(four);
  const revokedClosed = socketClosed(externallyRevoked, "externally revoked WebSocket");
  const store = await LocalStore.open(f.stateRoot);
  store.revoke();
  store.close();
  await revokedClosed;
  assert.equal((await f.authenticated(four, "/api/local/state")).status, 401);
});

test("a browser disconnect before Hub sends 101 leaves no live fake Pi WebSocket", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.authenticate(true);
  const hold = f.holdNextIdentity();
  const before = f.upstreamWebSockets();
  const client = await startRawUpgrade(f.service.port, `/s/${f.generation}/ws`, { Origin: f.origin, Cookie: session.cookie });
  await bounded(hold.seen, "fake Pi identity probe before client disconnect");
  client.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  hold.release();
  await bounded(hold.responseClosed, "Hub identity proof completion");
  await f.settleUpstreamWebSockets();
  assert.equal(f.liveUpstreamWebSockets(), 0, "a dead browser upgrade must not retain an upstream Pi WebSocket");
  assert.ok(f.upstreamWebSockets() >= before, "the test records late handshakes without mistaking them for retained resources");
});

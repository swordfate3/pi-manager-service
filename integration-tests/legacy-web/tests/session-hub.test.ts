import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { WebSocket, WebSocketServer } from "ws";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { portalJs } from "../hub/portal.ts";
import { startHub } from "../hub/server.ts";
import { PiClient } from "../src/web/src/core/pi-client.ts";

test("portal removes only the legacy middle-dot eight-hex suffix, not route identities or arbitrary project names", async () => {
  class Element {
    textContent = "";
    title = "";
    href = "";
    className = "";
    value = "";
    children: Element[] = [];
    append(...children: Element[]) {
      this.children.push(...children);
    }
    replaceChildren() {
      this.children = [];
    }
    addEventListener() {}
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id) as Element;
  };
  const labels = [
    "pi_projects · ae32751f",
    "Folder · ABCDEF12",
    "keep-ae32751f",
    "keep · abcdefg1",
    "keep · 123456789",
    "keep · title",
    " · ae32751f",
  ];
  const sessions = labels.map((label, i) => ({
    label,
    sessionName: "会话名字",
    path: `/s/${String(i).padStart(32, "0")}/`,
    since: 0,
  }));
  runInNewContext(portalJs, {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ sessions }) }),
    setInterval() {},
    AbortSignal,
    Date,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const cards = get("sessions").children;
  assert.deepEqual(
    cards.map((card) => card.children[1].textContent),
    ["pi_projects", "Folder", ...labels.slice(2)],
  );
  assert.deepEqual(
    cards.map((card) => card.children[3].href),
    sessions.map((s) => s.path),
  );
  assert.equal(cards[0].children[1].title, "pi_projects");
  assert.equal(cards[0].children[2].children[0].textContent, "会话名字");
  assert.equal(sessions[0].label, labels[0], "original registry metadata is not rewritten");
});

test("portal refreshes on history return, coalesces in-flight returns and preserves unchanged cards", async () => {
  class Element {
    textContent = "";
    title = "";
    href = "";
    className = "";
    value = "";
    children: Element[] = [];
    handlers = new Map<string, () => void>();
    append(...children: Element[]) {
      this.children.push(...children);
    }
    replaceChildren() {
      this.children = [];
    }
    addEventListener(name: string, handler: () => void) {
      this.handlers.set(name, handler);
    }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id) as Element;
  };
  const events = new Map<string, (event: { persisted: boolean }) => void>();
  let interval: (() => void) | undefined;
  let fetches = 0;
  let release: (() => void) | undefined;
  let hold = false;
  let name = "旧名字";
  runInNewContext(portalJs, {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      addEventListener: (event: string, handler: (event: { persisted: boolean }) => void) => events.set(event, handler),
    },
    fetch: async () => {
      fetches++;
      const sessionName = name;
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        ok: true,
        json: async () => ({ sessions: [{ label: "Folder", sessionName, path: "/s/test/", since: 0 }] }),
      };
    },
    setInterval: (handler: () => void) => {
      interval = handler;
    },
    clearTimeout() {},
    AbortSignal,
    Date,
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  await settled();
  const original = get("sessions").children[0];
  interval?.();
  await settled();
  assert.equal(get("sessions").children[0], original, "unchanged polls preserve DOM/focus");
  hold = true;
  interval?.();
  await settled();
  name = "新名字";
  events.get("pageshow")?.({ persisted: true });
  events.get("pageshow")?.({ persisted: true });
  assert.equal(fetches, 3, "no parallel fetch on multiple restore events");
  hold = false;
  release?.();
  await settled();
  assert.equal(fetches, 4, "only one follow-up refresh after pending request");
  assert.equal(get("sessions").children[0].children[2].children[0].textContent, name);
  events.get("pageshow")?.({ persisted: false });
  await settled();
  assert.equal(fetches, 4, "normal initial pageshow does not duplicate the initial fetch");
});

function exchange(socketPath: string, value: Record<string, unknown>) {
  // These lifecycle fixtures now use the new extension. Dedicated raw legacy
  // and laundering tests remain in hub-bounded-registry.test.ts.
  if (
    typeof value.generation === "string" &&
    value.generation.startsWith("b2-") &&
    ["register", "unregister"].includes(String(value.action))
  ) {
    value = {
      ...value,
      action: `bounded_${value.action}`,
      protocol: "bounded-v2",
      boot: value.generation.split("-")[1],
    };
  }
  return new Promise<{ ok: boolean; error?: string; result?: { url: string } }>((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(`${JSON.stringify(value)}\n`));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(data));
      }
    });
    socket.on("error", reject);
  });
}

async function fixture(t: test.TestContext, leaseMs = 45000) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-test-"));
  const configFile = path.join(dir, "config.json");
  initializeHub(configFile, { port: 0, leaseMs });
  const config = readHubConfig(configFile);
  const versions = {
    source: async () => ({ pi: { version: "1.1.0" }, webUi: { version: "0.1.1", build: "a".repeat(64) } }),
    hub: { version: "0.1.1", build: "b".repeat(64) },
  };
  let hub = await startHub(config, { versions });
  const backends: { stop: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const backend of backends) await backend.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function backend(label: string, initialFrame = label) {
    const file = path.join(dir, `${label}.json`);
    const credential = issueSession(config, file, { label });
    const registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile: file });
    let holdProof: (() => Promise<boolean>) | undefined;
    let failUpgrade: (() => Promise<void>) | undefined;
    const server = http.createServer(async (req, res) => {
      if (req.headers["x-pi-web-challenge"] && holdProof) {
        const wait = holdProof;
        holdProof = undefined;
        if (await wait()) {
          res.writeHead(503).end();
          return;
        }
      }
      if (registration.guard(req, res)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ label, url: req.url, proof: req.headers["x-pi-web-proof"] }));
      }
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", async (req, socket, head) => {
      if (failUpgrade) {
        const fail = failUpgrade;
        failUpgrade = undefined;
        await fail();
        socket.destroy();
        return;
      }
      if (!registration.guard(req)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(initialFrame));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    let url: string | null = null;
    await registration.start(port, (value) => {
      url = value;
    });
    const stop = async () => {
      await registration.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    backends.push({ stop });
    return {
      credential,
      registration,
      port,
      pauseNextProof(fail = false) {
        let release!: () => void;
        let started!: () => void;
        const waiting = new Promise<boolean>((resolve) => {
          release = () => resolve(fail);
        });
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        holdProof = () => {
          started();
          return waiting;
        };
        t.after(release);
        return { entered, release };
      },
      failNextUpgrade(action: () => Promise<void>) {
        failUpgrade = action;
      },
      broadcast(value: unknown) {
        for (const ws of wss.clients) ws.send(JSON.stringify(value));
      },
      disconnectBrowsers() {
        for (const ws of wss.clients) ws.terminate();
      },
      get url() {
        return url;
      },
    };
  }
  return {
    config,
    configFile,
    backend,
    get hub() {
      return hub;
    },
    async restart() {
      await hub.close();
      hub = await startHub(config, { versions });
    },
  };
}

async function handoffConnection(t: test.TestContext, url: string, origin: string) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}ws`, { origin });
  t.after(() => socket.terminate());
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hub did not supply an in-memory handoff capability")), 1500);
    socket.on("error", reject);
    socket.on("message", (data) => {
      try {
        const value = JSON.parse(data.toString());
        if (value.type === "event" && value.event === "hub_route") {
          clearTimeout(timer);
          resolve(value.payload.token);
        }
      } catch {
        /* A backend may also send non-JSON test frames. */
      }
    });
    socket.once("close", () => clearTimeout(timer));
  });
  assert.match(token, /^[a-f0-9]{48}$/);
  return { socket, token };
}

function resolveHandoff(url: string, token: string, origin = new URL(url).origin) {
  return fetch(`${url}api/session-handoff`, {
    method: "POST",
    headers: { Origin: origin, "X-Pi-Web-Handoff": token },
  });
}

test("a successor registered during proof leaves the browser handoff retryable", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const proof = a.pauseNextProof();
  const inFlight = resolveHandoff(f.hub.url, token);
  await proof.entered;
  await a.registration.stop();
  await a.registration.start(a.port, () => {});
  proof.release();
  assert.equal((await inFlight).status, 202, "a verified successor arriving during proof is not a terminal 410");
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200);
});

for (const failure of ["proof", "retirement"] as const) {
  test(`an unbound handoff waits after old ${failure} until its first successor registers`, async (t) => {
    const f = await fixture(t);
    const a = await f.backend("A");
    assert.ok(a.url);
    const old = a.url;
    const { token } = await handoffConnection(t, old, new URL(f.hub.url).origin);
    const proof = a.pauseNextProof(failure === "proof");
    const inFlight = resolveHandoff(f.hub.url, token);
    await proof.entered;
    if (failure === "retirement") {
      // Retire through real IPC without changing the backend's identity: its
      // held proof still succeeds, but the old Hub route is no longer live.
      const retired = await exchange(f.hub.socketPath, {
        action: "unregister",
        ...a.credential,
        generation: new URL(old).pathname.split("/")[2],
      });
      assert.equal(retired.ok, true);
    }
    proof.release();
    const pending = await inFlight;
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { pending: true });
    assert.equal(pending.headers.get("cache-control"), "no-store");
    await a.registration.stop();
    assert.equal((await resolveHandoff(f.hub.url, token)).status, 202);
    let next = "";
    await a.registration.start(a.port, (url) => {
      next = url ?? "";
    });
    const followed = await resolveHandoff(f.hub.url, token);
    assert.equal(followed.status, 200);
    assert.equal((await followed.json()).path, new URL(next).pathname);
    assert.equal((await fetch(old)).status, 410);
  });
}

for (const bound of [false, true]) {
  for (const invalidation of ["revoke", "expire"] as const) {
    test(`${bound ? "bound" : "unbound"} handoff fails closed on ${invalidation} during old proof`, async (t) => {
      const f = await fixture(t);
      const a = await f.backend("A");
      assert.ok(a.url);
      const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      a.disconnectBrowsers();
      await closed;
      const proof = a.pauseNextProof(true);
      const inFlight = resolveHandoff(f.hub.url, token);
      await proof.entered;
      if (bound) {
        await a.registration.stop();
        await a.registration.start(a.port, () => {});
      }
      if (invalidation === "revoke") revokeSession(f.config, a.credential.run_id);
      else {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.mock.timers.tick(46_000);
      }
      proof.release();
      assert.equal((await inFlight).status, 410);
      assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
    });
  }
}

for (const failure of ["proof", "retirement"] as const) {
  test(`a bound successor ${failure} fails closed instead of reopening the registration wait`, async (t) => {
    const f = await fixture(t);
    const a = await f.backend("A");
    assert.ok(a.url);
    const { token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
    await a.registration.stop();
    await a.registration.start(a.port, () => {});
    const proof = a.pauseNextProof(failure === "proof");
    const inFlight = resolveHandoff(f.hub.url, token);
    await proof.entered;
    if (failure === "retirement") await a.registration.stop();
    proof.release();
    assert.equal((await inFlight).status, 410);
    await a.registration.stop();
    await a.registration.start(a.port, () => {});
    assert.equal((await resolveHandoff(f.hub.url, token)).status, 410, "never skip the first successor");
  });
}

test("renewals preserve the handoff until the first new generation registers", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const old = a.url;
  const { token } = await handoffConnection(t, old, new URL(f.hub.url).origin);
  const renew = (url: string) =>
    exchange(f.hub.socketPath, {
      action: "register",
      ...a.credential,
      generation: new URL(url).pathname.split("/")[2],
      port: a.port,
      sessionName: "renamed without replacement",
    });
  assert.equal((await renew(old)).ok, true);
  const unchanged = await resolveHandoff(f.hub.url, token);
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).path, new URL(old).pathname);
  await a.registration.stop();
  let next = "";
  await a.registration.start(a.port, (url) => {
    next = url ?? "";
  });
  assert.equal((await renew(next)).ok, true);
  const followed = await resolveHandoff(f.hub.url, token);
  assert.equal(followed.status, 200);
  assert.equal((await followed.json()).path, new URL(next).pathname);
  await a.registration.stop();
  await a.registration.start(a.port, () => {});
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
});

test("unbound pending polls do not extend the disconnected capability's 45-second deadline", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  // Freeze Date before closure so the server-side deadline is exact.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await a.registration.stop();
  await closed;
  t.mock.timers.tick(44_999);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 202);
  t.mock.timers.tick(1);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
});

test("backend events cannot overwrite the Hub-owned handoff control frame", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const received: string[] = [];
  const ordinary = new Promise<void>((resolve) =>
    socket.on("message", (data) => {
      received.push(data.toString());
      if (data.toString().includes('"event":"ordinary"')) resolve();
    }),
  );
  a.broadcast({
    type: "event",
    event: "hub_route",
    payload: { generation: new URL(a.url).pathname.split("/")[2], token: "0".repeat(48) },
  });
  a.broadcast({ type: "event", event: "ordinary", payload: { value: "unchanged" } });
  await ordinary;
  assert.equal(
    received.some((value) => value.includes('"event":"hub_route"')),
    false,
  );
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200);
});

test("PiClient keeps its capability until a replacement socket receives fresh Hub control", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A", JSON.stringify({ type: "event", event: "ordinary", payload: {} }));
  assert.ok(a.url);
  let page = new URL(a.url);
  const origin = page.origin;
  const actualFetch = globalThis.fetch;
  const saved = new Map(
    ["window", "location", "WebSocket", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const client = new PiClient({
    onConnectionChange() {},
    onError() {},
    onEvent() {},
    onPromptResponse() {},
    onOpen() {
      opens += 1;
    },
  });
  let opens = 0;
  const routeNotifications: string[] = [];
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, get: () => page });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        dispatchEvent(event: Event) {
          assert.equal(event.type, "pi-web-route-changed");
          routeNotifications.push(page.pathname);
          return true;
        },
        history: {
          state: null,
          replaceState(_state: unknown, _title: string, value: string) {
            page = new URL(value, page);
          },
        },
      },
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class extends WebSocket {
        constructor(url: string) {
          super(url, { origin });
        }
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (url: string, init: RequestInit) =>
        actualFetch(new URL(url, page), { ...init, headers: { ...init.headers, Origin: origin } }),
    });
    client.connect();
    await until(() => opens === 1);
    // A network drop first resolves to still-current A. That replacement
    // handshake fails while the real Pi registration moves to B.
    a.failNextUpgrade(async () => {
      await a.registration.stop();
      await a.registration.start(a.port, () => {});
    });
    a.disconnectBrowsers();
    await until(() => opens === 2);
    assert.notEqual(page.pathname, new URL(a.url).pathname);
    assert.ok(
      routeNotifications.includes(page.pathname),
      "route scoped UI is notified before replacement socket opens",
    );
    assert.equal((await actualFetch(page)).status, 200);
  } finally {
    client.disconnect();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function until(condition: () => boolean) {
  const end = Date.now() + 2500;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "real transport did not reconnect to the successor");
}

test("an open browser follows only its Pi successor while the old route stays gone", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  const b = await f.backend("B");
  assert.ok(a.url && b.url);
  const old = a.url;
  const { token } = await handoffConnection(t, old, new URL(f.hub.url).origin);
  const stillLive = await resolveHandoff(f.hub.url, token);
  assert.equal(stillLive.status, 200);
  assert.equal((await stillLive.json()).path, new URL(old).pathname, "B is not a substitute for A");
  assert.equal((await resolveHandoff(f.hub.url, token, "https://attacker.example")).status, 403);
  assert.equal((await resolveHandoff(f.hub.url, "0".repeat(48))).status, 410);
  await a.registration.stop();
  assert.equal((await fetch(old)).status, 410);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 202);
  let next = "";
  await a.registration.start(a.port, (url) => {
    next = url ?? "";
  });
  const response = await resolveHandoff(f.hub.url, token);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.path, new URL(next).pathname);
  assert.notEqual(result.path, new URL(b.url).pathname);
  assert.equal((await fetch(old)).status, 410, "handoff must not revive a retired link");
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200, "a lost response may be retried idempotently");
  await a.registration.stop();
  await a.registration.start(a.port, () => {});
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410, "never follow a second unrelated replacement");
});

test("revocation and Hub restart invalidate browser handoff capabilities", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  revokeSession(f.config, a.credential.run_id);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
  const b = await f.backend("B");
  assert.ok(b.url);
  const other = await handoffConnection(t, b.url, new URL(f.hub.url).origin);
  await f.restart();
  assert.equal((await resolveHandoff(f.hub.url, other.token)).status, 410);
});

test("a disconnected browser capability expires even when the Pi later registers again", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await a.registration.stop();
  await closed;
  // Advance only Date; sockets and registration deadlines remain real.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(46_000);
  await a.registration.start(a.port, () => {});
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
});

test("display names update on the same route, are bounded and nullable, and cannot become capability identities", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("Folder");
  const list = async () => (await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions;
  const original = (await list())[0];
  const renew = (sessionName: unknown) =>
    exchange(f.hub.socketPath, {
      action: "register",
      ...a.credential,
      generation: original.generation,
      port: a.port,
      sessionName,
    });
  assert.equal(original.sessionName, null);
  assert.equal((await renew("<img src=x onerror=alert(1)> 会话")).ok, true);
  let current = (await list())[0];
  assert.equal(current.sessionName, "<img src=x onerror=alert(1)> 会话");
  assert.equal(current.path, original.path);
  assert.equal(current.label, "Folder");
  for (const invalid of [123, {}, ["name"], "x".repeat(257)]) assert.equal((await renew(invalid)).ok, false);
  assert.equal((await renew(null)).ok, true);
  current = (await list())[0];
  assert.equal(current.sessionName, null);
  assert.equal(current.path, original.path);
  assert.equal(current.since, original.since);
});

test("software is bounded display metadata independent of managed control, with stable renewal routes", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("Software fixture");
  const list = async () => await (await fetch(`${f.hub.url}api/sessions`)).json();
  const original = (await list()).sessions[0];
  assert.equal(original.software, undefined, "legacy registrations remain supported");
  const renew = (software: unknown, runtime?: unknown) =>
    exchange(f.hub.socketPath, {
      action: "register",
      ...a.credential,
      generation: original.generation,
      port: a.port,
      software,
      runtime,
    });
  const software = { piVersion: "1.3.0", webUi: { version: "0.1.1", build: "c".repeat(64) } };
  assert.equal((await renew(software)).ok, true);
  const first = (await list()).sessions[0];
  assert.deepEqual(first.software, software);
  assert.equal(first.runtime, undefined, "software never creates managed restart authority");
  assert.equal(first.path, original.path);
  assert.equal(first.since, original.since);
  assert.equal(first.generation, original.generation);
  for (const invalid of [
    null,
    [],
    { piVersion: "latest" },
    { ...software, runtimeId: "secret" },
    {
      ...software,
      webUi: { ...software.webUi, build: "x".repeat(64) },
    },
  ])
    assert.equal((await renew(invalid)).ok, false);
  assert.deepEqual((await list()).sessions[0].software, software, "invalid software cannot overwrite metadata");
  const runtime = {
    runtimeId: "private-runtime",
    sessionId: "private-session",
    leafId: "private-leaf",
    version: "1.3.0",
    managed: true,
  };
  assert.equal((await renew(software, runtime)).ok, true);
  const managed = await list();
  assert.deepEqual(managed.sessions[0].runtime, { version: "1.3.0", managed: true });
  const serialized = JSON.stringify(managed);
  for (const secret of [
    a.credential.run_id,
    a.credential.token,
    runtime.runtimeId,
    runtime.sessionId,
    runtime.leafId,
  ]) {
    assert.ok(!serialized.includes(secret), "session list cannot leak internal control identities or credentials");
  }
  assert.ok(["ok", "checking"].includes(managed.versions.status));
  assert.equal((await renew({ piVersion: "1.4.0" })).ok, true);
  assert.deepEqual((await list()).sessions[0].software, { piVersion: "1.4.0" });
});

test("two separately authorized sessions route HTTP and remove only the stopped generation", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("Project A");
  const b = await f.backend("Project B");
  assert.ok(a.url && b.url && a.url !== b.url);
  const list = await (await fetch(`${f.hub.url}api/sessions`)).json();
  assert.deepEqual(list.sessions.map((s: { label: string }) => s.label).sort(), ["Project A", "Project B"]);
  const metadata = JSON.stringify(list);
  assert.ok(!metadata.includes(a.credential.token) && !metadata.includes(f.config.stateDir));
  const response = await fetch(`${a.url}assets/test.js?x=1`, { headers: { "x-pi-web-proof": "spoofed" } });
  const body = await response.json();
  assert.equal(body.label, "Project A");
  assert.equal(body.url, "/assets/test.js?x=1");
  assert.match(body.proof, /^[a-f0-9]{64}$/);
  const oldUrl = a.url;
  await a.registration.stop();
  assert.equal((await fetch(oldUrl)).status, 410);
  assert.equal((await fetch(b.url)).status, 200);
});

test("five independent Pi runs register and route without consuming browser-pair admission", async (t) => {
  const f = await fixture(t);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await f.backend(`Pi ${i + 1}`));
  assert.equal((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions.length, 5);
  for (const run of runs) {
    assert.ok(run.url);
    assert.equal((await fetch(run.url)).status, 200);
  }
});

test("WebSocket routing injects proof and rejects cross-origin connections", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const ws = new WebSocket(`${a.url.replace("http:", "ws:")}ws`, { origin: new URL(f.hub.url).origin });
  t.after(() => ws.terminate());
  assert.equal(
    await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => {
        if (data.toString() === "A") resolve("A");
      });
      ws.once("error", reject);
    }),
    "A",
  );
  const rejected = new WebSocket(`${a.url.replace("http:", "ws:")}ws`, { origin: "https://attacker.example" });
  await new Promise<void>((resolve, reject) => {
    rejected.once("error", () => resolve());
    rejected.once("open", () => {
      rejected.terminate();
      reject(new Error("Hostile origin accepted"));
    });
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await a.registration.stop();
  await closed;
});

test("expired and pre-restart generation URLs cannot be reused", async (t) => {
  const f = await fixture(t, 500);
  const a = await f.backend("A");
  assert.ok(a.url);
  const old = a.url;
  // start() begins its deadline before awaiting a probe: allow the full lease after reply.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await fetch(old)).status, 410);
  await a.registration.start(a.port, () => {});
  const beforeRestart = (await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions[0].path;
  await f.restart();
  assert.equal((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions.length, 0);
  assert.equal((await fetch(`${f.hub.url.slice(0, -1)}${beforeRestart}`)).status, 410);
});

test("revoking one grant blocks enrollment and retires its current route", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  revokeSession(f.config, a.credential.run_id);
  assert.equal((await fetch(a.url)).status, 410);
  assert.equal((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions.length, 0);
});

test("IPC rejects forged credentials, oversized requests and unproved backend ports", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  const exchange = (value: string) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const socket = net.createConnection(f.hub.socketPath, () => socket.write(value));
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(data));
        }
      });
      socket.on("error", reject);
    });
  assert.equal(
    (
      await exchange(
        `${JSON.stringify({ action: "register", ...a.credential, token: "0".repeat(64), generation: "a".repeat(32), port: a.port })}\n`,
      )
    ).ok,
    false,
  );
  assert.equal((await exchange(`${"a".repeat(8193)}\n`)).ok, false);
  const fake = http.createServer((_req, res) =>
    res.end(JSON.stringify({ generation: "b".repeat(32), proof: "not-a-proof" })),
  );
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => fake.close(() => resolve())));
  const port = (fake.address() as net.AddressInfo).port;
  assert.equal(
    (await exchange(`${JSON.stringify({ action: "register", ...a.credential, generation: "b".repeat(32), port })}\n`))
      .ok,
    false,
  );
  assert.equal(
    (await fetch(`${f.hub.url}api/sessions`, { headers: { Origin: "https://attacker.example" } })).status,
    403,
  );
});

test("registration IPC can be mounted without exposing administrator grants", async (t) => {
  const f = await fixture(t);
  assert.ok(!f.hub.socketPath.startsWith(`${f.config.stateDir}${path.sep}`));
});

test("concurrent starts cannot replace a newly live registration socket", async (t) => {
  const f = await fixture(t);
  await f.hub.close();
  const stale = spawnSync(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    f.config.socketPath,
  ]);
  assert.equal(stale.status, 0);
  const results = await Promise.allSettled([startHub(f.config), startHub(f.config)]);
  const hubs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  t.after(async () => {
    for (const hub of hubs) await hub.close();
  });
  assert.equal(hubs.length, 1, "only one manager may acquire the registry");
  assert.equal((await exchange(f.config.socketPath, {})).ok, false, "winner registry remains reachable");
});

test("a renewal whose proof crosses expiry reports an ended generation", async (t) => {
  const f = await fixture(t, 500);
  const credential = issueSession(f.config, path.join(path.dirname(f.configFile), "slow.json"), { label: "Slow" });
  const generation = "c".repeat(32);
  let delay = 0;
  const backend = http.createServer((req, res) => {
    const challenge = req.headers["x-pi-web-challenge"];
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            generation,
            proof: createHmac("sha256", credential.token).update(`${challenge}:${generation}`).digest("hex"),
          }),
        ),
      delay,
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const request = { action: "register", ...credential, generation, port: (backend.address() as net.AddressInfo).port };
  assert.equal((await exchange(f.hub.socketPath, request)).ok, true);
  delay = 650;
  const renewal = await exchange(f.hub.socketPath, request);
  assert.equal(renewal.ok, false);
  assert.equal(renewal.error, "ended generation");
});

test("unregister before enrollment fences that generation permanently", async (t) => {
  const f = await fixture(t);
  const credential = issueSession(f.config, path.join(path.dirname(f.configFile), "legacy.json"), { label: "Legacy" });
  const generation = "d".repeat(32);
  assert.equal((await exchange(f.hub.socketPath, { action: "unregister", ...credential, generation })).ok, true);
  const result = await exchange(f.hub.socketPath, { action: "register", ...credential, generation, port: 12345 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ended generation");
});

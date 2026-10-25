import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";
import { runInNewContext } from "node:vm";
import { createInteractionRequest, type InteractionSpec } from "../protocol/interactions/protocol.ts";

// Import inside the fixture: the first RED is an explicit missing-feature assertion.
const modulePath = "../hub/interaction-page.ts";
const generation = `b2-${"a".repeat(32)}-${"b".repeat(16)}-${"c".repeat(32)}`;
const code = "e".repeat(32);
const spec = (): InteractionSpec => ({
  action: "write",
  revision: "prepared-1",
  classification: "sensitive",
  method: "confirm",
  schema: { kind: "confirm" },
  content: { preview: "完整预览\n第二行", scope: "folder", target: "notes" },
  deadline: Date.now() + 110_000,
});
const request = (overrides: Partial<InteractionSpec> = {}) =>
  createInteractionRequest(
    { runId: "d".repeat(32), generation, runtimeId: "runtime-1", sessionId: "session-1" },
    { id: "memory", version: "1.0.0", packageName: "memory-adapter" },
    { ...spec(), ...overrides },
  );

type Listener = (event: { preventDefault(): void; persisted?: boolean }) => unknown;
class Element {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  type = "";
  children: Element[] = [];
  listeners = new Map<string, Listener>();
  focused = false;
  set innerHTML(_value: string) {
    assert.fail("Untrusted markup must never be parsed");
  }
  set outerHTML(_value: string) {
    assert.fail("Untrusted markup must never be parsed");
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    this.textContent = "";
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }
  setAttribute(name: string, value: string) {
    assert.ok(
      !/^on/i.test(name) && !["src", "href", "srcdoc"].includes(name),
      "No dynamic resource/navigation attributes",
    );
    if (name === "type") this.type = value;
  }
  focus() {
    this.focused = true;
  }
  async fire(type = "click") {
    await this.listeners.get(type)?.({ preventDefault() {} });
  }
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < end, "page did not settle within the bounded test window");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(
  t: TestContext,
  options: {
    live?: ReturnType<typeof request>;
    authorized?: boolean;
    gateway?: boolean;
    route?: string;
    framed?: boolean;
  } = {},
) {
  const page = await import(modulePath).catch(() => undefined);
  assert.ok(
    page && typeof page.renderInteractionPageHtml === "function",
    "Trusted interaction page is not implemented",
  );
  const html: string = page.renderInteractionPageHtml();
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(match[0]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    elements.set(match[1], element);
  }
  const get = (id: string) => {
    const value = elements.get(id);
    assert.ok(value, `Missing HTML element ${id}`);
    return value;
  };
  let live: unknown = options.live ?? request();
  const initial = live as ReturnType<typeof request>;
  const api = `/api/management/interactions/${generation}/${initial.requestId}`;
  let authorized = options.authorized ?? true;
  const csrf = randomBytes(32).toString("hex");
  let failPost = false;
  let rejectRead = 0;
  let result: unknown = { state: "allowed" };
  const received: { path: string; method: string; body?: Record<string, unknown>; csrf?: string }[] = [];
  // Only disposable loopback HTTP. This boundary is synthetic, not Hub/Pi E2E.
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (
      path === `/interactions/${generation}/${initial.requestId}/` ||
      path === "/interaction-page.js" ||
      path === "/interaction-page.css"
    ) {
      const [type, content] = path.endsWith(".js")
        ? ["text/javascript", page.interactionPageJs]
        : path.endsWith(".css")
          ? ["text/css", page.interactionPageCss]
          : ["text/html", html];
      res
        .writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        })
        .end(content);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    received.push({ path, method: req.method ?? "GET", body, csrf: req.headers["x-pi-hub-csrf"] as string });
    const reply = (status: number, value: unknown) =>
      res
        .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify(value));
    if (path === "/api/management/status")
      return reply(200, {
        available: false,
        authorized,
        ...(options.gateway ? { authMode: "gateway" } : {}),
        ...(authorized ? { csrf, expiresAt: Date.now() + 600_000 } : {}),
      });
    if (path === "/api/management/gateway" || path === "/api/management/unlock") {
      if (req.method !== "POST" || req.headers.origin !== origin) return reply(403, {});
      if (path.endsWith("gateway") ? !options.gateway || Object.keys(body).length !== 0 : body.code !== code)
        return reply(401, {});
      authorized = true;
      return reply(200, { authorized, csrf, expiresAt: Date.now() + 600_000 });
    }
    if (path !== api) return reply(404, {});
    if (!authorized) return reply(401, { error: "PRIVATE ERROR MUST NOT RENDER" });
    if (req.method === "GET") return rejectRead ? reply(rejectRead, {}) : reply(200, live);
    if (req.method !== "POST" || req.headers.origin !== origin || req.headers["x-pi-hub-csrf"] !== csrf)
      return reply(403, {});
    if (failPost) {
      req.socket.destroy();
      return;
    }
    return reply(200, result);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const location = new URL(options.route ?? `/interactions/${generation}/${initial.requestId}/`, origin);
  const listeners = new Map<string, Listener>();
  const documentListeners = new Map<string, Listener>();
  const timers = new Map<number, { fn: () => unknown; delay: number }>();
  let sequence = 0;
  const opened: unknown[][] = [];
  const fetches: { path: string; init: RequestInit }[] = [];
  const denied = () => assert.fail("No browser storage, service worker, opener, or navigation authority");
  const window = {
    location,
    self: {} as unknown,
    top: {} as unknown,
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    open: (...args: unknown[]) => {
      opened.push(args);
      return null;
    },
    get opener() {
      return denied();
    },
    get localStorage() {
      return denied();
    },
    get sessionStorage() {
      return denied();
    },
  };
  window.self = window;
  window.top = options.framed ? {} : window;
  const document = {
    hidden: false,
    visibilityState: "visible",
    getElementById: get,
    createElement: (tag: string) => {
      assert.ok(!["script", "iframe", "a", "img", "link"].includes(tag));
      return new Element();
    },
    addEventListener: (name: string, listener: Listener) => documentListeners.set(name, listener),
  };
  runInNewContext(page.interactionPageJs, {
    window,
    document,
    location,
    URL,
    TextEncoder,
    TextDecoder,
    AbortSignal,
    AbortController,
    Uint8Array,
    crypto: webcrypto,
    console: { log: denied, error: denied, warn: denied },
    get localStorage() {
      return denied();
    },
    get sessionStorage() {
      return denied();
    },
    get indexedDB() {
      return denied();
    },
    navigator: {
      get serviceWorker() {
        return denied();
      },
    },
    setTimeout: (fn: () => unknown, delay: number) => {
      const id = ++sequence;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => {
      assert.equal(new URL(path, origin).origin, origin, "No cross-origin fetch");
      assert.equal(init.mode, "same-origin");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error");
      assert.equal(init.referrerPolicy, "no-referrer");
      fetches.push({ path, init });
      return fetch(new URL(path, origin), { ...init, headers: { ...init.headers, Origin: origin } });
    },
  });
  const ready = () => until(() => !get("review-refresh").disabled);
  const posts = () => received.filter((r) => r.path === api && r.method === "POST");
  const refresh = async () => {
    await get("review-refresh").fire();
    await ready();
  };
  return {
    html,
    page,
    initial,
    api,
    origin,
    location,
    get,
    opened,
    fetches,
    received,
    ready,
    refresh,
    posts,
    timers,
    document,
    setLive: (value: unknown) => {
      live = value;
    },
    setResult: (value: unknown) => {
      result = value;
    },
    setAuthorized: (value: boolean) => {
      authorized = value;
    },
    setFailPost: () => {
      failPost = true;
    },
    setReadError: (status: number) => {
      rejectRead = status;
    },
    hide: async () => {
      document.hidden = true;
      document.visibilityState = "hidden";
      await documentListeners.get("visibilitychange")?.({ preventDefault() {} });
    },
    show: async () => {
      document.hidden = false;
      document.visibilityState = "visible";
      await documentListeners.get("visibilitychange")?.({ preventDefault() {} });
    },
    pagehide: async () => {
      await listeners.get("pagehide")?.({ preventDefault() {} });
    },
  };
}

test("renders complete untrusted preview and schema as text, without storage or implicit actions", async (t) => {
  const preview = `<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n${"完整内容".repeat(3000)}END`;
  const f = await fixture(t, {
    live: request({ content: { preview, scope: "global", destination: "https://evil.invalid" } }),
  });
  await f.ready();
  assert.equal(f.get("review-preview").textContent, preview);
  assert.deepEqual(JSON.parse(f.get("review-schema").textContent), { kind: "confirm" });
  assert.deepEqual(JSON.parse(f.get("review-request").textContent), f.initial);
  assert.equal(f.posts().length, 0);
  assert.equal(f.opened.length, 0);
  assert.equal(f.get("review-allow").disabled, false);
  assert.match(f.html, /src="\/interaction-page.js"/);
  assert.match(f.html, /href="\/interaction-page.css"/);
});

test("gateway unlock is explicit, uses existing login even without Gate, and does not approve", async (t) => {
  const f = await fixture(t, { authorized: false, gateway: true });
  await f.ready();
  assert.equal(
    f.received.some((r) => r.path === f.api),
    false,
  );
  assert.equal(f.get("management-gateway").hidden, false);
  assert.equal(
    f.received.some((r) => r.method === "POST"),
    false,
  );
  await f.get("management-gateway").fire();
  await f.ready();
  assert.equal(f.get("review-allow").disabled, false);
  assert.deepEqual(f.received.find((r) => r.path.endsWith("gateway"))?.body, {});
  assert.equal(f.posts().length, 0);
});

test("existing one-time unlock erases the code and never approves during login", async (t) => {
  const f = await fixture(t, { authorized: false });
  await f.ready();
  f.get("management-code").value = code;
  await f.get("management-unlock").fire("submit");
  await f.ready();
  assert.equal(f.get("management-code").value, "");
  assert.equal(f.posts().length, 0);
  assert.equal(f.get("review-allow").disabled, false);
});

for (const [button, answer] of [
  ["review-allow", true],
  ["review-reject", false],
] as const) {
  test(`explicit ${button} sends bound decision with CSRF once, despite double clicks`, async (t) => {
    const f = await fixture(t);
    await f.ready();
    f.setResult({ state: answer ? "allowed" : "rejected" });
    await Promise.all([f.get(button).fire(), f.get(button).fire()]);
    assert.equal(f.posts().length, 1);
    const post = f.posts()[0];
    assert.match(post.csrf!, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(post.body!).sort(), ["answer", "decisionId", "digest", "revision"]);
    assert.equal(post.body?.answer, answer);
    assert.equal(post.body?.digest, f.initial.digest);
    assert.equal(post.body?.revision, "prepared-1");
    assert.match(post.body?.decisionId as string, /^[a-f0-9]{32}$/);
    assert.equal(f.get(button).disabled, true);
    if (answer) assert.match(f.get("review-status").textContent, /授权.*送达.*不代表.*执行/);
  });
}

test("unknown delivery preserves the one decision ID and queries only GET even if request remains pending", async (t) => {
  const f = await fixture(t);
  await f.ready();
  f.setFailPost();
  await f.get("review-allow").fire();
  assert.equal(f.posts().length, 1);
  const id = f.posts()[0].body?.decisionId as string;
  assert.ok(f.get("review-decision").textContent.includes(id));
  await f.refresh();
  await f.get("review-allow").fire();
  await f.get("review-reject").fire();
  assert.equal(f.posts().length, 1);
  assert.ok(f.get("review-decision").textContent.includes(id));
  assert.match(f.get("review-status").textContent, /不明|不确定|未知/);
});

test("GET completion reconciles an unknown decision without replay, and later outcome is separate", async (t) => {
  const f = await fixture(t);
  await f.ready();
  f.setFailPost();
  await f.get("review-allow").fire();
  const id = f.posts()[0].body?.decisionId as string;
  f.setLive({ state: "allowed" });
  await f.refresh();
  assert.match(f.get("review-status").textContent, /授权已送达.*不代表/);
  assert.doesNotMatch(f.get("review-outcome").textContent, /已执行成功/);
  assert.ok(f.get("review-decision").textContent.includes(id));
  f.setLive({ state: "allowed", outcome: "succeeded" });
  await f.refresh();
  assert.match(f.get("review-outcome").textContent, /源操作.*已执行成功/);
  await f.get("review-allow").fire();
  assert.equal(f.posts().length, 1);
});

test("terminal GET on initial load is read-only even if a later response claims pending", async (t) => {
  const f = await fixture(t, { authorized: false });
  await f.ready();
  f.setLive({ state: "cancelled" });
  f.get("management-code").value = code;
  await f.get("management-unlock").fire("submit");
  assert.match(f.get("review-status").textContent, /取消/);
  f.setLive(f.initial);
  await f.refresh();
  await f.get("review-allow").fire();
  assert.equal(f.get("review-allow").disabled, true);
  assert.equal(f.posts().length, 0);
});

test("changed revision or preview at preflight blocks the old displayed approval", async (t) => {
  const f = await fixture(t);
  await f.ready();
  f.setLive({ ...f.initial, content: { preview: "CHANGED" }, revision: "prepared-2", digest: "f".repeat(64) });
  await f.get("review-allow").fire();
  assert.equal(f.posts().length, 0);
  assert.equal(f.get("review-allow").disabled, true);
  assert.match(f.get("review-status").textContent, /变化|失效/);
});

test("revoked management clears private preview and callbacks before any decision", async (t) => {
  const f = await fixture(t);
  await f.ready();
  f.setAuthorized(false);
  await f.get("review-allow").fire();
  assert.equal(f.posts().length, 0);
  assert.equal(f.get("review-preview").textContent, "");
  assert.equal(f.get("review-request").textContent, "");
  assert.equal(f.get("review-allow").disabled, true);
});

for (const state of ["pending", "delivering", "cancelled", "expired", "stale", "delivery_unknown"]) {
  test(`${state} never claims execution success or permits another decision`, async (t) => {
    const f = await fixture(t);
    await f.ready();
    f.setResult({ state });
    await f.get("review-allow").fire();
    assert.doesNotMatch(f.get("review-status").textContent, /执行成功|已完成执行|操作成功/);
    assert.equal(f.get("review-allow").disabled, true);
    assert.equal(f.posts().length, 1);
  });
}

test("expired full request and mismatched route identity remain read-only", async (t) => {
  const f = await fixture(t);
  await f.ready();
  f.setLive({ ...f.initial, deadline: Date.now() - 1 });
  await f.refresh();
  await f.get("review-allow").fire();
  assert.equal(f.posts().length, 0);
  assert.match(f.get("review-status").textContent, /过期|失效/);
});

for (const route of [
  "/interactions/../wrong/",
  `/interactions/${generation}/${"a".repeat(32)}/?next=https://evil.invalid`,
  `/interactions/${generation}/${"a".repeat(32)}/#callback=secret`,
  `/interactions/${generation}/%61${"a".repeat(31)}/`,
]) {
  test(`invalid route never fetches or redirects: ${route}`, async (t) => {
    const f = await fixture(t, { route });
    await f.ready();
    assert.equal(f.fetches.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(f.get("review-allow").disabled, true);
  });
}

test("framed page refuses to fetch sensitive data even before server frame headers are integrated", async (t) => {
  const f = await fixture(t, { framed: true });
  await f.ready();
  assert.equal(f.fetches.length, 0);
});

test("select is explicit and schema-bound; no initial default silently authorizes", async (t) => {
  const f = await fixture(t, {
    live: request({ method: "select", schema: { kind: "select", options: ["允许目录 A", "拒绝"] } }),
  });
  await f.ready();
  await f.get("review-answer-form").fire("submit");
  assert.equal(f.posts().length, 0);
  f.get("review-options").value = "not-an-option";
  await f.get("review-answer-form").fire("submit");
  assert.equal(f.posts().length, 0);
  f.get("review-options").value = "拒绝";
  await f.get("review-answer-form").fire("submit");
  assert.equal(f.posts()[0].body?.answer, "拒绝");
});

test("text limit is UTF-8 bytes; callback is transient and the exact entered answer is sent", async (t) => {
  const f = await fixture(t, {
    live: request({
      method: "input",
      schema: { kind: "text", maxBytes: 6 },
      purpose: "oauth",
      content: { preview: "粘贴提供方回调", authorizationUrl: "https://provider.invalid/authorize?state=synthetic" },
    }),
  });
  await f.ready();
  f.get("review-text").value = "中文多";
  await f.get("review-answer-form").fire("submit");
  assert.equal(f.posts().length, 0);
  f.get("review-text").value = "中文";
  await f.get("review-answer-form").fire("submit");
  assert.equal(f.posts()[0].body?.answer, "中文");
  assert.equal(f.get("review-text").value, "");
});

test("OAuth link only opens on explicit click with opener/referrer disabled; no callback query redirect", async (t) => {
  const url = "https://provider.invalid/authorize?state=synthetic";
  const f = await fixture(t, {
    live: request({
      purpose: "oauth",
      method: "input",
      schema: { kind: "text", maxBytes: 4096 },
      content: { preview: "OAuth", authorizationUrl: url },
    }),
  });
  await f.ready();
  assert.equal(f.opened.length, 0);
  await f.get("review-oauth-open").fire();
  assert.deepEqual(f.opened, [[url, "_blank", "noopener,noreferrer"]]);
  assert.equal(f.posts().length, 0);
  assert.match(f.get("review-notice").textContent, /提供方|弹窗|弹出/);
  f.get("review-text").value = "callback-secret";
  await f.pagehide();
  assert.equal(f.get("review-text").value, "");
  assert.equal(f.get("review-request").textContent, "");
  assert.equal(f.timers.size, 0);
});

for (const authorizationUrl of [
  "javascript:alert(1)",
  "http://provider.invalid",
  "https://user:password@provider.invalid",
  "//provider.invalid",
]) {
  test(`OAuth never opens unsafe provider URL: ${authorizationUrl}`, async (t) => {
    const f = await fixture(t, { live: request({ purpose: "oauth", content: { authorizationUrl } }) });
    await f.ready();
    await f.get("review-oauth-open").fire();
    assert.equal(f.opened.length, 0);
  });
}

test("hidden review stops polling, clears timers on pagehide, and cancel is not an approval", async (t) => {
  const f = await fixture(t);
  await f.ready();
  assert.ok(f.timers.size > 0);
  await f.hide();
  assert.ok(
    [...f.timers.values()].every((timer) => timer.delay > 2000),
    "No background poll loop",
  );
  await f.show();
  await f.ready();
  await f.get("review-cancel").fire();
  assert.equal(f.posts().length, 0);
  assert.equal(f.get("review-allow").disabled, true);
  assert.match(f.get("review-status").textContent, /未提交|未授权/);
  await f.pagehide();
  assert.equal(f.timers.size, 0);
});

test("oversized or malformed complete request is refused, never truncated for an actionable review", async (t) => {
  const f = await fixture(t, { authorized: false });
  await f.ready();
  f.setLive({ ...f.initial, content: { preview: "x".repeat(65536) } });
  f.get("management-code").value = code;
  await f.get("management-unlock").fire("submit");
  await f.ready();
  assert.equal(f.get("review-allow").disabled, true);
  assert.equal(f.get("review-preview").textContent, "");
  assert.equal(f.posts().length, 0);
});

test("reauthentication re-renders the same request after private data was cleared, without a stale empty approval", async (t) => {
  const f = await fixture(t, { gateway: true });
  await f.ready();
  f.setAuthorized(false);
  await f.refresh();
  assert.equal(f.get("review-request").textContent, "");
  await f.get("management-gateway").fire();
  await f.ready();
  assert.deepEqual(JSON.parse(f.get("review-request").textContent), f.initial);
  assert.equal(f.get("review-allow").disabled, false);
  assert.equal(f.posts().length, 0);
});

test("same-request polling preserves an in-progress answer and does not focus-steal", async (t) => {
  const f = await fixture(t, { live: request({ method: "editor", schema: { kind: "text", maxBytes: 4096 } }) });
  await f.ready();
  f.get("review-text").value = "private draft";
  f.get("review-preview").focused = false;
  await f.refresh();
  assert.equal(f.get("review-text").value, "private draft");
  assert.equal(f.get("review-preview").focused, false);
  assert.equal(f.posts().length, 0);
});

test("pagehide fences a late response and never repopulates private data", async (t) => {
  const f = await fixture(t);
  await f.pagehide();
  await f.ready();
  assert.equal(f.get("review-request").textContent, "");
  assert.equal(f.get("review-allow").disabled, true);
  assert.equal(f.posts().length, 0);
  assert.equal(f.timers.size, 0);
});

for (const changed of [
  { identity: { runId: "d".repeat(32), generation: "a".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" } },
  { requestId: "a".repeat(32) },
  { classification: "session" },
  { schema: { kind: "html" } },
  { schema: { kind: "text", maxBytes: 100 } },
]) {
  test(`wrong identity, class, or unsupported answer schema stays non-actionable: ${JSON.stringify(changed)}`, async (t) => {
    const f = await fixture(t, { authorized: false });
    await f.ready();
    f.setLive({ ...f.initial, ...changed });
    f.get("management-code").value = code;
    await f.get("management-unlock").fire("submit");
    assert.equal(f.get("review-allow").disabled, true);
    assert.equal(f.posts().length, 0);
    assert.equal(f.get("review-request").textContent, "");
  });
}

test("deadline expiry locks controls and erases callback data without an approval", async (t) => {
  const f = await fixture(t, { live: request({ method: "input", schema: { kind: "text", maxBytes: 4096 } }) });
  await f.ready();
  f.get("review-text").value = "private callback";
  const expiry = [...f.timers.values()].find((timer) => timer.delay > 2000);
  assert.ok(expiry);
  await expiry.fn();
  assert.equal(f.get("review-text").value, "");
  assert.equal(f.get("review-answer-submit").disabled, true);
  assert.equal(f.posts().length, 0);
  assert.equal(f.timers.size, 0);
});

test("local Chromium checks actual HTML, CSP, phone layout and explicit decision (opt-in, not Pi E2E)", {
  skip: !process.env.PI_INTERACTION_TEST_BROWSER,
}, async (t) => {
  const { chromium } = await import("@playwright/test");
  const f = await fixture(t, {
    live: request({
      content: {
        preview: '<img src=x onerror="window.injected=true">\n完整预览：修改 notes 文件。\n不自动授权，不隐藏范围。',
        scope: "folder",
        target: "notes",
      },
    }),
  });
  await f.ready();
  const browser = await chromium.launch({ executablePath: process.env.PI_INTERACTION_TEST_BROWSER, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.location.href);
  await page.locator("#review-allow").waitFor({ state: "visible" });
  await page.waitForFunction(() => !(document.getElementById("review-allow") as HTMLButtonElement).disabled);
  assert.equal(await page.locator("#review-preview img").count(), 0);
  assert.equal(await page.locator("#review-preview").textContent(), f.initial.content.preview);
  assert.equal(f.posts().length, 0);
  for (const [name, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator("#review-allow").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#review-allow").isVisible());
    if (process.env.PI_INTERACTION_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.PI_INTERACTION_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
  await page.locator("#review-allow").click();
  await page.waitForFunction(() => document.getElementById("review-status")?.textContent?.includes("授权已送达"));
  assert.equal(f.posts().length, 1);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length), 0);
});

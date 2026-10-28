import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";

type AuthState = {
  authenticated: boolean;
  setupRequired: boolean;
  setupAllowed: boolean;
  csrfToken: string;
  username?: string;
};
type Call = { route: string; options: Record<string, unknown>; body?: unknown };
type Reply = { status: number; value: unknown };

const initialState = (changes: Partial<AuthState> = {}): AuthState => ({
  authenticated: false,
  setupRequired: false,
  setupAllowed: false,
  csrfToken: "csrf-only-in-memory",
  ...changes,
});

const settle = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function rendered() {
  const ui = await import("../manager/local-auth-ui.ts").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  });
  assert.ok(ui, "the auth UI sidecar has not been implemented");
  const capture = (fn: (res: ServerResponse) => void) => {
    let body = "";
    let status = 0;
    let headers: Record<string, string> = {};
    fn({
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; return this; },
      end(value: string) { body = value; },
    } as unknown as ServerResponse);
    return { body, status, headers };
  };
  return {
    login: capture(ui.renderAuthPage),
    account: capture(ui.renderAccountPage),
    script: capture(ui.renderAuthScript),
  };
}

class Element {
  tagName: string;
  private ownText = "";
  children: Element[] = [];
  value = "";
  disabled = false;
  hidden = false;
  attributes = new Map<string, string>();
  handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error("untrusted HTML must never be interpreted"); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, handler: (event: { preventDefault(): void }) => unknown) { this.handlers.set(type, handler); }
  async fire(type = "click") {
    if (!this.disabled && !this.hidden) await this.handlers.get(type)?.({ preventDefault() {} });
    await settle();
  }
}

async function fixture(page: "login" | "account", state = initialState()) {
  const output = await rendered();
  const response = page === "login" ? output.login : output.account;
  const elements = new Map<string, Element>();
  for (const match of response.body.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node = new Element(match[1]);
    node.disabled = /\sdisabled(?:\s|>|$|=)/.test(match[2]);
    node.hidden = /\shidden(?:\s|>|$|=)/.test(match[2]);
    elements.set(match[3], node);
  }
  const get = (id: string) => {
    const node = elements.get(id);
    assert.ok(node, `missing HTML element #${id}`);
    return node;
  };
  const calls: Call[] = [];
  const navigations: string[] = [];
  const handlers = new Map<string, (call: Call) => unknown | Promise<unknown>>();
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  let timerId = 0;
  const reply = (status: number, value: unknown): Reply => ({ status, value });
  const fetch = async (route: string, options: Record<string, unknown> = {}) => {
    const call: Call = { route, options, body: typeof options.body === "string" ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const value = handlers.has(route) ? await handlers.get(route)!(call) :
      route === "/api/auth/state" ? state : reply(200, {});
    const result = value && typeof value === "object" && "status" in value ? value as Reply : reply(200, value);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => structuredClone(result.value) };
  };
  const location = { replace: (path: string) => navigations.push(path), search: "?next=https://attacker.invalid" };
  const forbiddenStorage = new Proxy({}, { get() { throw new Error("auth state must not use browser storage"); } });
  runInNewContext(output.script.body, {
    document: { body: { dataset: { authPage: page } }, getElementById: (id: string) => elements.get(id) ?? null, createElement: (tag: string) => new Element(tag) },
    fetch, location, AbortController,
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    setTimeout(callback: () => unknown, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { timeout: 1000 });
  await settle();
  return { output, response, state, get, calls, handlers, navigations, reply, timers };
}

// Break caught: cached/interpretable auth pages can expose stale credentials or be embedded by another site.
test("auth renderers return Chinese mobile pages with restrictive headers and external script only", async () => {
  const { login, account, script } = await rendered();
  for (const response of [login, account, script]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.headers["Referrer-Policy"], "no-referrer");
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  }
  assert.match(login.headers["Content-Type"], /text\/html.*utf-8/);
  assert.match(account.headers["Content-Type"], /text\/html.*utf-8/);
  assert.match(script.headers["Content-Type"], /javascript.*utf-8/);
  for (const page of [login.body, account.body]) {
    const csp = page === login.body ? login.headers["Content-Security-Policy"] : account.headers["Content-Security-Policy"];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(page, /lang="zh-CN"/);
    assert.match(page, /<script src="\/auth\.js" defer><\/script>/);
    assert.doesNotMatch(page, /<script(?!\s+src=)[^>]*>/i);
    assert.doesNotMatch(page, /<(?:input|textarea)[^>]+\svalue=/i);
    assert.doesNotMatch(page, /(?:csrf|authorization|bearer|token)\s*=/i);
  }
  assert.match(login.body, /id="auth-username"[^>]*autocomplete="username"[^>]*maxlength=/);
  assert.match(login.body, /id="auth-password"[^>]*autocomplete="current-password"[^>]*maxlength="256"/);
  assert.match(account.body, /id="auth-current-password"[^>]*autocomplete="current-password"/);
  assert.match(account.body, /id="auth-password"[^>]*autocomplete="new-password"/);
  assert.doesNotThrow(() => new Function(script.body));
});

// Break caught: setup exposed remotely or login redirected to an attacker supplied next URL.
test("login page uses state CSRF, same-origin credentials, fixed success redirect, and generic errors", async () => {
  const f = await fixture("login");
  assert.equal(f.calls[0]?.options.method, "GET");
  assert.equal(f.calls[0]?.options.credentials, "same-origin");
  assert.equal(f.calls[0]?.options.cache, "no-store");
  assert.ok(f.calls[0]?.options.signal, "state request has an abort signal");
  f.get("auth-username").value = "alice";
  f.get("auth-password").value = "correct horse battery staple";
  await f.get("auth-form").fire("submit");
  const login = f.calls.find((call) => call.route === "/api/auth/login");
  assert.ok(login);
  assert.deepEqual(login.body, { username: "alice", password: "correct horse battery staple" });
  assert.equal((login.options.headers as Record<string, string>)["X-Pi-Local-Csrf"], "csrf-only-in-memory");
  assert.equal(login.options.credentials, "same-origin");
  assert.equal(login.options.cache, "no-store");
  assert.deepEqual(f.navigations, ["/"]);

  const rejected = await fixture("login");
  rejected.handlers.set("/api/auth/login", () => rejected.reply(401, { error: "internal database detail" }));
  rejected.get("auth-username").value = "alice";
  rejected.get("auth-password").value = "correct horse battery staple";
  await rejected.get("auth-form").fire("submit");
  assert.match(rejected.get("auth-error").textContent, /无法登录|操作未完成/);
  assert.doesNotMatch(rejected.get("auth-error").textContent, /database|internal/i);
});

// Break caught: allowing browser-driven public registration when local bootstrap is disabled.
test("setup is available only when the state explicitly permits local bootstrap", async () => {
  const denied = await fixture("login", initialState({ setupRequired: true, setupAllowed: false }));
  assert.equal(denied.get("auth-form").hidden, true);
  assert.match(denied.get("auth-notice").textContent, /本机|终端|初始化/);
  assert.equal(denied.calls.some((call) => call.route === "/api/auth/setup"), false);

  const allowed = await fixture("login", initialState({ setupRequired: true, setupAllowed: true }));
  assert.match(allowed.get("auth-title").textContent, /初始化/);
  allowed.get("auth-username").value = "local-admin";
  allowed.get("auth-password").value = "twelve chars or more";
  await allowed.get("auth-form").fire("submit");
  const setup = allowed.calls.find((call) => call.route === "/api/auth/setup");
  assert.ok(setup);
  assert.deepEqual(setup.body, { username: "local-admin", password: "twelve chars or more" });
  assert.deepEqual(allowed.navigations, ["/"]);
});

// Break caught: stale account sessions remain usable or password changes leave the old session authenticated.
test("account page fills the current user safely, changes password with CSRF, and returns to login", async () => {
  const f = await fixture("account", initialState({ authenticated: true, username: "alice" }));
  assert.equal(f.get("auth-current-username").textContent, "alice");
  assert.equal(f.get("auth-username").value, "alice");
  f.get("auth-current-password").value = "old password that is long enough";
  f.get("auth-password").value = "new password that is long enough";
  await f.get("auth-form").fire("submit");
  const change = f.calls.find((call) => call.route === "/api/auth/password");
  assert.ok(change);
  assert.deepEqual(change.body, {
    currentPassword: "old password that is long enough",
    username: "alice",
    password: "new password that is long enough",
  });
  assert.equal((change.options.headers as Record<string, string>)["X-Pi-Local-Csrf"], "csrf-only-in-memory");
  assert.deepEqual(f.navigations, ["/login"]);

  const expired = await fixture("account", initialState({ authenticated: false }));
  assert.deepEqual(expired.navigations, ["/login"]);
});

// Break caught: duplicate slow submits and a short client timeout while password hashing is still in progress.
test("auth submit stays disabled while pending and allocates the longer post timeout", async () => {
  const f = await fixture("login");
  const pending = deferred<unknown>();
  f.handlers.set("/api/auth/login", () => pending.promise);
  f.get("auth-username").value = "alice";
  f.get("auth-password").value = "correct horse battery staple";
  const submit = f.get("auth-form").fire("submit");
  await settle();
  assert.equal(f.get("auth-submit").disabled, true);
  assert.ok([...f.timers.values()].some((timer) => timer.delay === 30000));
  await f.get("auth-form").fire("submit");
  assert.equal(f.calls.filter((call) => call.route === "/api/auth/login").length, 1);
  pending.resolve({});
  await submit;
  assert.deepEqual(f.navigations, ["/"]);
});

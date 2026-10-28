import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";

type Workspace = { root: string; path: string };
type Run = {
  id: string;
  workspace: Workspace;
  state: "starting" | "ready" | "failed" | "stopping" | "stopped" | "unknown";
  path?: string;
  error?: string;
};
type TerminalSession = {
  label: string;
  sessionName?: string | null;
  generation: string;
  path: string;
  since: number;
};
type State = {
  defaultWorkspace: Workspace;
  browser: { defaultRoot: string; roots: { id: string; label: string }[] };
  runs: Run[];
  sessions?: TerminalSession[];
  csrfToken: string;
};
type Call = { route: string; method: string; headers: Record<string, string>; body?: any };
type Reply = { status: number; value: unknown };

const workspace = { root: "projects", path: "pi_projects" };
const uuid = "b2674ff4-2bfd-4a21-bdb8-98c4a5460071";
const run = (changes: Partial<Run> = {}): Run => ({ id: "new-run", workspace: { ...workspace }, state: "starting", ...changes });
const initialState = (): State => ({
  defaultWorkspace: { ...workspace },
  browser: { defaultRoot: "projects", roots: [{ id: "projects", label: "项目" }, { id: "scratch", label: "临时目录" }] },
  runs: [],
  csrfToken: "internal-csrf-not-for-display",
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
  // A missing new module is an assertion failure during the initial RED run.
  const ui = await import("../manager/local-ui.ts").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  });
  assert.ok(ui, "the new local UI renderer has not been implemented");
  function capture(fn: (res: ServerResponse) => void) {
    let body = "";
    let status = 0;
    let headers: Record<string, string> = {};
    fn({
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; return this; },
      end(value: string) { body = value; },
    } as unknown as ServerResponse);
    return { body, status, headers };
  }
  return { html: capture(ui.renderLocalPage), script: capture(ui.renderLocalScript) };
}

class Element {
  tagName: string;
  private ownText = "";
  children: Element[] = [];
  value = "";
  disabled = false;
  hidden = false;
  href = "";
  type = "";
  className = "";
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

async function fixture(state = initialState()) {
  const output = await rendered();
  const elements = new Map<string, Element>();
  for (const match of output.html.body.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
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
  const confirmations: string[] = [];
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  let sequence = 0;
  let randomCalls = 0;
  let confirmed = true;
  const handlers = new Map<string, (call: Call) => unknown | Promise<unknown>>();
  const reply = (status: number, value: unknown): Reply => ({ status, value });
  const fetch = async (route: string, options: any = {}) => {
    const call: Call = { route, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    let value: unknown;
    if (handlers.has(route)) value = await handlers.get(route)!(call);
    else if (route === "/api/local/state") value = state;
    else if (route === "/api/local/browse") {
      const { root, path } = call.body;
      const directories = path === "pi_projects" ? [{ name: "项目 A", path: "pi_projects/项目 A" }] : [];
      const entries = directories.map((directory) => ({ ...directory, kind: "directory", modifiedAt: 1735689600000 }));
      value = { ...call.body, root, path, directories, entries, total: entries.length, nextOffset: null, truncated: false };
    } else if (route === "/api/local/start") value = run({ workspace: call.body.workspace });
    else if (route === "/api/local/stop") value = run({ id: call.body.id, state: "stopping" });
    else throw new Error(`unexpected API route ${route}`);
    const result = value && typeof value === "object" && "status" in value ? value as Reply : reply(200, value);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => structuredClone(result.value) };
  };
  const location = { origin: "http://local.test", assign: (path: string) => navigations.push(path) };
  const forbiddenStorage = new Proxy({}, { get() { throw new Error("browser persistence must not be needed, especially for CSRF"); } });
  const context = {
    document: { getElementById: get, createElement: (tag: string) => new Element(tag) },
    fetch, location, URL, AbortController,
    window: { location, confirm: (message: string) => { confirmations.push(message); return confirmed; } },
    crypto: { randomUUID() { randomCalls++; return randomCalls === 1 ? uuid : "d5676e0a-1216-44f2-9f30-d0ff8454107a"; } },
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    setTimeout(callback: () => unknown, delay: number) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  runInNewContext(output.script.body, context, { timeout: 1000 });
  await settle();
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const button = (label: string, within?: Element) => {
    const nodes = within ? all(within) : [...elements.values()].flatMap(all);
    const node = nodes.find((item) => item.tagName === "BUTTON" && item.textContent === label);
    assert.ok(node, `missing button with exact label ${label}`);
    return node;
  };
  return {
    output, state, get, calls, navigations, confirmations, handlers, reply, button,
    setConfirm(value: boolean) { confirmed = value; },
    randomCalls: () => randomCalls,
    async poll() {
      const timer = [...timers].find(([, value]) => value.delay < 10000);
      assert.ok(timer, "state polling should be scheduled");
      timers.delete(timer[0]);
      await timer[1].callback();
      await settle();
    },
    async advance(delay: number) {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      timers.delete(timer[0]);
      await timer[1].callback();
      await settle();
    },
  };
}

// Break caught: accidentally serving the privileged manager page/script or caching local authority.
test("local renderers serve a Chinese no-credential page and private revalidated script", async () => {
  const { html, script } = await rendered();
  assert.equal(html.status, 200);
  assert.equal(script.status, 200);
  assert.match(html.headers["Content-Type"], /text\/html.*utf-8/);
  assert.match(script.headers["Content-Type"], /javascript.*utf-8/);
  for (const response of [html, script]) {
    assert.equal(response.headers["Cache-Control"], response === html ? "no-store" : "private, no-cache");
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  }
  assert.match(html.headers["Content-Security-Policy"], /script-src 'self'/);
  assert.match(html.headers["Content-Security-Policy"], /connect-src 'self'/);
  assert.match(html.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(html.body, /lang="zh-CN"/);
  assert.match(html.body, /href="\/sessions\/"[^>]*>本地会话<\/a>/);
  assert.match(html.body, /<script src="\/local.js" defer><\/script>/);
  assert.match(html.body, /<input[^>]+id="local-search"[^>]+type="search"/);
  assert.doesNotMatch(html.body, /<iframe\b|credential|版本目录|独立审批|type="password"/i);
});

// Break caught: dropping enhanced browse defaults, treating files as launchable folders, or losing the selected folder while listing changes.
test("enhanced browse sends defaults, safely renders files, and retains the current folder", async () => {
  const f = await fixture();
  f.handlers.set("/api/local/browse", (call) => ({
    ...call.body,
    directories: [{ name: "子目录", path: "pi_projects/项目 A/子目录" }],
    entries: [
      { name: "子目录", path: "pi_projects/项目 A/子目录", kind: "directory", modifiedAt: 1735689600000 },
      { name: "说明 <b>文件-b>.md", path: "pi_projects/项目 A/说明 <b>文件-b>.md", kind: "file", modifiedAt: 1735776000000 },
    ],
    query: "",
    sort: "name-asc",
    offset: 0,
    total: 2,
    nextOffset: null,
    truncated: false,
  }));
  await f.button("项目 A").fire();
  const browse = f.calls.at(-1)!;
  assert.deepEqual(browse.body, { root: "projects", path: "pi_projects/项目 A", query: "", sort: "name-asc", offset: 0 });
  assert.match(f.get("local-browser-status").textContent, /当前文件夹/);
  const directory = f.get("local-directories").children[0]?.children[0];
  assert.equal(directory?.tagName, "BUTTON");
  assert.equal(directory?.textContent, "子目录");
  const file = f.get("local-directories").children.find(item => item.textContent.includes("说明 <b>文件-b>.md"));
  assert.ok(file, "file entry should be listed as literal text");
  assert.equal(file.children.some(child => child.tagName === "BUTTON"), false, "files must never be navigable controls");
  assert.match(f.get("local-workspace").textContent, /pi_projects\/项目 A/);
  assert.equal(f.get("local-start").disabled, false, "listing a file must not clear the selected folder");
});

// Break caught: issuing a request on every keystroke or allowing an older filtered response to overwrite a newer query.
test("debounced search invalidates older browse responses while preserving the selected folder", async () => {
  const f = await fixture();
  const old = deferred<unknown>();
  f.handlers.set("/api/local/browse", (call) => {
    if (call.body.query === "old") return old.promise;
    return {
      ...call.body, directories: [], entries: [], truncated: false,
      total: 0, nextOffset: null,
    };
  });
  const search = f.get("local-search");
  search.value = "old";
  await search.fire("input");
  assert.equal(f.calls.filter(call => call.route.endsWith("/browse") && call.body?.query === "old").length, 0);
  await f.advance(250);
  assert.equal(f.calls.at(-1)?.body.query, "old");
  search.value = "new";
  await search.fire("input");
  await f.advance(250);
  assert.equal(f.calls.at(-1)?.body.query, "new");
  old.resolve({ root: "projects", path: "pi_projects", directories: [{ name: "过期目录", path: "pi_projects/过期目录" }], entries: [], query: "old", sort: "name-asc", offset: 0, total: 1, nextOffset: null, truncated: false });
  await settle();
  assert.doesNotMatch(f.get("local-directories").textContent, /过期目录/);
  assert.match(f.get("local-workspace").textContent, /pi_projects/);
  assert.equal(f.get("local-start").disabled, false, "filtering does not deselect the current folder");
  assert.match(f.get("local-browser-status").textContent, /没有匹配/);
});

// Break caught: omitting a page cursor or letting list navigation change the workspace selected for launching.
test("enhanced pagination and sort keep the folder selected and use the exact browse cursor", async () => {
  const f = await fixture();
  f.handlers.set("/api/local/browse", (call) => ({
    ...call.body, directories: [], entries: [], truncated: false,
    total: 201, nextOffset: call.body.offset === 0 ? 200 : null,
  }));
  await f.button("项目 A").fire();
  f.get("local-sort").value = "modified-desc";
  await f.get("local-sort").fire("change");
  assert.deepEqual(f.calls.at(-1)?.body, { root: "projects", path: "pi_projects/项目 A", query: "", sort: "modified-desc", offset: 0 });
  await f.get("local-next-page").fire();
  assert.deepEqual(f.calls.at(-1)?.body, { root: "projects", path: "pi_projects/项目 A", query: "", sort: "modified-desc", offset: 200 });
  assert.match(f.get("local-workspace").textContent, /pi_projects\/项目 A/);
  assert.equal(f.get("local-start").disabled, false);
  await f.get("local-prev-page").fire();
  assert.deepEqual(f.calls.at(-1)?.body, { root: "projects", path: "pi_projects/项目 A", query: "", sort: "modified-desc", offset: 0 });
});

// Break caught: selecting a browser root instead of the server's saved default folder.
test("server default is selected automatically and normal refresh keeps that default without storage", async () => {
  const f = await fixture();
  assert.match(f.get("local-workspace").textContent, /pi_projects/);
  assert.equal(f.get("local-start").disabled, false);
  assert.deepEqual(f.calls.find((call) => call.route.endsWith("/browse"))?.body, { ...workspace, query: "", sort: "name-asc", offset: 0 });
  await f.button("项目 A").fire();
  assert.match(f.get("local-workspace").textContent, /pi_projects\/项目 A/);
  assert.equal(f.get("local-start").disabled, false);
  f.state.defaultWorkspace = { root: "projects", path: "pi_projects/项目 A" };
  const refreshed = await fixture(f.state);
  assert.match(refreshed.get("local-workspace").textContent, /pi_projects\/项目 A/);
  assert.deepEqual(refreshed.navigations, []);
});

// Break caught: forgetting the CSRF header or sending client-generated instance IDs/credentials.
test("start sends only a UUID key and selected workspace with an in-memory CSRF header", async () => {
  const f = await fixture();
  await f.get("local-start").fire();
  const start = f.calls.find((call) => call.route.endsWith("/start"));
  assert.ok(start);
  assert.equal(start.method, "POST");
  assert.deepEqual(start.body, { key: uuid, workspace });
  for (const call of f.calls.filter((item) => item.method === "POST")) {
    assert.equal(call.headers["X-Pi-Local-Csrf"], "internal-csrf-not-for-display");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.equal(Object.keys(call.headers).some((name) => /authorization|token/i.test(name)), false);
  }
  assert.equal(f.get("local-start").disabled, true);
  assert.match(f.get("local-status").textContent, /启动|等待/);
  assert.deepEqual(f.navigations, []);
  assert.doesNotMatch([...f.get("local-runs").children].map((node) => node.textContent).join(""), /internal-csrf/);
});

// Break caught: redirecting to any ready historical run or guessing a run by workspace after a lost reply.
test("poll redirects only to the matching newly started ready run", async () => {
  const state = initialState();
  state.runs = [run({ id: "old-run", state: "ready", path: "/s/old-run/" })];
  const f = await fixture(state);
  await f.poll();
  assert.deepEqual(f.navigations, []);
  await f.get("local-start").fire();
  f.state.runs.push(run({ state: "starting", path: "/s/new-run/" }));
  await f.poll();
  assert.deepEqual(f.navigations, []);
  f.state.runs[1].state = "ready";
  await f.poll();
  assert.deepEqual(f.navigations, ["/s/new-run/"]);
  await f.poll();
  assert.deepEqual(f.navigations, ["/s/new-run/"], "one navigation even if unload is delayed");
  const newTab = await fixture(state);
  await newTab.poll();
  assert.deepEqual(newTab.navigations, [], "fresh tabs must not inherit automatic navigation");
});

test("an immediately ready start response enters only its own session", async () => {
  const f = await fixture();
  f.handlers.set("/api/local/start", () => run({ state: "ready", path: "/s/new-run/" }));
  await f.get("local-start").fire();
  assert.deepEqual(f.navigations, ["/s/new-run/"]);
});

// Break caught: generating another idempotency key, losing the original workspace, or premature reconciliation.
test("lost start reply retains exact key/workspace and does not auto-open a historical match", async () => {
  const f = await fixture();
  f.handlers.set("/api/local/start", () => { throw new TypeError("network lost"); });
  await f.get("local-start").fire();
  assert.match(f.get("local-status").textContent, /重试|未确认/);
  assert.equal(f.get("local-start").disabled, false);
  assert.equal(f.get("local-root").disabled, true);
  f.state.runs = [run({ state: "ready", path: "/s/new-run/" })];
  await f.poll();
  assert.deepEqual(f.navigations, []);
  f.handlers.set("/api/local/start", () => run({ state: "ready", path: "/s/new-run/" }));
  await f.get("local-start").fire();
  const starts = f.calls.filter((call) => call.route.endsWith("/start"));
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].body, { key: uuid, workspace });
  assert.deepEqual(starts[1].body, starts[0].body);
  assert.equal(f.randomCalls(), 1);
  assert.deepEqual(f.navigations, ["/s/new-run/"]);
});

test("double click cannot submit a second start while the first reply is pending", async () => {
  const f = await fixture();
  const hold = deferred<Run>();
  f.handlers.set("/api/local/start", () => hold.promise);
  const first = f.get("local-start").fire();
  await settle();
  assert.equal(f.get("local-start").disabled, true);
  await f.get("local-start").fire();
  hold.resolve(run());
  await first;
  assert.equal(f.calls.filter((call) => call.route.endsWith("/start")).length, 1);
});

// Break caught: allowing starts before folder validation or using stale/out-of-order browse results.
test("browse blocks start until validated and ignores a late result from an older root", async () => {
  const f = await fixture();
  const hold = deferred<unknown>();
  f.handlers.set("/api/local/browse", (call) => {
    if (call.body.root === "projects") return hold.promise;
    const directories = call.body.path === "" ? [{ name: "scratch-project", path: "scratch-project" }] : [];
    const entries = directories.map((directory) => ({ ...directory, kind: "directory", modifiedAt: 1735689600000 }));
    return { ...call.body, directories, entries, total: entries.length, nextOffset: null, truncated: false };
  });
  const oldNavigation = f.button("项目 A").fire();
  await settle();
  assert.equal(f.get("local-start").disabled, true);
  await f.get("local-start").fire();
  assert.equal(f.calls.filter((call) => call.route.endsWith("/start")).length, 0);
  f.get("local-root").value = "scratch";
  await f.get("local-root").fire("change");
  hold.resolve({ root: "projects", path: "pi_projects/项目 A", directories: [], entries: [], query: "", sort: "name-asc", offset: 0, total: 0, nextOffset: null, truncated: false });
  await oldNavigation;
  assert.equal(f.get("local-root").value, "scratch");
  assert.equal(f.get("local-start").disabled, true, "roots are browse-only");
  await f.button("scratch-project").fire();
  await f.get("local-start").fire();
  assert.deepEqual(f.calls.find((call) => call.route.endsWith("/start"))?.body.workspace, { root: "scratch", path: "scratch-project" });
});

test("parent/root navigation selects the exact folder and cannot navigate above the root", async () => {
  const f = await fixture();
  await f.button("项目 A").fire();
  await f.get("local-parent").fire();
  assert.deepEqual(f.calls.at(-1)?.body, { ...workspace, query: "", sort: "name-asc", offset: 0 });
  await f.get("local-home").fire();
  assert.deepEqual(f.calls.at(-1)?.body, { root: "projects", path: "", query: "", sort: "name-asc", offset: 0 });
  assert.equal(f.get("local-parent").disabled, true);
  assert.equal(f.get("local-start").disabled, true);
  assert.match(f.get("local-browser-status").textContent, /根目录.*浏览|进入.*子文件夹/);
  const count = f.calls.length;
  await f.get("local-parent").fire();
  assert.equal(f.calls.length, count);
});

test("browse errors stay visible, block start, and offer a retry without resetting to another folder", async () => {
  const f = await fixture();
  f.handlers.set("/api/local/browse", () => f.reply(403, { error: "目录不可访问" }));
  await f.button("项目 A").fire();
  assert.match(f.get("local-browser-status").textContent, /目录不可访问/);
  assert.equal(f.get("local-start").disabled, true);
  await f.poll();
  assert.match(f.get("local-browser-status").textContent, /目录不可访问/);
  f.handlers.set("/api/local/browse", (call) => ({ ...call.body, directories: [], entries: [], total: 0, nextOffset: null, truncated: false }));
  await f.get("local-browse-retry").fire();
  assert.equal(f.get("local-start").disabled, false);
  assert.deepEqual(f.calls.at(-1)?.body, { root: "projects", path: "pi_projects/项目 A", query: "", sort: "name-asc", offset: 0 });
});

for (const page of [
  { root: "scratch", path: "pi_projects/项目 A", directories: [], entries: [], query: "", sort: "name-asc", offset: 0, total: 0, nextOffset: null, truncated: false },
  { root: "projects", path: "pi_projects/项目 A", directories: [{ name: "escape", path: "../outside" }], entries: [{ name: "escape", path: "../outside", kind: "directory", modifiedAt: 1735689600000 }], query: "", sort: "name-asc", offset: 0, total: 1, nextOffset: null, truncated: false },
]) {
  test(`mismatched or escaping browse response never selects a workspace: ${JSON.stringify(page)}`, async () => {
    const f = await fixture();
    f.handlers.set("/api/local/browse", () => page);
    await f.button("项目 A").fire();
    assert.equal(f.get("local-start").disabled, true);
    assert.match(f.get("local-browser-status").textContent, /无效|不匹配/);
  });
}

test("folder labels and server errors are literal text; pagination is explained", async () => {
  const f = await fixture();
  const name = '<img src=x onerror="injected=true">';
  f.handlers.set("/api/local/browse", (call) => ({
    ...call.body, directories: [{ name, path: `${call.body.path}/${name}` }],
    entries: [{ name, path: `${call.body.path}/${name}`, kind: "directory", modifiedAt: 1735689600000 }], total: 1, nextOffset: null, truncated: true,
  }));
  await f.button("项目 A").fire();
  assert.equal(f.button(name).textContent, name);
  assert.match(f.output.html.body, /结果已分页显示。可使用上一页和下一页浏览更多文件夹和文件。/);
  f.handlers.set("/api/local/start", () => f.reply(400, { error: "<script>failed</script>" }));
  await f.get("local-start").fire();
  assert.match(f.get("local-status").textContent, /<script>failed<\/script>/);
});

// Break caught: treating terminal failure as permanent busy state or hiding the backend's actionable reason.
test("matching run failure explains the error and enables a genuinely new attempt", async () => {
  const f = await fixture();
  await f.get("local-start").fire();
  f.state.runs = [run({ state: "failed", error: "pirun 启动失败：工作区不存在" })];
  await f.poll();
  assert.match(f.get("local-status").textContent, /工作区不存在/);
  assert.match(f.get("local-status").textContent, /本地服务状态/);
  assert.match(f.get("local-status").textContent, /确认/);
  assert.equal(f.get("local-start").disabled, false);
  assert.deepEqual(f.navigations, []);
  await f.get("local-start").fire();
  assert.equal(f.randomCalls(), 2);
});

test("unknown launch requires inspection and polling, never a blind new start", async () => {
  const f = await fixture();
  await f.get("local-start").fire();
  f.state.runs = [run({ state: "unknown", error: "进程状态未确认" })];
  await f.poll();
  assert.match(f.get("local-status").textContent, /本地服务状态/);
  assert.match(f.get("local-status").textContent, /刷新|重试/);
  assert.equal(f.get("local-start").disabled, true);
  await f.get("local-start").fire();
  assert.equal(f.calls.filter((call) => call.route.endsWith("/start")).length, 1);
  assert.equal(f.randomCalls(), 1);
  assert.deepEqual(f.navigations, []);
});

test("unavailable initial state does not browse or start until explicit refresh succeeds", async () => {
  const state = initialState();
  state.csrfToken = "";
  const f = await fixture(state);
  assert.equal(f.get("local-start").disabled, true);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  assert.match(f.get("local-status").textContent, /刷新|重试/);
  f.state.csrfToken = "valid-new-csrf";
  await f.get("local-refresh").fire();
  assert.equal(f.get("local-start").disabled, false);
  assert.deepEqual(f.calls.at(-1)?.body, { ...workspace, query: "", sort: "name-asc", offset: 0 });
});

test("poll failure preserves launch intent, then recovers using fresh in-memory CSRF", async () => {
  const f = await fixture();
  await f.get("local-start").fire();
  f.handlers.set("/api/local/state", () => { throw new Error("offline"); });
  await f.poll();
  assert.match(f.get("local-status").textContent, /连接|刷新|重试/);
  assert.deepEqual(f.navigations, []);
  f.handlers.delete("/api/local/state");
  f.state.csrfToken = "rotated-csrf";
  f.state.runs = [run({ state: "ready", path: "/s/new-run/" })];
  await f.poll();
  assert.deepEqual(f.navigations, ["/s/new-run/"]);
  await f.button("停止").fire();
  assert.equal(f.calls.at(-1)?.headers["X-Pi-Local-Csrf"], "rotated-csrf");
});

test("successful idle refresh clears a stale connection error without changing the selected folder", async () => {
  const f = await fixture();
  await f.button("项目 A").fire();
  f.handlers.set("/api/local/state", () => { throw new Error("offline"); });
  await f.poll();
  assert.equal(f.get("local-start").disabled, true);
  assert.match(f.get("local-status").textContent, /无法刷新/);
  f.handlers.delete("/api/local/state");
  await f.poll();
  assert.equal(f.get("local-start").disabled, false);
  assert.doesNotMatch(f.get("local-status").textContent, /无法刷新/);
  assert.match(f.get("local-workspace").textContent, /pi_projects\/项目 A/);
});

// Break caught: destructive stop without confirmation, sending a workspace instead of the exact instance ID.
test("existing runs open explicitly and stop requires confirmation for that exact run", async () => {
  const state = initialState();
  state.runs = [run({ id: "old-run", state: "ready", path: "/s/old-run/" }), run({ id: "dead-run", state: "stopped" })];
  const f = await fixture(state);
  assert.match(f.get("local-runs").textContent, /old-run/);
  assert.doesNotMatch(f.get("local-runs").textContent, /dead-run|已停止/);
  await f.button("打开").fire();
  assert.deepEqual(f.navigations, ["/s/old-run/"]);
  f.setConfirm(false);
  await f.button("停止").fire();
  assert.equal(f.calls.filter((call) => call.route.endsWith("/stop")).length, 0);
  f.setConfirm(true);
  await f.button("停止").fire();
  assert.match(f.confirmations.at(-1)!, /old-run/);
  assert.deepEqual(f.calls.at(-1)?.body, { id: "old-run" });
  assert.equal(f.calls.at(-1)?.headers["X-Pi-Local-Csrf"], "internal-csrf-not-for-display");
  assert.match(f.get("local-runs").textContent, /正在停止/);
});

// Break caught: exposing a stop control for an unmanaged terminal, duplicating a managed path, or retaining vanished terminal sessions.
test("validated terminal sessions are deduplicated, open-only, and reconcile on polling", async () => {
  const state = initialState();
  state.runs = [run({ id: "web-run", state: "ready", path: "/s/web-run/" })];
  state.sessions = [
    { label: "duplicate terminal", generation: "gen-1", path: "/s/web-run/", since: 1735689600000 },
    { label: "终端会话", sessionName: null, generation: "gen-2", path: "/s/terminal-run/", since: 1735776000000 },
    { label: "invalid terminal", generation: "gen-3", path: "/s/terminal-run/?secret", since: 1735776000000 },
  ];
  const f = await fixture(state);
  const cards = f.get("local-runs").children;
  assert.equal(cards.filter(card => card.textContent.includes("web-run")).length, 1);
  assert.match(cards.find(card => card.textContent.includes("web-run"))!.textContent, /网页启动/);
  assert.equal(cards.filter(card => card.textContent.includes("duplicate terminal")).length, 0);
  assert.equal(cards.filter(card => card.textContent.includes("invalid terminal")).length, 0);
  const terminal = cards.find(card => card.textContent.includes("终端会话"));
  assert.ok(terminal, "validated terminal session should be shown");
  assert.match(terminal.textContent, /终端启动/);
  assert.match(terminal.textContent, /打开/);
  assert.doesNotMatch(terminal.textContent, /停止/, "terminal cards are never stop-capable");
  await f.button("打开", terminal).fire();
  assert.deepEqual(f.navigations, ["/s/terminal-run/"]);
  state.sessions = [];
  await f.poll();
  assert.doesNotMatch(f.get("local-runs").textContent, /终端会话/);
  assert.match(f.get("local-runs").textContent, /web-run/);
});

test("stopped history shows an empty instance list without deleting the stored response", async () => {
  const state = initialState();
  state.runs = [run({ id: "stopped-history", state: "stopped" })];
  const f = await fixture(state);
  assert.doesNotMatch(f.get("local-runs").textContent, /stopped-history/);
  assert.match(f.get("local-runs").textContent, /暂无.*实例/);
  await f.poll();
  assert.doesNotMatch(f.get("local-runs").textContent, /stopped-history/);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].state, "stopped");
  assert.equal(f.calls.some(call => /delete|remove|clear/.test(call.route)), false);
});

test("only confirmed stopped cards disappear while failures and uncertain instances stay visible", async () => {
  const state = initialState();
  state.runs = [
    run({ id: "gone", state: "stopped" }),
    run({ id: "idle-ready", state: "ready", path: "/s/idle-ready/" }),
    run({ id: "still-starting", state: "starting" }),
    run({ id: "still-stopping", state: "stopping" }),
    run({ id: "needs-inspection", state: "unknown", error: "待核对容器" }),
    run({ id: "needs-repair", state: "failed", error: "启动失败原因" }),
  ];
  const f = await fixture(state);
  assert.deepEqual(f.get("local-runs").children.map(item => item.children[0].textContent),
    ["idle-ready", "still-starting", "still-stopping", "needs-inspection", "needs-repair"]);
  assert.match(f.get("local-runs").textContent, /待核对容器|启动失败原因/);
  await f.poll();
  assert.equal(f.get("local-runs").children.length, 5, "idle ready instances are not treated as finished");
});

test("stopping stays visible until polling confirms stopped, then only that instance disappears", async () => {
  const state = initialState();
  state.runs = [run({ id: "selected-run", state: "ready", path: "/s/selected-run/" }),
    run({ id: "other-run", state: "ready", path: "/s/other-run/" })];
  const f = await fixture(state);
  await f.button("停止", f.get("local-runs").children[0]).fire();
  assert.match(f.get("local-runs").textContent, /selected-run.*正在停止/);
  state.runs[0].state = "stopped";
  delete state.runs[0].path;
  await f.poll();
  assert.doesNotMatch(f.get("local-runs").textContent, /selected-run/);
  assert.match(f.get("local-runs").textContent, /other-run/);
  assert.deepEqual(f.calls.filter(call => call.route.endsWith("/stop")).map(call => call.body), [{ id: "selected-run" }]);
});

test("an immediately confirmed stop hides its card without waiting for polling", async () => {
  const state = initialState();
  state.runs = [run({ state: "ready", path: "/s/new-run/" })];
  const f = await fixture(state);
  f.handlers.set("/api/local/stop", call => run({ id: call.body.id, state: "stopped" }));
  await f.button("停止").fire();
  assert.doesNotMatch(f.get("local-runs").textContent, /new-run/);
  assert.match(f.get("local-status").textContent, /已停止/);
  assert.match(f.get("local-runs").textContent, /暂无.*实例/);
});

test("a newly started run stopped before navigation clears pending start even though its card is hidden", async () => {
  const f = await fixture();
  await f.get("local-start").fire();
  f.state.runs = [run({ state: "stopped" })];
  await f.poll();
  assert.doesNotMatch(f.get("local-runs").textContent, /new-run/);
  assert.match(f.get("local-status").textContent, /已停止/);
  assert.equal(f.get("local-start").disabled, false);
  assert.deepEqual(f.navigations, []);
  await f.get("local-start").fire();
  assert.equal(f.randomCalls(), 2);
});

for (const path of ["https://evil.test/s/session/", "//evil.test/s/session/", "/sessions/", "/s/../admin/", "/s/%2e%2e/", "/s/new-run/?token=secret", "/s/new-run/\\evil"]) {
  test(`unsafe session path is never opened: ${path}`, async () => {
    const f = await fixture();
    f.handlers.set("/api/local/start", () => run({ state: "ready", path }));
    await f.get("local-start").fire();
    assert.deepEqual(f.navigations, []);
    assert.match(f.get("local-status").textContent, /会话|地址/);
  });
}

test("local Chromium verifies real DOM, CSP, mobile layout and matching-run redirect (opt-in)", {
  skip: !process.env.PI_LOCAL_UI_TEST_BROWSER,
}, async (t) => {
  const { chromium } = await import("@playwright/test");
  const output = await rendered();
  const state = initialState();
  state.runs = [run({ id: "historical", state: "ready", path: "/s/historical/" })];
  const calls: Call[] = [];
  let startAttempts = 0;
  const browser = await chromium.launch({ executablePath: process.env.PI_LOCAL_UI_TEST_BROWSER, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://localhost") return route.abort();
    if (url.pathname === "/") return route.fulfill({ status: output.html.status, headers: output.html.headers, body: output.html.body });
    if (url.pathname === "/local.js") return route.fulfill({ status: output.script.status, headers: output.script.headers, body: output.script.body });
    const body = request.postDataJSON() as any;
    calls.push({ route: url.pathname, method: request.method(), headers: request.headers(), body });
    let value: unknown;
    if (url.pathname === "/api/local/state") value = state;
    else if (url.pathname === "/api/local/browse") {
      const allEntries = body.path === "pi_projects" ? [
        { name: "中文 项目", path: "pi_projects/中文 项目", kind: "directory", modifiedAt: 1735776000000 },
        { name: "README.md", path: "pi_projects/README.md", kind: "file", modifiedAt: 1735689600000 },
      ] : [];
      const entries = body.query ? allEntries.filter((entry) => entry.name.toLowerCase().includes(body.query.toLowerCase())) : allEntries;
      value = { ...body, directories: entries.filter((entry) => entry.kind === "directory"), entries, total: entries.length, nextOffset: null, truncated: false };
    }
    else if (url.pathname === "/api/local/start") {
      startAttempts++;
      if (startAttempts === 1) {
        state.defaultWorkspace = body.workspace;
        state.runs.push(run({ workspace: body.workspace }));
        return route.abort("connectionfailed"); // Created, but its reply was lost.
      }
      value = state.runs[1];
    } else if (url.pathname === "/api/local/stop") {
      assert.deepEqual(body, { id: "historical" });
      state.runs[0] = run({ id: "historical", state: "stopping" });
      value = state.runs[0];
    } else if (url.pathname.startsWith("/s/")) return route.fulfill({ contentType: "text/html", body: "<h1>Session fixture</h1>" });
    else return route.abort();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://localhost/");
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  assert.equal(page.url(), "http://localhost/");
  assert.equal(await page.locator('input[type="search"]#local-search').count(), 1);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByRole("link", { name: "本地会话" }).getAttribute("href"), "/sessions/");
  assert.equal(await page.getByRole("button", { name: "README.md", exact: true }).count(), 0, "files are not folder controls");
  const initialWorkspace = await page.locator("#local-workspace").innerText();
  await page.locator("#local-directories li", { hasText: "README.md" }).click();
  assert.equal(await page.locator("#local-workspace").innerText(), initialWorkspace, "choosing a file never changes the workspace");
  const searched = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/local/browse") return false;
    const body = request.postDataJSON() as any;
    return body.query === "readme" && body.sort === "name-asc" && body.offset === 0;
  });
  await page.locator("#local-search").fill("readme");
  await searched;
  await page.waitForFunction(() => document.getElementById("local-browser-status")?.textContent?.includes("当前文件夹"));
  assert.match(await page.locator("#local-directories").innerText(), /README\.md/);
  const sorted = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/local/browse") return false;
    const body = request.postDataJSON() as any;
    return body.query === "readme" && body.sort === "modified-desc" && body.offset === 0;
  });
  await page.locator("#local-sort").selectOption("modified-desc");
  await sorted;
  const cleared = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/local/browse") return false;
    const body = request.postDataJSON() as any;
    return body.query === "" && body.sort === "modified-desc" && body.offset === 0;
  });
  await page.locator("#local-search-clear").click();
  await cleared;
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "停止", exact: true }).click();
  assert.equal(calls.filter((call) => call.route.endsWith("/stop")).length, 0);
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /historical/);
    await dialog.accept();
  });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("local-runs")?.textContent?.includes("正在停止"));
  assert.equal(calls.filter((call) => call.route.endsWith("/stop")).length, 1);
  state.runs[0].state = "stopped";
  await page.locator("#local-refresh").click();
  await page.waitForFunction(() => !document.getElementById("local-runs")?.textContent?.includes("historical"));
  assert.match((await page.locator("#local-runs").innerText()), /暂无.*实例/);
  await page.reload();
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  assert.equal(await page.getByRole("button", { name: "停止", exact: true }).count(), 0);
  await page.getByRole("button", { name: "中文 项目", exact: true }).click();
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#local-start").isVisible(), true);
  }
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /internal-csrf-not-for-display/);
  await page.locator("#local-start").click();
  await page.waitForFunction(() => document.getElementById("local-status")?.textContent?.includes("未确认"));
  await page.locator("#local-refresh").click();
  await page.waitForFunction(() => document.getElementById("local-runs")?.textContent?.includes("new-run"));
  assert.equal(page.url(), "http://localhost/");
  await page.locator("#local-start").click();
  await page.waitForFunction(() => document.getElementById("local-status")?.textContent?.includes("正在启动"));
  assert.equal(page.url(), "http://localhost/");
  state.runs[1] = run({ workspace: { root: "projects", path: "pi_projects/中文 项目" }, state: "ready", path: "/s/new-run/" });
  await page.waitForURL("http://localhost/s/new-run/");
  const start = calls.find((call) => call.route === "/api/local/start");
  assert.deepEqual(start?.body.workspace, { root: "projects", path: "pi_projects/中文 项目" });
  assert.match(start?.body.key, /^[0-9a-f-]{36}$/);
  assert.equal(start?.headers["x-pi-local-csrf"], "internal-csrf-not-for-display");
  assert.deepEqual(calls.filter((call) => call.route.endsWith("/start")).map((call) => call.body), [start?.body, start?.body]);
  const freshTab = await context.newPage();
  await freshTab.goto("http://localhost/");
  await freshTab.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  assert.equal(freshTab.url(), "http://localhost/");
  assert.match((await freshTab.locator("#local-workspace").textContent())!, /pi_projects\/中文 项目/);
  assert.deepEqual(errors, []);
});

test("Chromium drives the real temporary local service: root guard, Chinese 400, launch failure and refresh", {
  skip: !process.env.PI_LOCAL_UI_TEST_BROWSER,
  timeout: 30000,
}, async (t) => {
  const { mkdir, mkdtemp, rm, rmdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { chromium } = await import("@playwright/test");
  const { startLocalService } = await import("../manager/local-service.ts");
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-local-browser-"));
  let service: Awaited<ReturnType<typeof startLocalService>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await service?.close(); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  });
  const home = path.join(temporary, "home");
  const projects = path.join(home, "gitproject");
  const defaultPath = path.join(projects, "pi_projects");
  const folderName = "中文 项目 " + "很长的目录".repeat(6);
  const childPath = path.join(defaultPath, folderName);
  await mkdir(childPath, { recursive: true });
  await mkdir(path.join(projects, "private"));
  await mkdir(path.join(temporary, "bin"));
  const launcher = path.join(temporary, "bin", "isolated-launcher");
  const docker = path.join(temporary, "bin", "isolated-docker");
  // Exercise the actual service/launcher process boundary without invoking pirun or Docker.
  await writeFile(launcher, "#!/bin/sh\nprintf 'fixture-private-output' >&2\nexit 7\n", { mode: 0o700 });
  await writeFile(docker, '#!/bin/sh\necho "Error: No such container: $2" >&2\nexit 1\n', { mode: 0o700 });
  service = await startLocalService({
    port: 0, chatPort: 0, home, workspaceRoots: { projects },
    defaultWorkspace: { root: "projects", path: "pi_projects" }, stateRoot: path.join(temporary, "state"),
    launcher, dockerExecutable: docker, hubCli: path.join(temporary, "unused-hub.mjs"),
    protectedRoots: [path.join(projects, "private")],
  });
  const origin = new URL(service.url).origin;
  browser = await chromium.launch({ executablePath: process.env.PI_LOCAL_UI_TEST_BROWSER, headless: true });
  const context = await browser.newContext();
  // All allowed requests really reach the temporary service. No API response is mocked here.
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  const starts: any[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/local/start") starts.push(request.postDataJSON());
  });
  await page.goto(service.url);
  await page.locator('#auth-username:not([disabled])').waitFor();
  await page.locator('#auth-username').fill('browser-user');
  await page.locator('#auth-password').fill('browser-test-password');
  await page.locator('#auth-submit').click();
  await page.waitForURL(service.url);
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  assert.match((await page.locator("#local-workspace").textContent())!, /pi_projects/);
  await page.getByRole("button", { name: "根目录", exact: true }).click();
  await page.getByRole("button", { name: "pi_projects", exact: true }).waitFor();
  assert.equal(await page.locator("#local-start").isDisabled(), true);
  assert.match((await page.locator("#local-browser-status").textContent())!, /根目录仅用于浏览/);
  assert.equal(await page.getByRole("button", { name: "private", exact: true }).count(), 0);
  assert.equal(starts.length, 0);
  await page.getByRole("button", { name: "pi_projects", exact: true }).click();
  await page.getByRole("button", { name: folderName, exact: true }).click();
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#local-start").isVisible(), true);
  }
  // Directory removal after browsing must be reported as the real server's safe Chinese 400.
  await rmdir(childPath);
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/local/start");
  await page.locator("#local-start").click();
  assert.equal((await rejected).status(), 400);
  await page.waitForFunction(() => document.getElementById("local-status")?.textContent?.includes("目录或请求无效"));
  assert.equal(await page.locator("#local-root").isDisabled(), false);
  await mkdir(childPath);
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/local/start");
  await page.locator("#local-start").click();
  const response = await accepted;
  assert.equal(response.status(), 202);
  const created = await response.json();
  assert.match(created.id, /^pi-local-[a-f0-9]{24}$/);
  // Confirmed absent containers leave the runtime list, including failed starts.
  // The pending request must still reconcile and unlock the next explicit start.
  await page.waitForFunction(() => document.getElementById("local-status")?.textContent?.includes("已停止"));
  assert.doesNotMatch((await page.locator("#local-runs").textContent())!, new RegExp(created.id));
  assert.equal(await page.locator("#local-start").isDisabled(), false);
  assert.match((await page.locator("#local-status").textContent())!, /本地服务状态/);
  assert.equal(page.url(), service.url, "failure must not enter a session or auto-restart");
  assert.equal(starts.length, 2, "one rejected request and one explicit accepted request");
  assert.notEqual(starts[0].key, starts[1].key, "a definitive 400 allows a corrected new attempt");
  assert.deepEqual(starts[1].workspace, { root: "projects", path: `pi_projects/${folderName}` });
  assert.doesNotMatch(await page.locator("body").innerText(), /fixture-private-output/);
  await page.getByRole("link", { name: "本地会话", exact: true }).click();
  await page.waitForURL(service.url);
  await page.waitForFunction(() => !(document.getElementById("local-start") as HTMLButtonElement).disabled);
  assert.match((await page.locator("#local-workspace").textContent())!, /pi_projects/);
  assert.equal(starts.length, 2, "refreshing the list never starts anything");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
});

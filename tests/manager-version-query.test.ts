import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import type { ExecutorConfig } from "../manager/config.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";
import type { TaskBackendAdapter } from "../manager/executor/adapter.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { TaskEngine } from "../manager/executor/engine.ts";
import { browserScript, renderPage } from "../manager/ui.ts";
import { PI_PACKAGE, ReleaseCatalog } from "../manager/updates/catalog.ts";

const requester = "synthetic-version-requester-00000001";
const administrator = "synthetic-version-administrator-0001";
const future = "2099.10.27";
const registry = "https://registry.npmjs.org/";
const integrity = `sha512-${createHash("sha512").update("version-query").digest("base64")}`;

function release(version: string) {
  return { name: PI_PACKAGE, version, engines: { node: ">=22.19.0" }, dist: {
    tarball: `${registry}@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz`, integrity,
  } };
}
function response(url: string, versions = [future, "10.0.0", "3.0.0"]) {
  return { url, statusCode: 200, headers: {}, body: (async function* () {
    yield Buffer.from(JSON.stringify({ name: PI_PACKAGE, versions: Object.fromEntries(versions.map(v => [v, release(v)])) }));
  })() };
}
function adapter(): TaskBackendAdapter {
  return { policy: {}, actions: ["create"], validate: async () => {}, execute: async () => ({ status: "created" }), resources: () => [], close: async () => {} };
}
async function engineFixture(t: any, catalog: ReleaseCatalog) {
  const root = await mkdtemp(path.join(tmpdir(), "manager-version-query-"));
  const config: ExecutorConfig = {
    stateRoot: path.join(root, "tasks"), submitSocket: path.join(root, "submit", "rpc.sock"), adminSocket: path.join(root, "admin", "rpc.sock"),
    native: null, trustedLocalNative: false,
    workspaces: { project: { label: "Synthetic project", root: "work", path: "project" } },
    principals: [
      { id: "agent", role: "submitter", tokenHash: createHash("sha256").update(requester).digest("hex") },
      { id: "admin", role: "admin", tokenHash: createHash("sha256").update(administrator).digest("hex") },
    ],
  };
  const engine = await TaskEngine.open(config, adapter(), { catalog });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return engine;
}

test("real engine authenticates fixed-package version reads and rejects malformed options before official transport", async t => {
  let calls = 0;
  const catalog = new ReleaseCatalog({ metadataDeadlineMs: 2500, transport: async ({ url, timeoutMs }) => {
    calls++; assert.equal(url, `${registry}${encodeURIComponent(PI_PACKAGE)}`); assert.equal(timeoutMs, 2500); return response(url);
  } });
  const engine = await engineFixture(t, catalog);
  for (const [transport, credential, status] of [
    ["submit", "wrong-credential-0000000000000000", 401],
    ["submit", administrator, 403],
    ["admin", requester, 403],
  ] as const) {
    await assert.rejects(engine.dispatch(transport, credential, { op: "versions", options: {} }), { status });
  }
  for (const options of [
    { registry: "https://evil.invalid" }, { package: "evil" }, { transport: "fetch" }, { timeout: 1 },
    { query: "1-beta" }, { query: 1 }, { cursor: "bad+cursor" }, { cursor: 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
  ]) await assert.rejects(engine.dispatch("submit", requester, { op: "versions", options }), { status: 400 });
  assert.equal(calls, 0);

  const first = await engine.dispatch("submit", requester, { op: "versions", options: { query: "", limit: 2 } }) as any;
  assert.deepEqual(first.versions, [future, "10.0.0"]); assert.equal(first.status, "fresh"); assert.ok(first.nextCursor);
  const second = await engine.dispatch("admin", administrator, { op: "versions", options: { cursor: first.nextCursor, limit: 2 } }) as any;
  assert.deepEqual(second.versions, ["3.0.0"]); assert.equal(calls, 1);
  assert.deepEqual(await engine.dispatch("submit", requester, { op: "list" }), []);
  assert.equal((await engine.dispatch("submit", requester, { op: "capabilities" }) as any).updates, false);
});

test("pending coalesced catalog reads stay outside mutation work and outstanding reads are bounded", async t => {
  let releaseTransport!: () => void;
  let started!: () => void;
  const transportStarted = new Promise<void>(resolve => { started = resolve; });
  const transportGate = new Promise<void>(resolve => { releaseTransport = resolve; });
  let calls = 0;
  const catalog = new ReleaseCatalog({ metadataDeadlineMs: 2500, transport: async ({ url }) => {
    calls++; started(); await transportGate; return response(url, [future]);
  } });
  const engine = await engineFixture(t, catalog);
  const message: any = { op: "versions", options: { query: "2099", limit: 1 } };
  const reads = Array.from({ length: 16 }, () => engine.dispatch("submit", requester, message));
  message.options.query = "invalid-after-dispatch";
  await transportStarted;
  await assert.rejects(engine.dispatch("submit", requester, { op: "versions", options: {} }), { status: 503 });

  const listed = await engine.dispatch("submit", requester, { op: "list" });
  assert.deepEqual(listed, []);
  const submitted = await engine.dispatch("submit", requester, { op: "submit", request: { key: "one", action: "create", target: "sample", workspace: "project" } }) as any;
  const review = await engine.dispatch("admin", administrator, { op: "review", taskId: submitted.id }) as any;
  assert.equal(submitted.state, "pending_approval"); assert.equal(review.task.id, submitted.id);
  assert.equal(calls, 1);

  releaseTransport();
  const pages = await Promise.all(reads) as any[];
  assert.ok(pages.every(page => page.versions[0] === future));
  assert.equal((await engine.dispatch("submit", requester, { op: "list" }) as any[]).length, 1);
});

test("executor and administrator clients inherit the same exact versions RPC without package or transport authority", async () => {
  class CapturingClient extends ExecutorClient {
    messages: unknown[] = [];
    protected override call(message: unknown): Promise<any> { this.messages.push(structuredClone(message)); return Promise.resolve({ status: "fresh", versions: [] }); }
  }
  class CapturingAdminClient extends AdminClient {
    messages: unknown[] = [];
    protected override call(message: unknown): Promise<any> { this.messages.push(structuredClone(message)); return Promise.resolve({ status: "fresh", versions: [] }); }
  }
  const submit = new CapturingClient({ socketPath: "/unused-submit", credential: requester });
  const admin = new CapturingAdminClient({ socketPath: "/unused-admin", credential: administrator });
  await submit.versions({ query: "20", limit: 25 });
  await admin.versions({ cursor: "abc", limit: 10 });
  assert.deepEqual(submit.messages, [{ op: "versions", options: { query: "20", limit: 25 } }]);
  assert.deepEqual(admin.messages, [{ op: "versions", options: { cursor: "abc", limit: 10 } }]);
});

test("public/admin HTTP and MCP source wire only authenticated read-only version requests", async () => {
  const [publicSource, adminSource, mcpSource] = await Promise.all([
    readFile(new URL("../manager/service.ts", import.meta.url), "utf8"),
    readFile(new URL("../manager/admin-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../manager/mcp/server.ts", import.meta.url), "utf8"),
  ]);
  assert.match(publicSource, /POST[^\n]+\/api\/manager\/versions[^\n]+client\.versions\(await jsonBody\(req\)/);
  assert.match(adminSource, /\/api\/manager\/versions[^\n]+client\.versions\(body/);
  assert.match(mcpSource, /manager_list_pi_versions/);
  assert.match(mcpSource, /manager_list_pi_versions[\s\S]+readOnlyHint:\s*true/);
  assert.doesNotMatch(publicSource, /updates:\s*true/); assert.doesNotMatch(adminSource, /updates:\s*true/);
});

class FakeElement {
  readonly id: string;
  value = ""; textContent = ""; hidden = false; disabled = false; dataset: Record<string, string> = {};
  children: FakeElement[] = []; onsubmit?: (event: any) => Promise<void>; onclick?: () => Promise<void> | void;
  readonly startOption = { hidden: true };
  constructor(id = "") { this.id = id; }
  set innerHTML(_value: string) { throw new Error("unsafe HTML rendering"); }
  append(...children: FakeElement[]) { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]) { this.children = [...children]; }
  querySelector(selector: string) { return this.id === "action" && selector === '[value="start"]' ? this.startOption : null; }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.fail("condition not reached");
}

test("shipped management script renders read-only catalog text and ignores stale search/logout responses", async () => {
  let html = "";
  renderPage({ writeHead() {}, end(value: unknown) { html = String(value); } } as any, false, "http://127.0.0.1:9000");
  assert.match(html, /Official Pi release catalog/i); assert.match(html, /read-only/i); assert.match(html, /update execution is not enabled/i);
  assert.doesNotMatch(html, /id="(?:install|update|activate)"/i);

  const ids = ["message", "content", "login", "logout", "credential", "capabilities", "action", "submit", "workspace", "tasks", "task", "target",
    "review", "review-data", "approve", "refresh", "cancel", "version-search", "version-query", "catalog-status", "versions", "versions-next"];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)])) as Record<string, FakeElement>;
  const main = new FakeElement("main"); main.dataset.admin = "false";
  const first = deferred<any>(), logoutPending = deferred<any>();
  let versionCalls = 0;
  const fetches: { path: string; init: any }[] = [];
  const fetch = async (requestPath: string, init: any) => {
    fetches.push({ path: requestPath, init });
    const route = requestPath.replace("/api/manager/", "");
    let value: unknown;
    if (route === "capabilities") value = { native: false, docker: false, enrollment: false, updates: false };
    else if (route === "workspaces") value = [];
    else if (route === "tasks") value = [];
    else if (route === "versions") {
      versionCalls++;
      if (versionCalls === 1) return first.promise;
      if (versionCalls === 2) value = { status: "fresh", checkedAt: 1, versions: [future], nextCursor: "next" };
      else if (versionCalls === 3) value = { status: "stale", checkedAt: 1, error: "registry-unavailable", versions: ["2099.1.0"] };
      else if (versionCalls === 4) value = { status: "unavailable", checkedAt: null, error: "registry-unavailable", versions: [] };
      else return logoutPending.promise;
    } else throw new Error(`unexpected route ${route}`);
    return { ok: true, json: async () => value };
  };
  const document = {
    getElementById: (id: string) => elements[id],
    querySelector: (selector: string) => selector === "main" ? main : null,
    createElement: () => new FakeElement(),
  };
  vm.runInNewContext(browserScript, { document, fetch, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" }, confirm: () => true, setTimeout, clearTimeout });

  elements.credential.value = requester;
  const login = elements.login.onsubmit!({ preventDefault() {} });
  await waitFor(() => versionCalls === 1);
  elements["version-query"].value = "2099";
  await elements["version-search"].onsubmit!({ preventDefault() {} });
  assert.deepEqual(elements.versions.children.map(x => x.textContent), [future]);
  assert.equal(elements["versions-next"].hidden, false);
  assert.match(elements["catalog-status"].textContent, /read-only/i);
  assert.match(elements["catalog-status"].textContent, /compatibility is not implied/i);

  first.resolve({ ok: true, json: async () => ({ status: "fresh", checkedAt: 1, versions: ["1.0.0"] }) });
  await login;
  assert.deepEqual(elements.versions.children.map(x => x.textContent), [future]);

  await elements["versions-next"].onclick!();
  assert.deepEqual(elements.versions.children.map(x => x.textContent), [future, "2099.1.0"]);
  assert.match(elements["catalog-status"].textContent, /stale cached/i); assert.equal(elements["versions-next"].hidden, true);
  assert.deepEqual(JSON.parse(fetches.filter(x => x.path.endsWith("/versions"))[2].init.body), { query: "2099", limit: 50, cursor: "next" });

  elements["version-query"].value = "9999";
  await elements["version-search"].onsubmit!({ preventDefault() {} });
  assert.deepEqual(elements.versions.children, []); assert.match(elements["catalog-status"].textContent, /unavailable/i);

  elements["version-query"].value = "2099";
  const pending = elements["version-search"].onsubmit!({ preventDefault() {} });
  await waitFor(() => versionCalls === 5);
  await elements.logout.onclick!();
  logoutPending.resolve({ ok: true, json: async () => ({ status: "fresh", checkedAt: 2, versions: ["2.0.0"] }) });
  await pending;
  assert.deepEqual(elements.versions.children, []); assert.equal(elements["versions-next"].hidden, true);
  assert.equal(elements.content.hidden, true); assert.match(elements["catalog-status"].textContent, /locked/i);
  assert.ok(fetches.filter(x => x.path.endsWith("/versions")).every(x => x.init.method === "POST"));
});

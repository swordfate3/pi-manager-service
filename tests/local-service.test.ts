import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, IncomingMessage, request, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";

test("local proxy failure after headers closes the response without writing another header", async () => {
  const service = await import("../manager/local-service.ts");
  const respond = (service as any).replyLocalError;
  assert.equal(typeof respond, "function", "shared local error handler must safely handle an already-started response");
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  response.writeHead(200, { "Content-Type": "text/plain" });
  assert.doesNotThrow(() => respond(response, new Error("private upstream details")));
  assert.equal(response.destroyed, true);
  assert.equal(response.statusCode, 200);
  assert.doesNotThrow(() => respond(response, new Error("already closed")));
});

async function fixture(t: any) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-local-service-"));
  const home = path.join(root, "home"), projects = path.join(home, "projects");
  await mkdir(path.join(projects, "默认项目"), { recursive: true });
  await mkdir(path.join(projects, "another project"));
  await mkdir(path.join(projects, "private"));
  await symlink(tmpdir(), path.join(projects, "outside-link"));
  await mkdir(path.join(root, "bin"));
  const launcher = path.join(root, "bin", "launcher");
  await writeFile(launcher, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  const { startLocalService } = await import("../manager/local-service.ts");
  const service = await startLocalService({ port: 0, chatPort: 0, home, workspaceRoots: { projects },
    defaultWorkspace: { root: "projects", path: "默认项目" }, stateRoot: path.join(root, "state"),
    launcher, hubCli: path.resolve("dist/hub/pi-web-hub.mjs"), protectedRoots: [path.join(projects, "private")] });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  let csrf = "",cookie="";
  async function call(route: string, body?: unknown, extra: Record<string, string | undefined> = {}) {
    return await new Promise<{ status: number; value: any; text: string; headers: any }>((resolve, reject) => {
      const req = request(origin + route, { method: body === undefined ? "GET" : "POST", headers: Object.fromEntries(Object.entries({
        Origin: origin, "Content-Type": "application/json",...(cookie ? {Cookie:cookie}:{}), ...(csrf ? { "X-Pi-Local-Csrf": csrf } : {}), ...extra,
      }).filter(([, value]) => value !== undefined)) }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
        res.on("end", () => { let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode!, value, text, headers: res.headers }); });
      }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  csrf=(await call("/api/auth/state")).value.csrfToken;
  const setup=await call("/api/auth/setup",{username:"tester",password:"isolated-test-password"});assert.equal(setup.status,200);
  cookie=setup.headers["set-cookie"][0].split(";")[0];
  const state = await call("/api/local/state");
  assert.equal(state.status, 200); csrf = state.value.csrfToken;
  return { root, home, projects, call, service, state: state.value,cookie };
}

test("local Hub exposes one page and configured default, never credentials or approval UI", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.state.defaultWorkspace, { root: "projects", path: "默认项目" });
  assert.deepEqual(f.state.runs, []);
  const page = await f.call("/"); assert.equal(page.status, 200);
  assert.match(page.text, /启动并进入会话/); assert.doesNotMatch(page.text, /id="credential"|pending_approval|Submit for independent approval/);
  assert.equal((await f.call("/sessions/")).headers.location, "/");
  assert.equal((await f.call("/api/local/state", undefined, { Host: "evil.example" })).status, 403);
  assert.equal((await f.call("/api/local/state", undefined, { Origin: "https://evil.example" })).status, 403);
});

test("clicking an external link opens the workbench without permitting cross-site API access", async t => {
  const f = await fixture(t);
  const navigation = { Origin: undefined, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
  assert.equal((await f.call("/", undefined, navigation)).status, 200);
  assert.equal((await f.call("/sessions/", undefined, navigation)).status, 302);
  for (const route of ["/api/local/state", "/api/sessions", "/local.js", "/s/not-a-session/"]) {
    assert.equal((await f.call(route, undefined, navigation)).status, 403, route);
  }
  assert.equal((await f.call("/", undefined, { ...navigation, "Sec-Fetch-Dest": "iframe" })).status, 403);
  assert.equal((await f.call("/", undefined, { ...navigation, "Sec-Fetch-Mode": "cors" })).status, 403);
  assert.equal((await f.call("/", undefined, { ...navigation, Host: "evil.example" })).status, 403);
  assert.equal((await f.call("/", undefined, { ...navigation, Origin: "https://evil.example" })).status, 403);
  // Even a known CSRF token must not bypass the source boundary for mutations.
  assert.equal((await f.call("/api/local/start", { key: "cross-site-start", workspace: { root: "projects", path: "默认项目" } },
    { ...navigation, Origin: new URL(f.service.url).origin })).status, 403);
  assert.deepEqual((await f.call("/api/local/state")).value.runs, []);
});

test("Chromium can click a cross-site link into the real workbench and browse a folder", {
  skip: !process.env.PI_LOCAL_UI_TEST_BROWSER,
  timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const { chromium } = await import("@playwright/test");
  const source = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<a href="${f.service.url}">打开工作台</a>`); });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { source.close(() => resolve()); source.closeAllConnections(); }));
  const sourcePort = (source.address() as import("node:net").AddressInfo).port;
  const browser = await chromium.launch({ executablePath: process.env.PI_LOCAL_UI_TEST_BROWSER, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.context().addCookies([{name:"pi_local_session",value:f.cookie.split("=")[1],url:f.service.url,httpOnly:true,sameSite:"Lax"}]);
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://localhost:${sourcePort}/`);
  const [navigation, response] = await Promise.all([
    page.waitForRequest(req => req.url() === f.service.url && req.isNavigationRequest()),
    page.waitForResponse(res => res.url() === f.service.url),
    page.getByRole("link", { name: "打开工作台" }).click(),
  ]);
  assert.equal((await navigation.allHeaders())["sec-fetch-site"], "cross-site");
  assert.equal(response.status(), 200);
  await page.locator("#local-start:not([disabled])").waitFor();
  assert.match((await page.locator("#local-workspace").textContent())!, /默认项目/);
  await page.getByRole("button", { name: "上一级", exact: true }).click();
  await page.getByRole("button", { name: "another project", exact: true }).click();
  await page.locator("#local-start:not([disabled])").waitFor();
  assert.match((await page.locator("#local-workspace").textContent())!, /another project/);
  assert.deepEqual(errors, []);
  assert.deepEqual((await f.call("/api/local/state")).value.runs, []);
});

test("local browse hides private and symlink paths and refuses outside-home selections", async t => {
  const f = await fixture(t);
  const browse = await f.call("/api/local/browse", { root: "projects", path: "" });
  assert.equal(browse.status, 200);
  assert.deepEqual(browse.value.directories.map((d: any) => d.name).sort(), ["another project", "默认项目"].sort());
  for (const value of ["..", "/tmp", "outside-link", "private"]) {
    assert.equal((await f.call("/api/local/browse", { root: "projects", path: value })).status, 400);
  }
  assert.equal((await f.call("/api/local/browse", { root: "projects", path: "" }, { "X-Pi-Local-Csrf": "" })).status, 403);
  const denied = await f.call("/api/local/start", { key: "outside", workspace: { root: "projects", path: "../" } });
  assert.equal(denied.status, 400); assert.deepEqual((await f.call("/api/local/state")).value.runs, []);
});

test("start generates the name, deduplicates delivery and reports child failure without exposing logs", async t => {
  const f = await fixture(t);
  const payload = { key: "start-1", workspace: { root: "projects", path: "默认项目" } };
  const started = await f.call("/api/local/start", payload); assert.equal(started.status, 202);
  assert.match(started.value.id, /^pi-local-[a-f0-9]{24}$/);
  assert.equal((await f.call("/api/local/start", payload)).value.id, started.value.id);
  assert.equal((await f.call("/api/local/start", { ...payload, workspace: { root: "projects", path: "another project" } })).status, 409);
  const end = Date.now() + 3000;
  let state;
  do { state = (await f.call("/api/local/state")).value; if (state.runs[0].state === "failed") break; await new Promise(resolve => setTimeout(resolve, 15)); } while (Date.now() < end);
  assert.equal(state.runs[0].state, "failed"); assert.match(state.runs[0].error, /启动/);
  assert.ok(!JSON.stringify(state).includes(f.root));
  const {LocalStore}=await import("../manager/local-store.ts");const store=await LocalStore.open(path.join(f.root,"state"));const journal=store.runs();store.close();
  assert.equal(journal[0].id, started.value.id);
});

test("local configuration rejects public bind, roots outside Home and malformed defaults", async () => {
  const { localConfig } = await import("../manager/local-config.ts");
  const config = { port: 18403, chatPort: 18404, home: "/srv/home", workspaceRoots: { projects: "/srv/home/projects" }, defaultWorkspace: { root: "projects", path: "demo" }, stateRoot: "/srv/private/local", launcher: "/opt/pirun", hubCli: "/opt/hub.mjs" };
  assert.equal(localConfig(config).port, 18403);
  for (const change of [{ host: "0.0.0.0" }, { port: 80 }, { workspaceRoots: { projects: "/tmp" } }, { defaultWorkspace: { root: "projects", path: ".." } }, { origin: "https://example.org" }]) {
    assert.throws(() => localConfig({ ...config, ...change }));
  }
});

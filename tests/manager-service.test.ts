import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { harness } from "./helpers/native-harness.ts";
import { waitFor, observation, assertDead } from "./helpers/native-harness.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";

const agent = "synthetic-agent-credential-0000000001";
const admin = "synthetic-admin-credential-0000000002";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const origin = "http://127.0.0.1:18191";
const adminOrigin = "http://127.0.0.1:18192";
const body = { key: "request-1", action: "create", target: "sample", workspace: "project" };

function mockOfficialVersions(t: any) {
  const packageName = "@earendil-works/pi-coding-agent";
  const version = "2099.10.27";
  let calls = 0;
  t.mock.method(https, "request", (url: string, options: https.RequestOptions, callback: (res: unknown) => void) => {
    calls++;
    assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    assert.equal((options.headers as Record<string, unknown>).accept, "application/vnd.npm.install-v1+json");
    const metadata = { name: packageName, version, engines: { node: ">=22.19.0" }, dist: {
      tarball: `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
    } };
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: packageName, versions: { [version]: metadata } }))]), { statusCode: 200, headers: {} })));
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { version, calls: () => calls };
}

async function fixture(t: any) {
  const cleanups: (() => Promise<void>)[] = [];
  const f = await harness({ after: (fn: () => Promise<void>) => cleanups.push(fn) } as any);
  const { startExecutor } = await import("../manager/executor/main.ts");
  const { startService } = await import("../manager/service.ts");
  const config = {
    stateRoot: path.join(f.parent, "tasks"),
    submitSocket: path.join(f.parent, "submit", "rpc.sock"),
    adminSocket: path.join(f.parent, "admin", "rpc.sock"),
    principals: [{ id: "agent", role: "submitter", tokenHash: hash(agent) }, { id: "operator", role: "admin", tokenHash: hash(admin) }],
    trustedLocalNative: true,
    native: f.config,
    workspaces: { project: { label: "Test project", root: "work", path: "project" } },
  };
  for (const dir of ["submit", "admin"]) await mkdir(path.join(f.parent, dir), { mode: 0o700 });
  let executor = await startExecutor(config);
  const service = await startService({ socketPath: config.submitSocket, origin, chatOrigin: "http://127.0.0.1:18190", port: 0 });
  t.after(async () => { try { await service.close(); await executor.close(); } finally { for (const cleanup of cleanups) await cleanup(); } });
  const call = (route: string, data?: unknown, headers: Record<string, string | string[]> = {}) => http(service.port, route, data, headers);
  return { ...f, config, service, call, restart: async () => { await executor.close(); executor = await startExecutor(config); } };
}

function http(port: number, route: string, data?: unknown, headers: Record<string, string | string[]> = {}) {
  return new Promise<{ status: number; body: any; text: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: route, method: data === undefined ? "GET" : "POST", headers: { Host: new URL(origin).host, Origin: origin, Authorization: `Bearer ${agent}`, "Content-Type": "application/json", ...headers } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body, text, headers: res.headers }); });
    });
    req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

test("real HTTP: zero-Pi page and pending task persist without starting a child", async (t) => {
  const f = await fixture(t);
  const page = await f.call("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /Pi Manager/);
  assert.match(page.text, /href="http:\/\/127\.0\.0\.1:18190\/sessions\/"/);
  const response = await f.call("/api/manager/tasks", body);
  assert.equal(response.status, 202);
  assert.equal(response.body.state, "pending_approval");
  assert.equal(response.body.requester, "agent");
  assert.match(response.body.id, /^[0-9a-f-]{36}$/);
  await assert.rejects(access(path.join(f.workspace, "observed.json")));
  assert.equal((await f.call(`/api/manager/tasks/${response.body.id}`)).body.id, response.body.id);
  await f.restart();
  assert.equal((await f.call("/api/manager/tasks", body)).body.id, response.body.id);
  assert.equal((await f.call("/api/manager/tasks", { ...body, target: "changed" })).status, 409);
  assert.ok((await readFile(path.join(f.config.stateRoot, "tasks.json"), "utf8")).includes(response.body.id));
});

test("real HTTP: self approval, forged principal, Host/Origin, body and path constraints", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/manager/tasks/approve", {})).status, 403);
  for (const headers of [{ Host: "evil.test" }, { Origin: "http://evil.test" }, { Origin: "null" }, { Authorization: [`Bearer ${agent}`, `Bearer ${admin}`] }, { Authorization: "Basic secret" }] as Record<string, string | string[]>[]) {
    assert.ok([400, 401, 403].includes((await f.call("/api/manager/tasks", body, headers)).status));
  }
  for (const addition of [{ requester: "operator" }, { executable: "/bin/sh" }, { argv: ["-c", "evil"] }, { pid: 1 }, { docker: {} }]) {
    assert.equal((await f.call("/api/manager/tasks", { ...body, ...addition })).status, 400);
  }
  for (const workspace of ["../secret", "/private", "%2e%2e", "unknown"]) {
    assert.equal((await f.call("/api/manager/tasks", { ...body, workspace })).status, 400);
  }
  assert.equal((await f.call("/api/manager/tasks", { ...body, key: "x".repeat(20000) })).status, 413);
  assert.equal((await f.call("/api/manager/tasks/%2e%2e%2fsecret")).status, 400);
  const choices = await f.call("/api/manager/workspaces");
  assert.deepEqual(choices.body, [{ id: "project", label: "Test project" }]);
  assert.ok(!choices.text.includes(f.parent));
});

test("real public and administrator HTTP query the same read-only official version catalog", async t => {
  const official = mockOfficialVersions(t);
  const f = await fixture(t);
  assert.equal((await f.call("/api/manager/versions", {}, { Authorization: "" })).status, 401);
  assert.equal((await f.call("/api/manager/versions", {}, { Authorization: `Bearer ${admin}` })).status, 403);
  assert.equal(official.calls(), 0);
  const publicPage = await f.call("/api/manager/versions", { query: "2099", limit: 1 });
  assert.equal(publicPage.status, 200); assert.deepEqual(publicPage.body.versions, [official.version]);
  assert.equal((await f.call("/api/manager/versions", { query: "2099", registry: "https://evil.invalid" })).status, 400);
  assert.equal(official.calls(), 1); assert.deepEqual((await f.call("/api/manager/tasks")).body, []);

  const { startAdminService } = await import("../manager/admin-service.ts");
  const adminService = await startAdminService({ socketPath: f.config.adminSocket, origin: adminOrigin, chatOrigin: origin, port: 0 });
  t.after(() => adminService.close());
  const headers = { Host: new URL(adminOrigin).host, Origin: adminOrigin, Authorization: "" };
  const call = (route: string, data?: unknown, extra = {}) => http(adminService.port, route, data, { ...headers, ...extra });
  const login = await call("/api/manager/login", { credential: admin });
  const adminPage = await call("/api/manager/versions", { query: "2099", limit: 1 }, { Authorization: `Bearer ${login.body.sessionToken}` });
  assert.equal(adminPage.status, 200); assert.deepEqual(adminPage.body.versions, [official.version]); assert.equal(official.calls(), 1);
});

export { fixture, http, agent, admin, origin, adminOrigin, body };

test("principal-bound clients: independent exact approval, CAS race, child lifecycle and redacted results", async (t) => {
  const f = await fixture(t);
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: agent });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: admin });
  const bypass = new AdminClient({ socketPath: f.config.submitSocket, credential: agent });
  const created = await client.submitTask(body as any);
  await assert.rejects(bypass.approveTask({ taskId: created.id, revision: 1, requestHash: "x".repeat(64), policyHash: "x".repeat(64) }), { status: 403 });
  await assert.rejects(operator.executeTask({ taskId: created.id, revision: 1 }), { status: 403 });
  const review = await operator.reviewTask(created.id);
  assert.match(review.binding.requestHash, /^[a-f0-9]{64}$/);
  for (const mutation of [{ revision: 99 }, { requestHash: "0".repeat(64) }, { policyHash: "0".repeat(64) }]) {
    await assert.rejects(operator.approveTask({ ...review.binding, ...mutation }), { status: 409 });
  }
  const approvals = await Promise.allSettled([operator.approveTask(review.binding), operator.approveTask(review.binding)]);
  assert.equal(approvals.filter(a => a.status === "fulfilled").length, 1);
  const queued = await client.getTask(created.id);
  const executions = await Promise.allSettled([operator.executeTask({ taskId: created.id, revision: queued.revision }), operator.executeTask({ taskId: created.id, revision: queued.revision })]);
  assert.equal(executions.filter(a => a.status === "fulfilled").length, 1);
  await waitFor(async () => (await client.getTask(created.id)).state === "succeeded");
  const observed = await observation(f.workspace);
  assert.ok(observed.pid > 0);
  const completed = await client.getTask(created.id);
  assert.deepEqual(completed.result, { status: "created", instanceId: "sample" });
  assert.ok(!JSON.stringify(completed).includes(f.parent));
  const stopped = await client.submitTask({ key: "stop", action: "stop", target: "sample" });
  const stopReview = await operator.reviewTask(stopped.id);
  const approved = await operator.approveTask(stopReview.binding);
  await operator.executeTask({ taskId: stopped.id, revision: approved.revision });
  await waitFor(async () => (await client.getTask(stopped.id)).state === "succeeded");
  assertDead(observed.pid);
  assert.equal((await f.call("/")).status, 200);
  assert.equal((await client.listTasks()).length, 2);
});

test("restart requires fresh approval for queued work; terminal unknown is never replayed", async (t) => {
  const f = await fixture(t);
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: agent });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: admin });
  const task = await client.submitTask(body as any);
  const approved = await operator.approveTask((await operator.reviewTask(task.id)).binding);
  await f.restart();
  await assert.rejects(operator.executeTask({ taskId: task.id, revision: approved.revision }), { status: 403 });
  await assert.rejects(access(path.join(f.workspace, "observed.json")));
  const review = await operator.reviewTask(task.id);
  assert.equal(review.requiresFreshApproval, true);
  await operator.approveTask(review.binding);
  await operator.executeTask({ taskId: task.id, revision: approved.revision });
  await waitFor(async () => (await client.getTask(task.id)).state === "succeeded");
  const observed = await observation(f.workspace);
  await f.restart(); assertDead(observed.pid);
  assert.equal((await client.getTask(task.id)).state, "succeeded");
  await assert.rejects(operator.executeTask({ taskId: task.id, revision: (await client.getTask(task.id)).revision }), { status: 409 });
});

test("private administrator login uses explicit memory-only bearer, never ambient cross-port cookies", async (t) => {
  const f = await fixture(t);
  const { startAdminService } = await import("../manager/admin-service.ts");
  const adminService = await startAdminService({ socketPath: f.config.adminSocket, origin: adminOrigin, chatOrigin: origin, port: 0 });
  t.after(() => adminService.close());
  const headers = { Host: new URL(adminOrigin).host, Origin: adminOrigin, Authorization: "" };
  const call = (route: string, data?: unknown, extra = {}) => http(adminService.port, route, data, { ...headers, ...extra });
  const page = await call("/");
  assert.equal(page.status, 200); assert.match(page.text, /credential/i);
  assert.ok(!page.text.includes(admin)); assert.ok(!page.text.includes(agent));
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal((await call("/api/manager/login", { credential: agent })).status, 403);
  const login = await call("/api/manager/login", { credential: admin });
  assert.equal(login.status, 200);
  assert.equal(login.headers["set-cookie"], undefined);
  assert.match(login.body.sessionToken, /^[0-9a-f]{64}$/);
  assert.ok(!login.text.includes(admin));
  const auth = { Authorization: `Bearer ${login.body.sessionToken}` };
  assert.equal((await call("/api/manager/tasks", undefined, { Cookie: `manager_session=${login.body.sessionToken}` })).status, 401);
  const task = (await f.call("/api/manager/tasks", body)).body;
  const review = await call(`/api/manager/tasks/${task.id}/review`, undefined, auth);
  assert.equal(review.body.task.state, "pending_approval");
  assert.equal((await call("/api/manager/approve", review.body.binding, auth)).status, 200);
  assert.equal((await call("/api/manager/tasks", undefined, auth)).body[0].state, "running");
  // A lost approve response must be recoverable without approving twice.
  const pending=(await f.call("/api/manager/tasks",{...body,key:"resume-approved",target:"resume-approved"})).body;
  const operator=new AdminClient({socketPath:f.config.adminSocket,credential:admin});
  const queued=await operator.approveTask((await operator.reviewTask(pending.id)).binding);
  const reconciled=await call(`/api/manager/tasks/${pending.id}/review`,undefined,auth);
  assert.equal(reconciled.body.requiresFreshApproval,false);
  assert.equal((await call("/api/manager/execute",{taskId:pending.id,revision:queued.revision},auth)).status,200);
  assert.equal((await call("/api/manager/execute",{taskId:pending.id,revision:queued.revision,argv:["evil"]},auth)).status,400);
  assert.equal((await call("/api/manager/logout", {}, auth)).status, 200);
  assert.equal((await call("/api/manager/tasks", undefined, auth)).status, 401);
});

test("config fails closed for untrusted native, shared approval transport and chat-origin management", async (t) => {
  const f = await fixture(t);
  const { executorConfig, serviceConfig } = await import("../manager/config.ts");
  assert.throws(() => executorConfig({ ...f.config, trustedLocalNative: false }));
  assert.throws(() => executorConfig({ ...f.config, adminSocket: f.config.submitSocket }));
  assert.throws(() => executorConfig({ ...f.config, docker: {} }));
  assert.throws(() => serviceConfig({ socketPath: f.config.submitSocket, port: 0, origin, chatOrigin: origin }));
  const { startExecutor } = await import("../manager/executor/main.ts");
  await assert.rejects(startExecutor(f.config));
  assert.equal((await f.call("/api/manager/capabilities")).body.enrollment, false);
});

test("real HTTP: slow body deadline and malformed frames do not admit tasks or leak paths", async (t) => {
  const f=await fixture(t);
  const {createConnection}=await import("node:net");
  async function raw(payload:string|Buffer) {
    return new Promise<string>((resolve,reject)=>{
      const socket=createConnection({host:"127.0.0.1",port:f.service.port});let output="";
      const timeout=setTimeout(()=>{socket.destroy();reject(Error("HTTP deadline not enforced"));},7500);
      socket.on("connect",()=>socket.write(payload));socket.on("data",chunk=>{output+=chunk.toString();});
      socket.on("error",reject);socket.on("close",()=>{clearTimeout(timeout);resolve(output);});
    });
  }
  const prefix=`POST /api/manager/tasks HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nAuthorization: Bearer ${agent}\r\nContent-Type: application/json\r\nConnection: close\r\n`;
  const bad=await raw(Buffer.concat([Buffer.from(prefix+"Content-Length: 2\r\n\r\n"),Buffer.from([0xff,0xff])]));
  assert.match(bad,/400 Bad Request/);assert.ok(!bad.includes(f.parent));
  const big=await raw(prefix+"Content-Length: 9000\r\n\r\n");assert.match(big,/413/);
  const started=Date.now();await raw(prefix+"Content-Length: 100\r\n\r\n{");assert.ok(Date.now()-started<7500);
  assert.deepEqual((await f.call("/api/manager/tasks")).body,[]);
});

test("real browser: zero-Pi submit, private review, no credential storage, desktop and mobile", {skip:!process.env.PI_MANAGER_TEST_BROWSER}, async (t) => {
  const f=await fixture(t);
  const {createServer}=await import("node:net");
  const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,"127.0.0.1",r));
  const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
  const {startAdminService}=await import("../manager/admin-service.ts");
  const browserOrigin=`http://127.0.0.1:${port}`;
  const ui=await startAdminService({socketPath:f.config.adminSocket,origin:browserOrigin,chatOrigin:origin,port});t.after(()=>ui.close());
  const reservePublic=createServer();await new Promise<void>(r=>reservePublic.listen(0,"127.0.0.1",r));
  const publicPort=(reservePublic.address() as {port:number}).port;await new Promise<void>(r=>reservePublic.close(()=>r()));
  const {startService}=await import("../manager/service.ts");const publicOrigin=`http://127.0.0.1:${publicPort}`;
  const publicUi=await startService({socketPath:f.config.submitSocket,origin:publicOrigin,chatOrigin:origin,port:publicPort});t.after(()=>publicUi.close());
  const {chromium}=await import("@playwright/test");
  const browserHome=path.join(f.parent,"browser-home");await mkdir(browserHome,{mode:0o700});
  const browser=await chromium.launch({executablePath:process.env.PI_MANAGER_TEST_BROWSER,headless:true,env:{PATH:process.env.PATH!,HOME:browserHome,XDG_CONFIG_HOME:path.join(browserHome,"config"),XDG_CACHE_HOME:path.join(browserHome,"cache")}});t.after(()=>browser.close());
  const context=await browser.newContext();await context.route("**/*",route=>[browserOrigin,publicOrigin].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(browserOrigin);await page.locator("#credential").fill(admin);await page.locator("#login button").click();
  await page.locator("#content").waitFor({state:"visible"});assert.equal(await page.locator("#credential").inputValue(),"");
  assert.deepEqual(await context.cookies(), []);
  const publicHeaders: Record<string,string>[] = [];
  context.on("request", req => { if (new URL(req.url()).origin === publicOrigin) publicHeaders.push(req.headers()); });
  const requesterPage=await context.newPage();requesterPage.on("pageerror",e=>errors.push(e.message));await requesterPage.goto(publicOrigin);
  await requesterPage.locator("#credential").fill(agent);await requesterPage.locator("#login button").click();await requesterPage.locator("#content").waitFor({state:"visible"});
  await requesterPage.locator("#target").fill("browser-pi");await requesterPage.locator("#submit").click();
  await requesterPage.waitForFunction(()=>document.getElementById("message")?.textContent?.includes("pending_approval"));
  const task=(await f.call("/api/manager/tasks")).body[0];assert.equal(task.target,"browser-pi");
  await page.locator("#refresh").click();await page.getByRole("button",{name:"Review",exact:true}).click();
  await page.locator("#review").waitFor({state:"visible"});assert.match(await page.locator("#review-data").textContent() ?? "",new RegExp(task.id));
  for(const [name,width,height] of [["desktop",1280,900],["phone",390,844]] as const){
    await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.PI_MANAGER_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PI_MANAGER_TEST_SCREENSHOTS,`manager-${name}.png`),fullPage:true});
  }
  page.on("dialog",dialog=>dialog.accept());await page.locator("#approve").click();
  await page.waitForFunction(()=>document.getElementById("message")?.textContent?.includes("Approval accepted"));
  await waitFor(async()=>(await f.call(`/api/manager/tasks/${task.id}`)).body.state==="succeeded");
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
  assert.ok(publicHeaders.length > 0);
  for (const h of publicHeaders) { assert.equal(h.cookie, undefined); assert.ok(!h.authorization || h.authorization === `Bearer ${agent}`); }
  await page.locator("#logout").click();await page.locator("#login").waitFor({state:"visible"});
});

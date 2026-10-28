import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startAdminService } from "../manager/admin-service.ts";
import { startExecutor } from "../manager/executor/main.ts";
import { startService } from "../manager/service.ts";
import { executorConfig } from "../manager/config.ts";
import { AdminClient } from "../manager/executor/admin-client.ts";
import { ExecutorClient } from "../manager/executor/client.ts";
import { waitFor } from "./helpers/native-harness.ts";
import { WorkspacePolicy } from "../manager/workspaces.ts";

const requester = "workspace-requester-credential-00000001";
const administrator = "workspace-admin-credential-0000000001";
const publicOrigin = "http://127.0.0.1:18301";
const adminOrigin = "http://127.0.0.1:18302";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

interface HttpResult { status: number; body: any; text: string }

function http(port: number, origin: string, route: string, credential = requester, data?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request({ host: "127.0.0.1", port, path: route, method: data === undefined ? "GET" : "POST", headers: {
      Host: new URL(origin).host, Origin: origin, Authorization: credential ? `Bearer ${credential}` : "", ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { let parsed: unknown = text; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode!, body: parsed, text }); });
    });
    req.on("error", reject); req.end(body);
  });
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "manager-workspaces-"));
  const root = path.join(home, "projects");
  const project = path.join(root, "alpha");
  const authority = path.join(root, ".manager-private");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(project, "other"));
  await writeFile(path.join(project, "scenario.json"), JSON.stringify("normal"));
  await writeFile(path.join(root, "ordinary-file.txt"), "not a directory");
  const outside = path.join(home, "outside"); await mkdir(outside);
  await symlink(outside, path.join(root, "escape"));
  const executable = path.join(home, "fake-pi");
  const child = await import("node:fs/promises").then(fs => fs.readFile(new URL("fixtures/native-child.mjs", import.meta.url), "utf8"));
  await writeFile(executable, `#!${process.execPath}\n${child}`, { mode: 0o700 });
  const config = {
    stateRoot: path.join(authority, "tasks"), submitSocket: path.join(authority, "submit", "rpc.sock"), adminSocket: path.join(authority, "admin", "rpc.sock"),
    principals: [{ id: "requester", role: "submitter" as const, tokenHash: hash(requester) }, { id: "administrator", role: "admin" as const, tokenHash: hash(administrator) }],
    trustedLocalNative: true,
    native: { piExecutable: executable, workspaceRoots: { projects: root }, stateRoot: path.join(authority, "native-state"), agentRoot: path.join(authority, "native-agents"), startupTimeoutMs: 1500, stopTimeoutMs: 150 },
    workspaces: { staticAlpha: { label: "Static alpha", root: "projects", path: "alpha" } },
    workspaceBrowser: { home, defaultRoot: "projects" },
  };
  await mkdir(path.dirname(config.submitSocket), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(config.adminSocket), { recursive: true, mode: 0o700 });
  let executor = await startExecutor(config);
  const publicService = await startService({ socketPath: config.submitSocket, origin: publicOrigin, chatOrigin: "http://127.0.0.1:18300", port: 0 });
  const adminService = await startAdminService({ socketPath: config.adminSocket, origin: adminOrigin, chatOrigin: publicOrigin, port: 0 });
  t.after(async () => { await adminService.close(); await publicService.close(); await executor.close(); await rm(home, { recursive: true, force: true }); });
  return { home, root, project, outside, authority, config, publicService, adminService,
    call: (route: string, data?: unknown, credential = requester) => http(publicService.port, publicOrigin, route, credential, data),
    restart: async () => { await executor.close(); executor = await startExecutor(config); },
  };
}

test("workspace browser permits an external-home project root ancestor while hiding private descendants", async t => {
  const f = await fixture(t);
  const policy = await f.call("/api/manager/workspace-browser");
  assert.equal(policy.status, 200);
  assert.deepEqual(policy.body, { defaultRoot: "projects", roots: [{ id: "projects", label: "projects" }] });
  assert.ok(!policy.text.includes(f.home));

  const page = await f.call("/api/manager/workspaces/browse", { root: "projects", path: "" });
  assert.equal(page.status, 200);
  assert.equal(page.body.root, "projects"); assert.equal(page.body.path, "");
  assert.deepEqual(page.body.directories, [{ name: "alpha", path: "alpha" }]);
  assert.equal(page.body.truncated, false);
  for (const privateValue of [f.home, ".manager-private", "escape", "ordinary-file.txt"]) assert.ok(!page.text.includes(privateValue));
});

test("workspace browse rejects malformed paths and symlink traversal without exposing host paths", async t => {
  const f = await fixture(t);
  for (const candidate of ["..", "../outside", "/absolute", ".", "alpha/.", "alpha//child", "alpha\\child", "alpha\0child", "escape"]) {
    const result = await f.call("/api/manager/workspaces/browse", { root: "projects", path: candidate });
    assert.equal(result.status, 400, candidate); assert.ok(!result.text.includes(f.home));
  }
  assert.equal((await f.call("/api/manager/workspaces/browse", { root: "unknown", path: "" })).status, 400);
  assert.equal((await f.call("/api/manager/workspaces/browse", { root: "projects", path: "", extra: true })).status, 400);
});

test("no-browser static workspaces preserve legacy dot and repeated-separator normalization", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "manager-static-workspaces-"));
  const root = path.join(home, "projects");
  await mkdir(path.join(root, "alpha", "child"), { recursive: true });
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  const config = executorConfig({
    stateRoot: path.join(home, "private", "tasks"), submitSocket: path.join(home, "private", "submit", "rpc.sock"), adminSocket: path.join(home, "private", "admin", "rpc.sock"),
    principals: [{ id: "requester", role: "submitter", tokenHash: hash(requester) }], trustedLocalNative: true,
    native: { piExecutable: process.execPath, workspaceRoots: { projects: root }, stateRoot: path.join(home, "private", "native"), agentRoot: path.join(home, "private", "agents") },
    workspaces: {
      dot: { label: "Dot suffix", root: "projects", path: "alpha/." },
      repeated: { label: "Repeated separator", root: "projects", path: "alpha//child" },
    },
  });
  const policy = await WorkspacePolicy.open(config);
  assert.equal(policy.browser(), null);
  assert.deepEqual(await policy.resolve("dot"), { root: "projects", path: "alpha" });
  assert.deepEqual(await policy.resolve("repeated"), { root: "projects", path: "alpha/child" });
});

test("workspace browse is authenticated and bounds directory replies at 200", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 205; index++) await mkdir(path.join(f.root, `bulk-${String(index).padStart(3, "0")}`));
  assert.equal((await f.call("/api/manager/workspace-browser", undefined, "")).status, 401);
  assert.equal((await f.call("/api/manager/workspace-browser", undefined, administrator)).status, 403);
  assert.equal((await f.call("/api/manager/workspaces/browse", { root: "projects", path: "" }, "")).status, 401);
  const page = await f.call("/api/manager/workspaces/browse", { root: "projects", path: "" });
  assert.equal(page.status, 200); assert.equal(page.body.directories.length, 200); assert.equal(page.body.truncated, true);
  assert.ok(page.body.directories.every((entry: any) => typeof entry.name === "string" && typeof entry.path === "string" && !path.isAbsolute(entry.path)));
});

test("dynamic create stores exact selection, remains idempotent and cannot execute before independent approval", async t => {
  const f = await fixture(t);
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: requester });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: administrator });
  const requestBody = { key: "dynamic-create", action: "create", target: "dynamic-pi", workspace: { root: "projects", path: "alpha" } };
  const submitted = await f.call("/api/manager/tasks", requestBody);
  assert.equal(submitted.status, 202); assert.equal(submitted.body.state, "pending_approval");
  assert.deepEqual(submitted.body.payload.workspace, requestBody.workspace);
  assert.equal((await f.call("/api/manager/tasks", requestBody)).body.id, submitted.body.id);
  assert.equal((await f.call("/api/manager/tasks", { ...requestBody, workspace: { root: "projects", path: "alpha/other" } })).status, 409);
  assert.equal((await f.call("/api/manager/tasks", { ...requestBody, key: "extra", workspace: { ...requestBody.workspace, extra: true } })).status, 400);
  assert.equal((await f.call("/api/manager/tasks", { ...requestBody, key: "protected", target: "protected", workspace: { root: "projects", path: "" } })).status, 400);
  await assert.rejects(access(path.join(f.project, "observed.json")));
  await assert.rejects(operator.executeTask({ taskId: submitted.body.id, revision: submitted.body.revision }), { status: 403 });
  const review = await operator.reviewTask(submitted.body.id);
  assert.deepEqual(review.task.payload, { workspace: requestBody.workspace });
  const requesterAdmin = new AdminClient({ socketPath: f.config.submitSocket, credential: requester });
  await assert.rejects(requesterAdmin.approveTask(review.binding), { status: 403 });
  const approved = await operator.approveTask(review.binding);
  await operator.executeTask({ taskId: approved.id, revision: approved.revision });
  await waitFor(async () => (await client.getTask(approved.id)).state === "succeeded");
  assert.equal((await client.getTask(approved.id)).result?.status, "created");
});

test("dynamic workspace is rechecked at approval and execution", async t => {
  const f = await fixture(t);
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: requester });
  const operator = new AdminClient({ socketPath: f.config.adminSocket, credential: administrator });
  const first = await client.submitTask({ key: "approval-recheck", action: "create", target: "approval-recheck", workspace: { root: "projects", path: "alpha" } } as any);
  const firstReview = await operator.reviewTask(first.id);
  await rename(f.project, path.join(f.root, "alpha-original")); await symlink(f.outside, f.project);
  await assert.rejects(operator.approveTask(firstReview.binding), { status: 400 });
  await rm(f.project); await rename(path.join(f.root, "alpha-original"), f.project);

  const second = await client.submitTask({ key: "execution-recheck", action: "create", target: "execution-recheck", workspace: { root: "projects", path: "alpha" } } as any);
  const approved = await operator.approveTask((await operator.reviewTask(second.id)).binding);
  await rename(f.project, path.join(f.root, "alpha-original")); await symlink(f.outside, f.project);
  await assert.rejects(operator.executeTask({ taskId: approved.id, revision: approved.revision }), { status: 400 });
  assert.equal((await client.getTask(second.id)).state, "queued");
});

test("an exact idempotent retry returns the stored dynamic task after the selected directory disappears", async t => {
  const f = await fixture(t);
  const client = new ExecutorClient({ socketPath: f.config.submitSocket, credential: requester });
  const requestBody = { key: "directory-disappears", action: "create" as const, target: "directory-disappears", workspace: { root: "projects", path: "alpha" } };
  const submitted = await client.submitTask(requestBody);
  await rename(f.project, path.join(f.root, "alpha-removed"));
  const repeated = await client.submitTask(requestBody);
  assert.equal(repeated.id, submitted.id); assert.equal(repeated.state, "pending_approval");
});

test("workspace browser rejects roots outside canonical configured home or equal to home", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "manager-browser-home-"));
  const outside = await mkdtemp(path.join(tmpdir(), "manager-browser-outside-"));
  t.after(async () => { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const base = {
    stateRoot: path.join(home, "private", "tasks"), submitSocket: path.join(home, "private", "submit", "rpc.sock"), adminSocket: path.join(home, "private", "admin", "rpc.sock"),
    principals: [{ id: "requester", role: "submitter" as const, tokenHash: hash(requester) }], trustedLocalNative: true,
    native: { piExecutable: process.execPath, workspaceRoots: { projects: outside }, stateRoot: path.join(home, "private", "native"), agentRoot: path.join(home, "private", "agents") }, workspaces: {},
    workspaceBrowser: { home, defaultRoot: "projects" },
  };
  await assert.rejects(startExecutor(base), { status: 400 });
  await assert.rejects(startExecutor({ ...base, native: { ...base.native, workspaceRoots: { projects: home } } }), { status: 400 });
});

test("administrator HTTP exposes the same exact browser policy after login", async t => {
  const f = await fixture(t);
  const login = await http(f.adminService.port, adminOrigin, "/api/manager/login", "", { credential: administrator });
  assert.equal(login.status, 200);
  const token = login.body.sessionToken;
  const policy = await http(f.adminService.port, adminOrigin, "/api/manager/workspace-browser", token);
  assert.deepEqual(policy.body, { defaultRoot: "projects", roots: [{ id: "projects", label: "projects" }] });
  const page = await http(f.adminService.port, adminOrigin, "/api/manager/workspaces/browse", token, { root: "projects", path: "" });
  assert.equal(page.status, 200); assert.deepEqual(page.body.directories, [{ name: "alpha", path: "alpha" }]);
});

test("zero-Pi executor keeps disabled backend startup and reports no workspace browser", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "manager-zero-pi-"));
  const config = {
    stateRoot: path.join(root, "tasks"), submitSocket: path.join(root, "submit", "rpc.sock"), adminSocket: path.join(root, "admin", "rpc.sock"),
    principals: [{ id: "requester", role: "submitter" as const, tokenHash: hash(requester) }, { id: "administrator", role: "admin" as const, tokenHash: hash(administrator) }],
    trustedLocalNative: false, native: null, workspaces: {},
  };
  await mkdir(path.dirname(config.submitSocket), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(config.adminSocket), { recursive: true, mode: 0o700 });
  const executor = await startExecutor(config);
  t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }); });
  const client = new ExecutorClient({ socketPath: config.submitSocket, credential: requester });
  assert.equal(await client.workspaceBrowser(), null);
  assert.deepEqual(await client.workspaces(), []);
  assert.equal((await client.capabilities()).isolation, "unavailable");
});

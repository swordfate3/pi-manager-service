// Real local-only browser/Docker acceptance. No model prompts or remote access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const origin = "http://127.0.0.1:18403", evidence = process.argv[2];
// This older live-acceptance helper predates login. Never run its unauthenticated
// legacy flow against the authenticated service or create a default account.
const gateCheck=await fetch(origin+"/api/local/state",{signal:AbortSignal.timeout(5000)});
if(gateCheck.status === 401) throw Error("Authenticated workbench: use tests/local-auth-service.test.ts and local-auth-transport.test.ts with isolated state. This legacy helper never reads passwords/cookies.");
assert.match(evidence ?? "", /^\/tmp\/pi-local-accept-[A-Za-z0-9_-]+$/);
const report = { completed: false, checks: [], at: new Date().toISOString() };
const save = () => writeFile(path.join(evidence, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const docker = (...args) => execFileSync("/usr/bin/docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const snapshot = () => {
  const ids = docker("ps", "-aq").trim().split(/\s+/).filter(Boolean);
  return ids.length ? JSON.parse(docker("inspect", ...ids)).map(c => ({ id: c.Id, name: c.Name, running: c.State.Running, started: c.State.StartedAt, restarts: c.RestartCount })) : [];
};
const baseline = snapshot(); report.baseline = baseline;
const workspaceName = "pi-local-workbench-check-" + randomBytes(4).toString("hex");
const workspace = "/home/fate/gitproject/" + workspaceName;
await mkdir(workspace, { mode: 0o755 }); report.workspace = workspace; await save();
let csrf, ownId, browser;
async function api(route, body) {
  const response = await fetch(origin + "/api/local/" + route, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(20000),
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Pi-Local-Csrf": csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); assert.ok(response.ok, "local request " + route + ": " + JSON.stringify(value)); return value;
}
async function until(check, timeout = 130000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 300)); }
  throw Error("acceptance deadline");
}
const check = async text => { report.checks.push(text); await save(); console.log("PASS " + text); };
try {
  const initial = await api("state"); csrf = initial.csrfToken;
  assert.deepEqual(initial.defaultWorkspace, { root: "gitproject", path: "pi_projects" });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_LOCAL_UI_TEST_BROWSER });
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  const pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(origin + "/");
  await page.locator("#local-start:not([disabled])").waitFor();
  assert.match(await page.locator("#local-workspace").textContent(), /pi_projects/);
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
  await page.locator("#local-home").click();
  const directory = page.locator("#local-directories button").filter({ hasText: workspaceName });
  await directory.click(); await page.locator("#local-start:not([disabled])").waitFor();
  const submitted = page.waitForResponse(response => response.url() === origin + "/api/local/start" && response.request().method() === "POST");
  await page.locator("#local-start").click();
  const started = await (await submitted).json(); assert.equal(started.workspace.path, workspaceName); ownId = started.id; report.id = ownId; await save();
  await check("real browser: default selected, directory click selects, one Start click creates without tokens or approval pages");
  await page.waitForURL(url => /^\/s\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/$/.test(url.pathname), { timeout: 130000 });
  const ready = await until(async () => (await api("state")).runs.find(run => run.id === ownId && run.state === "ready"));
  assert.equal(new URL(page.url()).pathname, ready.path); report.sessionPath = ready.path;
  await check("exact new Pi is registered and browser automatically enters its ready session");
  const [container] = JSON.parse(docker("inspect", ownId)); report.containerId = container.Id;
  assert.equal(container.Config.User, "1000:1000");
  assert.equal(container.Config.Labels["cn.swordfate.pi.local-id"], ownId);
  for (const [target, name] of [["/home/node", "pi-user-home"], ["/home/node/.pi", "pi-home"], ["/home/node/.local", "pi-runtime"], ["/home/node/.credentials", "pi-credentials"], ["/home/node/.cache/huggingface", "pi-huggingface-cache"]]) {
    assert.equal(container.Mounts.find(mount => mount.Destination === target)?.Name, name);
  }
  assert.equal(container.Mounts.find(mount => mount.Destination === "/workspace")?.Source, workspace);
  assert.ok(container.HostConfig.CapDrop.includes("ALL")); assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.ok(!container.Mounts.some(mount => mount.Destination.endsWith("docker.sock")));
  report.attachmentMount = container.Mounts.find(mount => mount.Destination === "/workspace/.pi-attachments") ? "readonly workspace attachment bind" : "not enabled by original launcher on this host";
  if (report.attachmentMount.startsWith("readonly")) assert.equal(container.Mounts.find(mount => mount.Destination === "/workspace/.pi-attachments").RW, false);
  assert.ok(container.Mounts.some(mount => mount.Destination === "/home/node/.bashrc" && !mount.RW));
  await check("original pirun UID/caps, five persistent volumes, workspace, bashrc and attachment mount preserved; no Docker socket in Pi");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:18403" + ready.path + "ws", { origin, maxPayload: 64 * 1024 * 1024 });
    const timer = setTimeout(() => { ws.terminate(); reject(Error("state_sync timeout")); }, 15000);
    ws.on("error", error => { clearTimeout(timer); reject(error); });
    ws.on("message", data => { try { if (JSON.parse(data.toString()).event === "state_sync") { clearTimeout(timer); ws.close(); resolve(); } } catch {} });
  });
  await check("same-origin local WebSocket delivers state_sync, without sending a model prompt");
  await page.goto(origin + "/"); await page.locator("#local-start:not([disabled])").waitFor();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await mobile.goto(origin + "/"); await mobile.locator("#local-start:not([disabled])").waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mobile.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true }); await mobile.close();
  const row = page.locator("#local-runs li").filter({ hasText: ownId });
  page.once("dialog", dialog => dialog.accept()); await row.getByRole("button", { name: /停止/ }).click();
  await until(async () => (await api("state")).runs.find(run => run.id === ownId)?.state === "stopped", 30000);
  const after = snapshot(); for (const before of baseline) assert.deepEqual(after.find(item => item.id === before.id), before);
  assert.equal(pageErrors.length, 0); report.cleanup = "only the exact acceptance Pi stopped through local webpage; original shared volumes retained";
  report.completed = true; await check("desktop/mobile DOM and stop confirmation work; baseline containers unchanged and test Pi stopped");
} catch (error) {
  report.error = error.message; report.cleanup = "not confirmed; inspect exact id if present, never prune";
  if (ownId) { try { report.lastState = (await api("state")).runs.find(run => run.id === ownId); } catch {} }
  if (ownId) {
    try {
      await api("stop", { id: ownId });
      await until(async () => (await api("state")).runs.find(run => run.id === ownId)?.state === "stopped", 30000);
      report.cleanup = "exact acceptance Pi stopped after failure; shared volumes retained";
    } catch { /* Keep exact identity for trusted reconciliation. */ }
  }
  await save(); console.error("Local acceptance incomplete; see " + evidence + "/result.json"); process.exitCode = 1;
} finally { await browser?.close(); await save(); }

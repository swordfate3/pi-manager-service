/** Security-only browser fixture: untrusted Pi content, no real agent/model. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { initializeHub, issueSession, readHubConfig } from "../../hub/config.ts";
import { issueManagementCode } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

const directory = mkdtempSync(path.join(tmpdir(), "pi-hub-hostile-"));
const file = path.join(directory, "hub.json");
initializeHub(file, { port: 0 });
const config = readHubConfig(file);
config.management = { port: 0 };
const credentialFile = path.join(directory, "lifecycle.json");
writeFileSync(credentialFile, JSON.stringify({ token: "e".repeat(64) }), { mode: 0o600 });
let posts = 0;
const gate = http.createServer((req, res) => {
  if (req.method === "POST") posts++;
  res.writeHead(503).end();
});
await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
config.lifecycle = { endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`, credentialFile };
const hub = await startHub(config);
const capability = issueSession(config, path.join(directory, "run.json"), { label: "Synthetic hostile Pi" });
const generation = "b".repeat(32);
const backend = http.createServer((req, res) => {
  if (req.url === "/.pi-web-identity") {
    const challenge = req.headers["x-pi-web-challenge"];
    const proof = createHmac("sha256", capability.token).update(`${challenge}:${generation}`).digest("hex");
    res.writeHead(200).end(JSON.stringify({ generation, proof }));
    return;
  }
  if (req.url === "/worker.js") {
    res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" });
    res.end(`self.addEventListener('install',()=>self.skipWaiting());
      self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(Promise.resolve(new Response(
        '<!doctype html><title>Pi worker-controlled page</title><button id="open">Open management</button>',
        {headers:{'Content-Type':'text/html','Cross-Origin-Opener-Policy':'same-origin'}})));});`);
    return;
  }
  // Deliberately attempt to weaken policies; Hub must not trust these headers.
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Service-Worker-Allowed": "/",
    "Access-Control-Allow-Origin": "*",
    "x-pi-hub-csrf": "untrusted",
  });
  res.end("<!doctype html><title>Untrusted Pi content</title><button id='open'>Open management</button>");
});
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const registered = await new Promise<{ ok: boolean }>((resolve, reject) => {
    const socket = net.createConnection(config.socketPath, () =>
      socket.write(
        `${JSON.stringify({
          action: "register",
          ...capability,
          generation,
          port: (backend.address() as net.AddressInfo).port,
        })}\n`,
      ),
    );
    socket.on("data", (raw) => {
      socket.destroy();
      resolve(JSON.parse(raw.toString()));
    });
    socket.on("error", reject);
  });
  assert.equal(registered.ok, true);
  assert.ok(hub.managementUrl, "A distinct management listener is required");
  const admin = hub.managementUrl;
  assert.notEqual(new URL(admin).origin, new URL(hub.url).origin);
  browser = await chromium.launch({
    executablePath:
      process.env.PI_E2E_BROWSER_EXECUTABLE ||
      path.join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1208/chrome-linux64/chrome"),
  });
  const context = await browser.newContext();
  const trusted = await context.newPage();
  await trusted.goto(new URL("sessions/", admin).href);
  await trusted.locator(".management summary").click();
  await trusted.locator("#management-code").fill(issueManagementCode(config).code);
  await trusted.getByRole("button", { name: "解锁管理", exact: true }).click();
  await trusted.getByRole("button", { name: "锁定管理", exact: true }).waitFor();
  const hostile = await context.newPage();
  await hostile.goto(`${hub.url}s/${generation}/`);
  const probe = await hostile.evaluate(
    async ({ admin, generation }) => {
      const attempt = async (url: string, init?: RequestInit) => {
        try {
          const response = await fetch(url, { credentials: "include", ...init });
          return { readable: true, status: response.status, value: await response.text() };
        } catch {
          return { readable: false };
        }
      };
      return {
        status: await attempt(new URL("api/management/status", admin).href),
        target: await attempt(new URL(`api/management/targets/${generation}`, admin).href),
        restart: await attempt(new URL("api/management/restarts", admin).href, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pi-Hub-Csrf": "0".repeat(64) },
          body: JSON.stringify({
            generation,
            runtimeId: "old",
            sessionId: "saved",
            leafId: null,
            idempotencyKey: "c".repeat(32),
          }),
        }),
        local: await attempt("/api/management/status"),
      };
    },
    { admin, generation },
  );
  assert.equal(probe.status.readable, false);
  assert.equal(probe.target.readable, false);
  assert.equal(probe.restart.readable, false);
  assert.ok(!JSON.stringify(probe.local).includes('"authorized":true'));
  assert.ok(!JSON.stringify(probe.local).includes('"csrf":'));
  const worker = await hostile.evaluate(async (admin) => {
    const registration = await navigator.serviceWorker.register(new URL("worker.js", location.href).href, {
      scope: new URL("./", location.href).href,
    });
    await navigator.serviceWorker.ready;
    let crossOriginScope = false;
    try {
      await navigator.serviceWorker.register(new URL("worker.js", location.href).href, { scope: admin });
      crossOriginScope = true;
    } catch {
      /* Browser must reject a worker crossing the management origin. */
    }
    return { registered: !!registration.active, crossOriginScope };
  }, admin);
  assert.equal(worker.registered, true);
  assert.equal(worker.crossOriginScope, false);
  await hostile.reload();
  assert.match(await hostile.title(), /worker-controlled/);
  assert.equal(await trusted.evaluate(() => navigator.serviceWorker.controller === null), true);
  await hostile.evaluate((admin) => {
    const open = document.getElementById("open");
    if (!open) throw new Error("Synthetic Pi page is missing its popup probe");
    open.onclick = () => {
      const popup = window.open(new URL("sessions/", admin).href);
      (window as unknown as { adminPopup: Window | null }).adminPopup = popup;
    };
  }, admin);
  const popupReady = context.waitForEvent("page");
  await hostile.locator("#open").click();
  const popup = await popupReady;
  await popup.waitForLoadState();
  const readable = await hostile.evaluate(() => {
    try {
      return !!(window as unknown as { adminPopup: Window | null }).adminPopup?.document;
    } catch {
      return false;
    }
  });
  assert.equal(readable, false, "Pi popup/opener cannot inspect trusted management DOM");
  const cannotProxy = await context.request.get(new URL(`s/${generation}/`, admin).href);
  assert.ok(cannotProxy.status() >= 400, "Management origin must never serve Pi HTML");
  assert.equal(posts, 0);
  console.log(
    JSON.stringify({
      isolatedOrigins: true,
      secretReadableFromPi: false,
      unauthorizedPosts: posts,
      hostileWorkerIsolated: true,
      realBrowser: true,
      syntheticOnly: true,
    }),
  );
} finally {
  await browser?.close();
  await hub.close();
  backend.closeAllConnections();
  gate.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => backend.close(() => resolve())),
    new Promise<void>((resolve) => gate.close(() => resolve())),
  ]);
  rmSync(directory, { recursive: true, force: true });
}

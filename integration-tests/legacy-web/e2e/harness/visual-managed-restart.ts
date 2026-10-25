/** Visual-only fixture, not Pi E2E: temporary Hub with synthetic registration. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { initializeHub, issueSession, readHubConfig } from "../../hub/config.ts";
import { issueManagementCode } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

const directory = mkdtempSync(path.join(tmpdir(), "pi-hub-visual-"));
const output = path.resolve(".tmp/managed-restart-visual");
mkdirSync(output, { recursive: true });
const configFile = path.join(directory, "hub.json");
initializeHub(configFile, { port: 0 });
const config = readHubConfig(configFile);
config.management = { port: 0 };
const credentialFile = path.join(directory, "lifecycle.json");
writeFileSync(credentialFile, JSON.stringify({ token: "e".repeat(64) }), { mode: 0o600 });
const gate = http.createServer((_req, res) => res.writeHead(503).end());
await new Promise<void>((r) => gate.listen(0, "127.0.0.1", r));
config.lifecycle = { endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`, credentialFile };
const hub = await startHub(config);
const capability = issueSession(config, path.join(directory, "run.json"), { label: "项目 A · 运行更新验证" });
const generation = "a".repeat(32);
const backend = http.createServer((req, res) => {
  const challenge = req.headers["x-pi-web-challenge"];
  const proof = createHmac("sha256", capability.token).update(`${challenge}:${generation}`).digest("hex");
  res.writeHead(200).end(JSON.stringify({ generation, proof }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath:
    process.env.PI_E2E_BROWSER_EXECUTABLE ||
    path.join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1208/chrome-linux64/chrome"),
});
try {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(config.socketPath, () =>
      socket.write(
        `${JSON.stringify({
          action: "register",
          ...capability,
          generation,
          port: (backend.address() as net.AddressInfo).port,
          sessionName: "保存的开发会话 · 原分支",
          runtime: { runtimeId: "runtime-a", sessionId: "saved", leafId: "leaf", version: "1.1.0", managed: true },
        })}\n`,
      ),
    );
    socket.on("data", (raw) => {
      assert.equal(JSON.parse(raw.toString()).ok, true);
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const viewport of [
    { width: 1365, height: 1000 },
    { width: 390, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    assert.ok(hub.managementUrl);
    await page.goto(`${hub.managementUrl}sessions/`);
    await page.locator(".management summary").click();
    await page.getByText("已锁定", { exact: true }).waitFor();
    await page.locator(".card").waitFor();
    await page.screenshot({ path: path.join(output, `locked-${viewport.width}.png`), fullPage: true });
    const code = issueManagementCode(config).code;
    await page.locator("#management-code").fill(code);
    await page.getByRole("button", { name: "解锁管理", exact: true }).click();
    await page.getByRole("button", { name: "锁定管理", exact: true }).waitFor();
    await page.locator(".restart:enabled").waitFor();
    assert.equal(await page.locator("#management-code").inputValue(), "");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
    await page.screenshot({ path: path.join(output, `unlocked-${viewport.width}.png`), fullPage: true });
    // Visual-only historical-result projection. This route fixture proves
    // rendering, not lifecycle authorization or actual restart execution.
    const operation = "f".repeat(32);
    await page.route(`**/api/management/restarts/${operation}`, (route) =>
      route.fulfill({
        json: { id: operation, status: "succeeded", stage: "complete", new_version: "1.1.0" },
      }),
    );
    await page.evaluate(
      ({ id, generation }) =>
        sessionStorage.setItem("pi-hub-restarts", JSON.stringify([{ id, generation, label: "项目 A · 已完成的重启" }])),
      { id: operation, generation },
    );
    await page.reload();
    await page.locator(".management summary").click();
    await page.getByText(/重启已成功完成；当前恢复链接不可用/).waitFor();
    assert.equal(await page.locator(".restart-result a").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `historical-${viewport.width}.png`), fullPage: true });
    await page.unroute(`**/api/management/restarts/${operation}`);
    await page.getByRole("button", { name: "锁定管理", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ viewports: [1365, 390], screenshots: output, pageErrors: errors.length, syntheticOnly: true }),
  );
} finally {
  await browser.close();
  await hub.close();
  backend.closeAllConnections();
  gate.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => backend.close(() => r())),
    new Promise<void>((r) => gate.close(() => r())),
  ]);
  rmSync(directory, { recursive: true, force: true });
}

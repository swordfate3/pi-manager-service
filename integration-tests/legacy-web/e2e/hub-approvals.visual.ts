/** Rendered synthetic validation, not a real Pi/Gate deployment E2E. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { initializeHub, readHubConfig } from "../hub/config.ts";
import { issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

test("synthetic approval portal renders and confirms on desktop and phone", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-approvals-visual-"));
  const screenshots = path.resolve(".tmp/hub-approvals-visual");
  mkdirSync(screenshots, { recursive: true });
  const task = {
    kind: "deployment",
    id: "a".repeat(32),
    revision: "b".repeat(64),
    title: "Deploy pi-web-hub",
    target: "pi-web-hub",
    status: "pending",
    stage: "awaiting_approval",
    commit: "c".repeat(40),
    plan_hash: "d".repeat(64),
    actions: ["approve", "reject"],
  };
  const policy = { kind: "service", id: "pi-web-hub", revision: "e".repeat(64), mode: "manual", paused: true };
  let writes = 0;
  let overviewReads = 0;
  const gate = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/hub-management") overviewReads++;
    let value: unknown = { tasks: [task], policies: [policy] };
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      writes++;
      value = { decision_id: body.decision_id, status: "recorded" };
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const file = path.join(directory, "hub.json");
    initializeHub(file, { port: 0, management: { port: 0 } });
    const credentialFile = path.join(directory, "gate.json");
    writeFileSync(credentialFile, JSON.stringify({ token: "f".repeat(64) }), { mode: 0o600 });
    const config = readHubConfig(file);
    config.gateManagement = {
      endpoint: `http://127.0.0.1:${(gate.address() as net.AddressInfo).port}`,
      credentialFile,
    };
    hub = await startHub(config, { versions: { source: async () => ({}) } });
    assert.ok(hub.managementUrl);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PI_E2E_BROWSER_EXECUTABLE ? { executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE } : {}),
    });
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["phone", 390, 844],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${hub.managementUrl}sessions/`);
      await page.locator("details.management > summary").click();
      await page.locator("#management-code").fill(issueManagementCode(config).code);
      await page.locator("#management-unlock button").click();
      await expect(page.locator("#approvals-tasks")).toContainText("Deploy pi-web-hub");
      await page.locator("#approvals").scrollIntoViewIfNeeded();
      await page.locator("#approvals-tasks details > summary").click();
      const select = page.locator("#approvals-policy-service-pi-web-hub");
      await select.selectOption("auto");
      const initialReads = overviewReads;
      await expect.poll(() => overviewReads, { timeout: 10000 }).toBeGreaterThanOrEqual(initialReads + 2);
      await expect(select).toHaveValue("auto");
      await expect(page.locator("#approvals-tasks details")).toHaveAttribute("open", "");
      await page.locator("#approvals").screenshot({ path: path.join(screenshots, `${name}-approvals.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const approve = page.getByRole("button", { name: "批准", exact: true });
      const box = await approve.boundingBox();
      assert.ok(box && box.width > 40 && box.x >= 0 && box.x + box.width <= width);
      page.once("dialog", async (dialog) => {
        assert.ok(dialog.message().includes(task.revision));
        await dialog.accept();
      });
      await approve.click();
      await expect(page.locator("#approvals-result")).toContainText("已记录");
      await page.locator("#management-logout").click();
      await expect(page.locator("#approvals-tasks")).toBeEmpty();
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.equal(writes, 2);
    console.log("Rendered validation: desktop 1440x1000, phone 390x844; synthetic tasks only.");
  } finally {
    await browser?.close();
    await hub?.close();
    gate.closeAllConnections();
    if (gate.listening) await new Promise<void>((resolve) => gate.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

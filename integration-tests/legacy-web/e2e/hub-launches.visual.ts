/** Synthetic rendered validation; does not claim real Docker/Pi E2E. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

test("synthetic New Pi directory picker and progress render on desktop and phone", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-launches-visual-"));
  const screenshots = path.resolve(".tmp/hub-launches-visual");
  mkdirSync(screenshots, { recursive: true });
  const jobs: Record<string, unknown>[] = [];
  let writes = 0;
  const gate = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://gate.invalid");
    let value: unknown = { tasks: [], policies: [] };
    if (url.pathname.endsWith("/launch-config"))
      value = {
        enabled: true,
        rootLabel: "gitproject",
        defaultPath: "pi_projects",
        revision: "a".repeat(64),
        maxActive: 16,
      };
    if (url.pathname.endsWith("/workspaces")) {
      const selected = url.searchParams.get("path") ?? "";
      const children = selected === "pi_projects" ? ["project-a", "手机项目"] : selected === "" ? ["pi_projects"] : [];
      value = {
        path: selected,
        parent: selected === "" ? null : selected.split("/").slice(0, -1).join("/"),
        revision: "b".repeat(64),
        entries: children.map((name) => ({ name, path: `${selected ? `${selected}/` : ""}${name}` })),
        truncated: false,
      };
    }
    if (url.pathname.endsWith("/launches")) {
      value = { jobs };
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        writes++;
        value = {
          id: body.id,
          path: body.path,
          label: body.label,
          status: "running",
          stage: "running",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        jobs.unshift(value as Record<string, unknown>);
      }
    } else if (/\/launches\/[a-f0-9]{32}$/.test(url.pathname))
      value = jobs.find((job) => url.pathname.endsWith(String(job.id)));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let registration: ReturnType<typeof createSessionRegistration> | undefined;
  let backend: http.Server | undefined;
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
    const runFile = path.join(directory, "run.json");
    const grant = issueSession(config, runFile, { label: "Synthetic visual registration" });
    registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile: runFile });
    backend = http.createServer((request, response) => {
      if (registration?.guard(request, response)) response.end("Synthetic session");
    });
    await new Promise<void>((resolve) => backend?.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PI_E2E_BROWSER_EXECUTABLE ? { executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE } : {}),
    });
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["phone", 390, 844],
    ] as const) {
      jobs.length = 0;
      const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${hub.managementUrl}sessions/#new-pi`);
      await page.locator("#management-code").fill(issueManagementCode(config).code);
      await page.locator("#management-unlock button").click();
      await expect(page.locator("#launch-current")).toHaveText("gitproject/pi_projects");
      await page.getByRole("button", { name: "打开 project-a", exact: true }).click();
      await expect(page.locator("#launch-current")).toHaveText("gitproject/pi_projects/project-a");
      await page.locator("#launch-name").fill("手机代码开发");
      const previous = writes;
      await page.locator("#launch-refresh").click();
      await expect(page.locator("#launch-name")).toHaveValue("手机代码开发");
      await expect(page.locator("#launch-current")).toHaveText("gitproject/pi_projects/project-a");
      await page.locator("#new-pi").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-picker.png`) });
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /gitproject\/pi_projects\/project-a/);
        assert.match(dialog.message(), /手机代码开发/);
        await dialog.accept();
      });
      await page.locator("#launch-start").click();
      await expect(page.locator("#launch-jobs")).toContainText("等待会话登记");
      assert.equal(writes, previous + 1);
      await page.locator("#new-pi").screenshot({ path: path.join(screenshots, `${name}-waiting.png`) });
      jobs[0].run_id = grant.run_id;
      await registration.start((backend.address() as net.AddressInfo).port, () => {});
      await page.locator("#launch-refresh").click();
      const link = page.getByRole("link", { name: "进入会话 ↗" });
      await expect(link).toBeVisible();
      assert.equal(new URL((await link.getAttribute("href")) as string).origin, new URL(hub.url).origin);
      await page.locator("#new-pi").screenshot({ path: path.join(screenshots, `${name}-registered.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator("#management-logout").click();
      await expect(page.locator("#launch-jobs")).toBeEmpty();
      await expect(page.locator("#launch-current")).toBeEmpty();
      await page.screenshot({ path: path.join(screenshots, `${name}-locked.png`) });
      assert.deepEqual(errors, []);
      await context.close();
      await registration.stop();
    }
  } finally {
    await browser?.close();
    await registration?.stop();
    backend?.closeAllConnections();
    if (backend?.listening) await new Promise<void>((resolve) => backend?.close(() => resolve()));
    await hub?.close();
    gate.closeAllConnections();
    if (gate.listening) await new Promise<void>((resolve) => gate.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

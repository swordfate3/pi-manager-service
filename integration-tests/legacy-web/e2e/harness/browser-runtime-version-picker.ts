/** Opt-in real Hub/Gate/Pi driver. No browser state, API or WebSocket mocks. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input) as {
  adminUrl: string;
  chatUrl: string;
  code: string;
  version: string;
  runs: string[];
  paths: string[];
  busyGeneration?: string;
  expectRefusal?: boolean;
  screenshotDir: string;
};
assert.match(config.version, /^\d+\.\d+\.\d+$/);
const output = path.resolve(config.screenshotDir);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
const diagnostics: unknown[] = [];
try {
  const errors: string[] = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push({ type: "console", text: message.text() });
    });
    page.on("requestfailed", (request) =>
      diagnostics.push({ type: "requestfailed", url: request.url(), error: request.failure()?.errorText }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        diagnostics.push({ type: "response", url: response.url(), status: response.status() });
    });
    page.on("websocket", (socket) => {
      diagnostics.push({ type: "websocket", url: socket.url() });
      socket.on("socketerror", (error) => diagnostics.push({ type: "socketerror", error }));
    });
  });
  const chats = [];
  for (const run of config.runs) {
    const page = await context.newPage();
    const record = { page, connections: 0 };
    page.on("websocket", () => {
      record.connections++;
    });
    await page.goto(new URL(config.paths[config.runs.indexOf(run)], config.chatUrl).href);
    await page.getByText("Synthetic saved reply", { exact: true }).first().waitFor();
    chats.push(record);
  }
  if (config.busyGeneration) {
    const chat = chats[config.runs.indexOf(config.busyGeneration)]?.page;
    assert.ok(chat, "busy generation must use an already observed real session");
    const prompt = chat.locator("textarea");
    await prompt.fill("WAIT_FOR_RUNTIME_ACCEPTANCE");
    await prompt.press("Enter");
  }
  const admin = await context.newPage();
  await admin.goto(new URL("sessions/", config.adminUrl).href);
  await admin.locator(".management summary").click();
  await admin.locator("#management-code").fill(config.code);
  await admin.getByRole("button", { name: "解锁管理", exact: true }).click();
  await admin.getByRole("button", { name: "锁定管理", exact: true }).waitFor();
  await admin.locator("#runtime-version-search").fill(config.version);
  await admin.getByRole("button", { name: `Pi ${config.version} · 已发布 / 未验证`, exact: true }).click();
  await admin.locator("#runtime-update-submit:enabled").waitFor({ timeout: 30_000 });
  await admin.screenshot({ path: path.join(output, `selected-${config.version}-desktop.png`), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 1000 });
  await admin.screenshot({ path: path.join(output, `selected-${config.version}-mobile.png`), fullPage: true });
  assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  admin.once("dialog", (dialog) => dialog.accept());
  const submitted = admin.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/management/runtime-updates" && response.request().method() === "POST",
  );
  await admin.locator("#runtime-update-submit").click();
  const response = await submitted;
  assert.equal(response.status(), 202);
  const accepted = await response.json();
  assert.equal(accepted.version, config.version);
  assert.match(accepted.id, /^[a-f0-9]{32}$/);
  console.log(JSON.stringify({ event: "submitted", id: accepted.id, version: config.version }));
  await admin.waitForFunction(
    (jobId) =>
      [...document.querySelectorAll(".runtime-update-result")].some((row) => {
        const text = row.textContent ?? "";
        return (
          text.includes(jobId) && /所有受管 Pi 进程已刷新或退出|安装失败|结果不确定|任务已拒绝|任务已过期/.test(text)
        );
      }),
    accepted.id,
    { timeout: 300_000 },
  );
  const text = (await admin.locator(".runtime-update-result").allTextContents()).filter((row) =>
    row.includes(accepted.id),
  );
  await admin.screenshot({ path: path.join(output, `result-${config.version}-mobile.png`), fullPage: true });
  if (config.expectRefusal) {
    assert.ok(
      text.some((line) => line.includes("会话恢复验证未通过；原进程未停止")),
      text.join("\n"),
    );
    assert.deepEqual(errors, []);
    for (const chat of chats) {
      await chat.page.getByText("Synthetic saved reply", { exact: true }).first().waitFor();
      assert.equal(chat.connections, 1, "an incompatible target must not stop or replace the original connection");
    }
    console.log(JSON.stringify({ event: "refused", id: accepted.id, version: config.version, pageErrors: 0 }));
  } else {
    assert.ok(
      text.some((line) => line.includes("所有受管 Pi 进程已刷新或退出")),
      text.join("\n"),
    );
    assert.deepEqual(errors, []);
    for (const chat of chats) {
      await chat.page.locator('[title="已连接"], [title="connected"]').first().waitFor({ timeout: 30_000 });
      await chat.page.getByText("Synthetic saved reply", { exact: true }).first().waitFor();
      assert.ok(chat.connections >= 2, "the existing chat page must reconnect after actual Pi refresh");
    }
    console.log(JSON.stringify({ event: "complete", id: accepted.id, version: config.version, pageErrors: 0 }));
  }
} catch (error) {
  for (const [index, page] of context.pages().entries()) {
    await page.screenshot({ path: path.join(output, `failure-${config.version}-${index}.png`), fullPage: true });
    diagnostics.push({ type: "page", url: page.url(), text: await page.locator("body").innerText() });
  }
  writeFileSync(path.join(output, `failure-${config.version}.json`), JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  await browser.close();
}

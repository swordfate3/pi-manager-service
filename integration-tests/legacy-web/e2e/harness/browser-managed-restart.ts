/** Real-browser driver for test-managed-gate.py; all credentials/state are synthetic. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { isHubSessionPath } from "../../extensions/hub-generation.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input) as {
  adminUrl: string;
  chatUrl: string;
  generation: string;
  code: string;
  label: string;
};
const output = path.resolve(".tmp/managed-restart-browser");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PI_E2E_BROWSER_EXECUTABLE ||
    path.join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1208/chrome-linux64/chrome"),
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  const errors: string[] = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  const chat = await context.newPage();
  const previousUrl = new URL(`s/${config.generation}/`, config.chatUrl).href;
  await chat.goto(previousUrl);
  await chat.getByText("Synthetic saved reply", { exact: true }).waitFor();
  const admin = await context.newPage();
  await admin.goto(new URL("sessions/", config.adminUrl).href);
  await admin.locator(".management summary").click();
  await admin.locator("#management-code").fill(config.code);
  await admin.getByRole("button", { name: "解锁管理", exact: true }).click();
  await admin.getByRole("button", { name: "锁定管理", exact: true }).waitFor();
  const card = admin.locator(".card").filter({ hasText: config.label });
  await card.locator(".restart:enabled").waitFor();
  await admin.screenshot({ path: path.join(output, "management-mobile.png"), fullPage: true });
  const confirmation = admin.waitForEvent("dialog");
  const submitted = admin.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/management/restarts" && response.request().method() === "POST",
  );
  const click = card.locator(".restart").click();
  const dialog = await confirmation;
  assert.equal(dialog.type(), "confirm");
  assert.ok(dialog.message().includes(config.label));
  await dialog.accept();
  await click;
  const response = await submitted;
  assert.equal(response.status(), 202);
  const accepted = (await response.json()) as { id: string };
  assert.match(accepted.id, /^[a-f0-9]{32}$/);
  const restored = admin.locator(".restart-result").filter({ hasText: "已恢复原会话" });
  try {
    await admin.waitForFunction(
      () =>
        [...document.querySelectorAll(".restart-result")].some((row) =>
          /已恢复原会话|结果不确定|失败，请检查|已拒绝|身份或授权已变化/.test(row.textContent ?? ""),
        ),
      null,
      { timeout: 45_000 },
    );
    assert.ok(await restored.getByRole("link", { name: "打开恢复后的会话 ↗", exact: true }).isVisible());
  } catch {
    await admin.screenshot({ path: path.join(output, "failure-management-mobile.png"), fullPage: true });
    throw new Error(
      `Synthetic restart did not restore: ${(await admin.locator(".restart-result").allTextContents()).join(" ").slice(0, 1200)}`,
    );
  }
  await chat.waitForURL((url) => url.href !== previousUrl && isHubSessionPath(url.pathname), {
    timeout: 45_000,
  });
  await chat.getByText("Synthetic saved reply", { exact: true }).waitFor();
  assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await admin.screenshot({ path: path.join(output, "restored-management-mobile.png"), fullPage: true });
  await chat.screenshot({ path: path.join(output, "restored-chat-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ id: accepted.id, browserRecovery: true, viewport: 390, pageErrors: errors.length }));
} finally {
  await browser.close();
}

import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { mathFormattingPrompt } from "../fixtures/math-formatting-data";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: import("@playwright/test").BrowserContext | null = null;
let mathPage: import("@playwright/test").Page | null = null;
let historySynced = false;

function page() {
  if (!mathPage) throw new Error("Math-formatting E2E page is not initialized");
  return mathPage;
}

When("我打开数学公式真实 Pi Web UI", async ({ browser }) => {
  harness = await startPiWebUi("math-formatting");
  context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  mathPage = await context.newPage();
  historySynced = false;
  page().on("websocket", (socket) => {
    const syncIds = new Set<string>();
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "req" && message.method === "sync_request") syncIds.add(message.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type !== "res" || !syncIds.delete(message.id) || !message.ok) return;
      if (
        message.result?.isStreaming === false &&
        JSON.stringify(message.result.entries).includes("MATH_ASSISTANT_MARKER")
      )
        historySynced = true;
    });
  });
  await page().goto(harness.pageUrl);
  await expect(page().getByTestId("message-input")).toBeVisible();
});

When("我发送数学公式用户消息", async () => {
  await page().getByTestId("message-input").fill(mathFormattingPrompt);
  await page().getByTestId("submit-message").click();
  const log = page().getByRole("log");
  await expect(log).toContainText("MATH_ASSISTANT_MARKER", { timeout: 30_000 });
  // The settled snapshot replaces the live row; expand only after it arrives.
  await expect.poll(() => historySynced).toBe(true);
});

Then("用户消息中的 TeX 公式已渲染且代码和金额原样保留", async () => {
  const userRow = page().locator('[data-chat-item-kind="message"]').filter({ hasText: "MATH_USER_MARKER" });
  await expect(userRow.locator(".katex").first()).toBeVisible();
  await expect(userRow.locator(".katex-display .katex")).toBeVisible();
  await expect(userRow.locator("code")).toHaveText(String.raw`\(ignored\)`);
  await expect(userRow).toContainText("$5 USD");
  await expect(userRow.locator(".katex")).toHaveCount(2);
});

Then("助手消息中的 TeX 和美元公式均已渲染", async () => {
  const assistantRow = page().locator('[data-chat-item-kind="message"]').filter({ hasText: "MATH_ASSISTANT_MARKER" });
  await expect(assistantRow.locator(".katex-display .katex")).toBeVisible();
  await expect(assistantRow.locator(".katex")).toHaveCount(3);
  await expect(assistantRow.locator(".katex").last()).toContainText("x2");
  await expect(assistantRow).toContainText("$5 USD");
});

Then("展开思考区后公式已渲染且代码和金额原样保留", async ({ $testInfo }) => {
  const trigger = page().getByRole("log").locator('button[data-slot="collapsible-trigger"]');
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  const content = page().getByRole("log").locator('[data-slot="collapsible-content"]');
  await expect(content).toContainText("MATH_THINKING_MARKER");
  await expect(content.locator(".katex")).toHaveCount(3);
  await expect(content.locator(".katex-display .katex")).toBeVisible();
  await expect(content.locator("code")).toHaveText(String.raw`\(ignored\)`);
  await expect(content).toContainText("$5 USD");
  await content.scrollIntoViewIfNeeded();
  await page().screenshot({ path: $testInfo.outputPath("math-reasoning-desktop.png"), fullPage: true });
});

When("我切换到窄屏视口验证数学公式", async () => {
  await page().setViewportSize({ width: 390, height: 844 });
});

Then("数学公式不会撑宽消息容器", async ({ $testInfo }) => {
  const userRow = page().locator('[data-chat-item-kind="message"]').filter({ hasText: "MATH_USER_MARKER" });
  const display = userRow.locator(".katex-display");
  await expect(display).toBeVisible();
  const width = await display.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(width.client).toBeLessThanOrEqual(width.viewport);
  expect(width.scroll).toBeGreaterThanOrEqual(width.client);
  const pageWidth = await page().evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.width);
  const thinking = page().getByRole("log").locator('[data-slot="collapsible-content"]');
  await expect(thinking.locator(".katex")).toHaveCount(3);
  const thinkingWidth = await thinking.locator(".katex-display").evaluate((element) => element.clientWidth);
  expect(thinkingWidth).toBeLessThanOrEqual(pageWidth.width);
  await thinking.scrollIntoViewIfNeeded();
  await page().screenshot({ path: $testInfo.outputPath("math-reasoning-mobile.png"), fullPage: true });
});

After(async () => {
  await context?.close();
  context = null;
  mathPage = null;
  await harness?.stop();
  harness = null;
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: import("@playwright/test").BrowserContext | null = null;
let languagePage: import("@playwright/test").Page | null = null;
let expectedSessionId: string | undefined;
let markdownHistorySynced = false;

function page() {
  if (!languagePage) throw new Error("Language E2E browser page is not initialized");
  return languagePage;
}

async function start(
  browser: import("@playwright/test").Browser,
  locale: string,
  mobile = false,
  fixture = "chat-lifecycle",
) {
  harness = await startPiWebUi(fixture);
  context = await browser.newContext({
    locale,
    ...(mobile ? { ...({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const) } : {}),
  });
  languagePage = await context.newPage();
  markdownHistorySynced = false;
  if (fixture === "language-markdown") {
    // Observe the real transport: the live row is replaced by the settled
    // history snapshot. Opening its modal before that replacement loses it.
    page().on("websocket", (socket) => {
      const syncIds = new Set<string>();
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "req" && message.method === "sync_request") syncIds.add(message.id);
      });
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type !== "res" || !syncIds.delete(message.id) || !message.ok) return;
        const result = message.result;
        if (result?.isStreaming === false && JSON.stringify(result.entries).includes("MARKDOWN_RAW_CONTENT_42")) {
          markdownHistorySynced = true;
        }
      });
    });
  }
  await page().goto(harness.pageUrl);
  await expect(page().getByTestId("message-input")).toBeVisible();
}

When("我打开中文语言的真实 Pi Web UI", async ({ browser }) => start(browser, "zh-CN"));
When("我打开移动端中文语言的真实 Pi Web UI", async ({ browser }) => start(browser, "zh-CN", true));
When("我打开中文浏览器首访的真实 Pi Web UI", async ({ browser }) => start(browser, "zh-CN"));
When("我打开英文浏览器首访的真实 Pi Web UI", async ({ browser }) => start(browser, "en-US"));
When("我打开含 Markdown 回复的真实 Pi Web UI", async ({ browser }) =>
  start(browser, "en-US", false, "language-markdown"),
);

When("我接收 Markdown 原文回复", async () => {
  await page().getByTestId("message-input").fill("Please provide the original markdown.");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("MARKDOWN_RAW_CONTENT_42");
  await expect.poll(() => markdownHistorySynced).toBe(true);
  await expect(page().getByRole("log").getByRole("button", { name: "Copy Code", exact: true })).toBeVisible();
});

Then("已有 Markdown 的控件变为中文但正文保持原样", async () => {
  await page().keyboard.press("Escape");
  const log = page().getByRole("log");
  await expect(log.getByRole("button", { name: "Copy Code", exact: true })).toHaveCount(0);
  await expect(log.getByRole("button", { name: /复制代码/ })).toBeVisible();
  await expect(log).toContainText('const RAW_CODE_42 = "Keep this English string";');
  await expect(log).toContainText("Keep this English table");
  // File links and external links now share the stable confirmation boundary.
  await log.getByRole("link", { name: "External raw URL", exact: true }).click();
  const safety = page().getByRole("dialog", { name: "打开外部链接？" });
  await expect(safety).toContainText("https://example.com/raw-language-42");
  await expect(safety.getByRole("button", { name: "复制链接", exact: true })).toBeVisible();
  await page().keyboard.press("Escape");
});

Then("已有 Markdown 的控件恢复英文且正文保持原样", async () => {
  await page().keyboard.press("Escape");
  const log = page().getByRole("log");
  await expect(log.getByRole("button", { name: "Copy Code", exact: true })).toBeVisible();
  await expect(log).toContainText('const RAW_CODE_42 = "Keep this English string";');
});

When("我保存无效语言偏好并刷新", async () => {
  await page().evaluate(() => localStorage.setItem("pi-web-ui-language", "invalid-language"));
  await page().reload();
  await expect(page().getByTestId("message-input")).toBeVisible();
});

When("我打开语言设置", async () => {
  await page().getByTestId("open-settings").click();
  await expect(page().getByTestId("language-zh-CN")).toBeVisible();
  await expect(page().getByTestId("language-en")).toBeVisible();
});

When("我保留草稿并切换语言为 {string}", async ({ page: _stepPage }, language: string) => {
  if (await page().getByRole("dialog").count()) await page().keyboard.press("Escape");
  await page().getByTestId("message-input").fill("DRAFT_MUST_SURVIVE_LANGUAGE_SWITCH");
  await selectLanguage(language);
});

When("我切换语言为 {string}", async ({ page: _stepPage }, language: string) => selectLanguage(language));

async function selectLanguage(language: string) {
  const option = page().getByTestId(language === "English" ? "language-en" : "language-zh-CN");
  if (!(await option.isVisible())) await page().getByTestId("open-settings").click();
  await option.click();
}

When("我刷新语言页面", async () => {
  await page().reload();
  await expect(page().getByTestId("message-input")).toBeVisible();
});

When("我发送原文为 {string}", async ({ page: _stepPage }, text: string) => {
  const input = page().getByTestId("message-input");
  await input.fill(text);
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log").getByText(text, { exact: true })).toBeVisible();
  await expect.poll(() => sessionEvidence(text)).toBeDefined();
  expect(sessionEvidence(text)?.id).toBe(expectedSessionId);
});

Then("页面语言为 {string} 且界面含中文", async ({ page: _stepPage }, lang: string) => {
  await expect(page().locator("html")).toHaveAttribute("lang", lang);
  const text = await page().locator("body").innerText();
  expect(text).toMatch(/[\u3400-\u9fff]/);
  expect(text).not.toContain("Open settings");
  expect(text).not.toContain("Message Pi...");
});

Then("页面语言为 {string} 且界面含英文", async ({ page: _stepPage }, lang: string) => {
  await expect(page().locator("html")).toHaveAttribute("lang", lang);
  await expect(page().getByTestId("message-input")).toHaveAttribute("placeholder", "Message Pi...");
  if (!(await page().getByTestId("language-en").isVisible())) {
    await page().getByTestId("open-settings").click();
  }
  await expect(page().getByRole("dialog")).toContainText("Settings");
  await page().keyboard.press("Escape");
});

When("我验证中文侧边栏和工作区状态", async () => {
  await page().getByTestId("toggle-left-sidebar").click();
  const sidebar = page().locator('[data-slot="sidebar"][data-mobile="true"], [data-slot="sidebar-inner"]');
  await expect(sidebar).toBeVisible();
  expect(await sidebar.innerText()).toMatch(/[\u3400-\u9fff]/);
  await sidebar.locator('[data-sidebar="trigger"]').click();
  await page().getByTestId("open-workspace-status").click();
  const workspace = page().getByTestId("workspace-status-float");
  await expect(workspace).toBeVisible();
  expect(await workspace.innerText()).toMatch(/[\u3400-\u9fff]/);
  await page().keyboard.press("Escape");
});

Then("语言偏好已持久化为 {string}", async ({ page: _stepPage }, language: string) => {
  await expect.poll(() => page().evaluate(() => localStorage.getItem("pi-web-ui-language"))).toBe(language);
});

Then("语言设置提供 {string} 和 {string}", async ({ page: _stepPage }, first: string, second: string) => {
  await expect(page().getByTestId("language-zh-CN")).toContainText(first);
  await expect(page().getByTestId("language-en")).toContainText(second);
});

Then("草稿仍然是 {string}", async ({ page: _stepPage }, text: string) => {
  await expect(page().getByTestId("message-input")).toHaveValue(text);
});

Then("我记录初始 Pi 会话身份", async ({ page: _stepPage }) => {
  // Pi persists a new session lazily on its first message, not on page load.
  await page().getByTestId("message-input").fill("LANGUAGE_INITIAL_SESSION_MARKER");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  await expect.poll(() => sessionEvidence("LANGUAGE_INITIAL_SESSION_MARKER")?.id).toBeTruthy();
  expectedSessionId = sessionEvidence("LANGUAGE_INITIAL_SESSION_MARKER")?.id;
  expect(expectedSessionId, "Pi session should exist in the real session directory").toBeTruthy();
});

Then("普通原文和 Pi 会话身份保持不变", async ({ page: _stepPage }) => {
  const text = "Please preserve this English prompt: RAW_PROMPT_English_42";
  await expect(page().getByRole("log").getByText(text, { exact: true })).toBeVisible();
  const evidence = sessionEvidence(text);
  expect(evidence?.id).toBeTruthy();
  expect(evidence?.id).toBe(expectedSessionId);
  expect(evidence?.contents).toContain(text);
  expect(sessionFiles().filter((session) => session.contents.includes(text))).toHaveLength(1);
});

function sessionFiles(): Array<{ id: string; contents: string }> {
  if (!harness) return [];
  const sessionDir = harness.sessionDir;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name.endsWith(".jsonl") ? [file] : [];
    });
  return walk(sessionDir).flatMap((file) => {
    const contents = readFileSync(file, "utf8");
    try {
      const header = JSON.parse(contents.split("\n", 1)[0] ?? "{}") as { id?: unknown };
      return typeof header.id === "string" ? [{ id: header.id, contents }] : [];
    } catch {
      return [];
    }
  });
}

function sessionEvidence(text: string) {
  return sessionFiles().find((session) => session.contents.includes(text));
}

After(async () => {
  await context?.close();
  context = null;
  languagePage = null;
  await harness?.stop();
  harness = null;
  expectedSessionId = undefined;
});

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { line, multiline } from "../fixtures/large-tool-data";
import { configurePerformanceFixture, getActiveHarness } from "./workspace-status.steps";

const { Given, When, Then } = createBdd();
const outputDir = process.env.PI_E2E_PERF_OUTPUT || path.resolve(__dirname, "../../.tmp/performance");
const logPath = path.join(outputDir, `perf-${process.env.PI_E2E_REPORT || "run"}.jsonl`);

function record(data: Record<string, unknown>) {
  mkdirSync(outputDir, { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...data })}\n`);
}

Given("性能测试长会话 fixture 已准备", async ({ page }) => {
  configurePerformanceFixture("chat-lifecycle");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    const w = window as Window & { __longTasks?: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks?.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
});

Given("大型工具输出性能 fixture 已准备", async () => configurePerformanceFixture("large-tool-output"));

Then("侧栏展开与收起性能已记录", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("LONG_SESSION_END_MARKER_7e91f4", { timeout: 60_000 });
  // Separate initial history loading from the interaction under measurement.
  await page.waitForTimeout(1000);
  const button = page.getByTestId("toggle-left-sidebar");
  const search = page.getByPlaceholder("Search conversation...");
  const samples: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 2; index += 1) {
    if (await search.isVisible()) await button.click();
    await expect(search).toBeHidden();
    await page.evaluate(() => {
      (window as Window & { __longTasks?: number[] }).__longTasks = [];
    });
    const start = await page.evaluate(() => performance.now());
    await button.click();
    await expect(search).toBeVisible();
    const clickToVisibleMs = await page.evaluate((t) => performance.now() - t, start);
    const settledMs = await page.evaluate(async (t) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return performance.now() - t;
    }, start);
    if (index === 0) {
      await page.screenshot({
        path: path.join(outputDir, `perf-${process.env.PI_E2E_REPORT || "run"}-sidebar-open.png`),
        fullPage: false,
      });
    }
    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-tree-entry-id]").length,
      longTasks: ((window as Window & { __longTasks?: number[] }).__longTasks || []).slice(),
    }));
    samples.push({ repetition: index + 1, clickToSearchVisibleMs: clickToVisibleMs, doubleRafMs: settledMs, ...stats });
    if (index === 0) await button.click();
  }
  record({
    kind: "sidebar-toggle-baseline",
    release: process.env.PI_E2E_RUNTIME_DIR || "repo",
    viewport: { width: 1440, height: 1000 },
    historyMessages: 6000,
    samples,
  });
});

Then("虚拟侧栏滚轮移出后保留键盘焦点", async ({ page }) => {
  const viewport = page.locator('[data-tree-viewport="true"]');
  const focused = page.locator("[data-tree-entry-id]").first();
  const id = await focused.getAttribute("data-tree-entry-id");
  await focused.focus();
  await viewport.hover();
  await page.mouse.wheel(0, -40000);
  await page.waitForTimeout(250);
  const retained = page.locator(`[data-tree-entry-id="${id}"]`);
  await expect(retained).toBeFocused();
  await retained.press("ArrowUp");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-tree-entry-id"))).not.toBe(id);
  expect(await page.locator("[data-tree-entry-id]").count()).toBeLessThan(300);
});

Then("大型工具展开与收起指标已记录", async ({ page }) => {
  const samples: Array<Record<string, unknown>> = [];
  const header = page.getByRole("button", { name: "Completed write large-single.txt", exact: true });
  for (let index = 0; index < 2; index += 1) {
    const start = await page.evaluate(() => performance.now());
    await header.click();
    const parameters = page.getByText("Parameters", { exact: true }).first();
    await expect(parameters).toBeVisible();
    const openedMs = await page.evaluate(async (t) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return performance.now() - t;
    }, start);
    const closeStart = await page.evaluate(() => performance.now());
    await header.click();
    await expect(parameters).toBeHidden();
    const closedMs = await page.evaluate((t) => performance.now() - t, closeStart);
    samples.push({ repetition: index + 1, openedDoubleRafMs: openedMs, closedMs });
  }
  record({ kind: "large-tool-toggle", release: process.env.PI_E2E_RUNTIME_DIR || "repo", samples });
});

Then("搜索可见后侧栏行数有界", async ({ page }) => {
  const rows = await page.locator("[data-tree-entry-id]").count();
  expect(rows).toBeLessThan(6000);
});

When("我让 agent 执行大型真实工具输出", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("Run the large output fixture with real write and read tools.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(
    page.getByRole("log").getByText("Large output fixture completed with real write and read tools."),
  ).toBeVisible({ timeout: 90_000 });
  // Agent-settled schedules a real full snapshot. Do not click a transient live
  // row while history reconciliation is replacing its identity.
  await page.waitForTimeout(1000);
});

Then("优化后侧栏可见行数有界", async ({ page }) => {
  const button = page.getByTestId("toggle-left-sidebar");
  const search = page.getByPlaceholder("Search conversation...");
  if (!(await search.isVisible())) await button.click();
  await expect(search).toBeVisible();
  const rows = await page.locator("[data-tree-entry-id]").count();
  record({ kind: "optimized-sidebar-mounted-rows", rows, expectedBound: 300, viewport: { width: 1440, height: 1000 } });
  expect(rows).toBeLessThan(300);
});

Then("大型工具历史预览有界且原文件保持完整", async ({ page, context }) => {
  const harness = getActiveHarness();
  if (!harness) throw new Error("No performance Pi harness");
  expect(readFileSync(path.join(harness.workspaceDir, "large-single.txt"), "utf8")).toBe(line);
  expect(readFileSync(path.join(harness.workspaceDir, "large-multiline.txt"), "utf8")).toBe(multiline);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const rows = page.locator('[data-chat-item-kind="tool"]');
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole("region", { name: "Conversation history" })).toContainText(
    "Large entries are bounded previews. Full data remains in the original session.",
  );
  const samples: Array<Record<string, unknown>> = [];
  for (const [index, expected] of [
    [0, line],
    [2, multiline],
  ] as const) {
    const row = rows.nth(index);
    const start = await page.evaluate(() => performance.now());
    await row.locator('[data-slot="collapsible-trigger"]').click();
    const parameters = row.getByText("Parameters", { exact: true });
    await expect(parameters).toBeVisible();
    const openedMs = await page.evaluate((t) => performance.now() - t, start);
    // The browser must not claim that a 300 KiB original parameter was loaded.
    // The fixture's real workspace files above remain byte-for-byte complete.
    // Offscreen code uses content-visibility:auto. Bring the parameters into
    // view before measuring visible text; their heading alone is insufficient.
    await row.locator('[data-language="json"]').first().scrollIntoViewIfNeeded();
    await expect(row).toContainText("historyPreview", { useInnerText: true });
    const preview = await row.innerText();
    expect(preview.length).toBeLessThan(4000);
    expect(preview).not.toContain(expected);
    expect(preview).toContain("historyPreview");
    samples.push({ toolIndex: index, openedMs, originalContentChars: expected.length });
    await row.locator('[data-slot="collapsible-trigger"]').click();
  }
  // The ordinary write acknowledgement remains usable, while a large bash
  // result can itself be a bounded preview. Never claim its copy is the source.
  await rows.nth(0).locator('[data-slot="collapsible-trigger"]').click();
  await expect(rows.nth(0).locator("[data-tool-output]")).toContainText("Successfully wrote");
  await rows.nth(0).locator('[data-slot="collapsible-trigger"]').click();
  const outputRow = rows.nth(3);
  await outputRow.locator('[data-slot="collapsible-trigger"]').click();
  const result = outputRow.locator("[data-tool-output]");
  await expect(result).toContainText("LARGE_MULTILINE_ROW_");
  await result.getByRole("button", { name: "Copy full tool result", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("LARGE_MULTILINE_ROW_");
  expect(copied.length).toBeLessThan(32 * 1024);
  record({
    kind: "large-tool-history-preview",
    fixture: "real-write-read-bash",
    samples,
    copiedResultChars: copied.length,
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  });
});

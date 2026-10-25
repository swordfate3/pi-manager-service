import { expect, test } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import WebSocket from "ws";
import { configureLongSessionFixture, getActiveHarness } from "./workspace-status.steps";

const { Given, When, Then, After } = createBdd();
let states: Array<Record<string, unknown>> = [];
let observer: WebSocket | undefined;
let browserErrors: string[] = [];

Given("真实长会话 fixture 已准备", async ({ page }) => {
  // The saved session has 6000 actual messages; the browser must render only
  // a bounded page and a bounded navigation preview, including after refresh.
  test.setTimeout(180_000);
  configureLongSessionFixture();
  states = [];
  browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
});

async function connectObserver() {
  const harness = getActiveHarness();
  if (!harness) throw new Error("Pi Web UI harness is not active");
  observer = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  observer.on("error", () => {});
  observer.on("message", (data) => {
    try {
      const envelope = JSON.parse(data.toString());
      if (envelope.type === "event" && envelope.event === "state_sync") states.push(envelope.payload);
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    observer?.once("open", resolve);
    observer?.once("error", reject);
  });
}

When("我连接真实 state_sync observer", async ({ page }) => {
  await connectObserver();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
  await expect.poll(() => states.length).toBeGreaterThan(0);
});

When("我刷新长会话 Web UI", async ({ page }) => {
  const previousSnapshots = states.length;
  observer?.close();
  await page.reload();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible({ timeout: 60_000 });
  await connectObserver();
  await expect.poll(() => states.length).toBeGreaterThan(previousSnapshots);
});

Then("长会话主聊天区和侧边栏完整可用", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("LONG_SESSION_END_MARKER_7e91f4", { timeout: 60_000 });
  const search = page.getByPlaceholder("Search conversation...");
  if (!(await search.isVisible())) await page.getByRole("button", { name: "Toggle left sidebar", exact: true }).click();
  await expect(search).toBeVisible();
  await search.fill("LONG_SESSION_END_MARKER_7e91f4");
  await page.locator('[data-tree-scroll-match="next"]').click();
  const lastRow = page.locator("[data-tree-entry-id]").filter({ hasText: "LONG_SESSION_END_MARKER_7e91f4" });
  await expect(lastRow).toBeVisible();
  expect(browserErrors).toEqual([]);
});

Then("state_sync 包含有界历史和部分树提示", async () => {
  await expect.poll(() => states.length).toBeGreaterThan(0);
  const snapshot = states.at(-1);
  if (!snapshot) throw new Error("No state_sync snapshot observed");
  const entries = snapshot.entries;
  const treeNodes = snapshot.treeNodes;
  if (!Array.isArray(entries) || !Array.isArray(treeNodes)) throw new Error("Invalid state_sync arrays");
  expect(entries.length).toBeLessThanOrEqual(100);
  expect(treeNodes.length).toBeLessThanOrEqual(1000);
  const history = snapshot.history as { total: number; nextBefore: string | null; treeLimited: boolean };
  expect(history.total).toBeGreaterThanOrEqual(6000);
  expect(history.nextBefore).toBeTruthy();
  expect(history.treeLimited).toBe(true);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).toContain("LONG_SESSION_END_MARKER_7e91f4");
  expect(Buffer.byteLength(serialized)).toBeLessThan(2 * 1024 * 1024);
});

After(async () => {
  observer?.close();
  observer = undefined;
});

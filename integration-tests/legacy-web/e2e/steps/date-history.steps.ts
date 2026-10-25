import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();
let harness: PiWebUiHarness | undefined;
let viewport = "desktop";
let browserErrors: string[] = [];
let expandedHeight = 0;
let historyRequests = 0;
let requestsBeforeCollapse = 0;

Given("a large dated history conversation is running at {string} size", async ({ page }, size: string) => {
  viewport = size;
  browserErrors = [];
  historyRequests = 0;
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "req" && value.method === "get_history") historyRequests++;
    }),
  );
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize(size === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  harness = await startPiWebUi("chat-lifecycle", { datedHistory: true });
});

When("I open the dated history web page", async ({ page }) => {
  if (!harness) throw new Error("Dated history harness is not running");
  await page.goto(harness.pageUrl);
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
});

Then("the history date filters are collapsed by default", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Expand date filters", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("History start date", { exact: true })).toBeHidden();
  await expect(page.getByRole("log")).toContainText("DATED_RECENT_END_MARKER");
  const box = await page.getByRole("region", { name: "Conversation history", exact: true }).boundingBox();
  expect(box?.height).toBeLessThan(120);
});

When("I expand the history date filters", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Expand date filters", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Collapse date filters", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByLabel("History start date", { exact: true })).toBeVisible();
});

When("I collapse the history date filters", async ({ page }) => {
  const region = page.getByRole("region", { name: "Conversation history", exact: true });
  expandedHeight = (await region.boundingBox())?.height ?? 0;
  requestsBeforeCollapse = historyRequests;
  await page.getByRole("button", { name: "Collapse date filters", exact: true }).click();
});

Then("collapsing dates preserves the selected history and frees vertical space", async ({ page }) => {
  const region = page.getByRole("region", { name: "Conversation history", exact: true });
  await expect(page.getByLabel("History start date", { exact: true })).toBeHidden();
  await expect(region).toContainText(await oldDate(page));
  await expect(page.getByRole("log")).toContainText("DATED_OLD_ONLY_MARKER");
  await expect(
    region.getByText("Live messages are hidden while viewing past dates or an older page.", { exact: true }),
  ).toBeVisible();
  const height = (await region.boundingBox())?.height ?? expandedHeight;
  expect(expandedHeight - height).toBeGreaterThan(60);
  expect(historyRequests).toBe(requestsBeforeCollapse);
  await page.screenshot({ path: `.tmp/history-collapsed-${viewport}.png`, fullPage: true });
});

Then("collapsing and reopening preserves unapplied date edits", async ({ page }) => {
  const start = page.getByLabel("History start date", { exact: true });
  await start.fill(await oldDate(page));
  const requests = historyRequests;
  await page.getByRole("button", { name: "Collapse date filters", exact: true }).click();
  await page.getByRole("button", { name: "Expand date filters", exact: true }).click();
  await expect(start).toHaveValue(await oldDate(page));
  expect(historyRequests).toBe(requests);
  await expect(page.getByRole("log")).toContainText("DATED_RECENT_END_MARKER");
});

Then("I see the recent history marker but not the old date marker", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("DATED_RECENT_END_MARKER");
  await expect(page.getByRole("log")).not.toContainText("DATED_OLD_ONLY_MARKER");
  await expect(page.getByRole("button", { name: "Apply dates", exact: true })).toBeEnabled();
  expect(browserErrors).toEqual([]);
});

async function oldDate(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const now = new Date();
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 14 * 86400000 + 3600000);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  });
}

When("I choose the old history date", async ({ page }) => {
  const date = await oldDate(page);
  await page.getByLabel("History start date", { exact: true }).fill(date);
  await page.getByLabel("History end date", { exact: true }).fill(date);
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
});

Then("I see only the selected old date history", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("DATED_OLD_ONLY_MARKER");
  await expect(page.getByRole("log")).not.toContainText("DATED_RECENT_END_MARKER");
  await expect(
    page.getByText("Live messages are hidden while viewing past dates or an older page.", { exact: true }),
  ).toBeVisible();
  mkdirSync(path.resolve(".tmp"), { recursive: true });
  await page.screenshot({ path: `.tmp/history-visual-${viewport}-old.png`, fullPage: true });
});

When("I return to the recent three days", async ({ page }) => {
  await page.getByRole("button", { name: "Recent three days", exact: true }).click();
});

Then("the history date controls fit in the viewport", async ({ page }) => {
  const region = page.getByRole("region", { name: "Conversation history", exact: true });
  await expect(region).toBeVisible();
  const size = page.viewportSize();
  if (!size) throw new Error("Missing browser viewport");
  for (const control of await region.locator("input, button").all()) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    if (!box) throw new Error("A history control is not rendered");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.tmp/history-visual-${viewport}-recent.png`, fullPage: true });
  expect(browserErrors).toEqual([]);
});

Then("saved-session dates load old sessions only after date selection", async ({ page }) => {
  const input = page.getByPlaceholder("Message Pi...");
  await input.fill("/resume");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resume a saved session" })).toBeVisible();
  await expect(dialog).not.toContainText("SAVED_OLD_DATE_MARKER");
  const date = await oldDate(page);
  await dialog.getByLabel("Saved sessions start date", { exact: true }).fill(date);
  await dialog.getByLabel("Saved sessions end date", { exact: true }).fill(date);
  await dialog.getByRole("button", { name: "Apply dates", exact: true }).click();
  await expect(dialog).toContainText("SAVED_OLD_DATE_MARKER");
  await page.screenshot({ path: `.tmp/history-visual-${viewport}-saved.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

After(async () => {
  await harness?.stop();
  harness = undefined;
});

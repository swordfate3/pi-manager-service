import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import WebSocket from "ws";
import { configureDailyCommandsFixture, getActiveHarness } from "./workspace-status.steps";

const { Given, When, Then, After } = createBdd();
let states: Array<{ sessionId?: string; runtimeId?: string; entries?: unknown[] }> = [];
let observer: WebSocket | undefined;
let observing = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let firstSessionId = "";
let secondSessionId = "";
let sessionFile = "";
let sessionContents = "";
let previousRuntime = "";

async function send(page: import("@playwright/test").Page, command: string) {
  const input = page.getByPlaceholder("Message Pi...");
  await input.fill(command);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(input).toHaveValue("");
}

function latestState() {
  const state = states.at(-1);
  if (!state) throw new Error("No observed state_sync was received");
  return state;
}

function jsonlFor(marker: string) {
  const harness = getActiveHarness();
  if (!harness) throw new Error("Pi Web UI harness is not active");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name.endsWith(".jsonl") ? [file] : [];
    });
  const match = walk(harness.sessionDir).find((file) => readFileSync(file, "utf8").includes(marker));
  if (!match) throw new Error(`No real session JSONL contains ${marker}`);
  return { file: match, contents: readFileSync(match, "utf8") };
}

Given("日常命令 faux response fixture 已准备", async () => {
  configureDailyCommandsFixture();
  states = [];
  firstSessionId = "";
  secondSessionId = "";
});

When("我连接只读 state_sync observer", async ({ page }) => {
  const harness = getActiveHarness();
  if (!harness) throw new Error("Pi Web UI harness is not active");
  observing = true;
  const observe = () => {
    if (!observing) return;
    observer = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    observer.on("error", () => {});
    observer.on("close", () => {
      if (observing && getActiveHarness()) reconnectTimer = setTimeout(observe, 150);
    });
    observer.on("message", (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        if (envelope.type === "event" && envelope.event === "state_sync") states.push(envelope.payload);
      } catch {}
    });
  };
  observe();
  await new Promise<void>((resolve, reject) => {
    observer?.once("open", resolve);
    observer?.once("error", reject);
  });
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
});

When("我记录第一会话身份与历史 {string}", async ({ page }, marker: string) => {
  void page;
  await expect.poll(() => states.length).toBeGreaterThan(0);
  firstSessionId = latestState().sessionId ?? "";
  expect(firstSessionId).toBeTruthy();
  const jsonl = jsonlFor(marker);
  sessionFile = jsonl.file;
  sessionContents = jsonl.contents;
});

When("我记录第二会话身份与历史 {string}", async ({ page }, marker: string) => {
  void page;
  await expect.poll(() => latestState().sessionId).not.toBe(firstSessionId);
  secondSessionId = latestState().sessionId ?? "";
  expect(secondSessionId).toBeTruthy();
  expect(jsonlFor(marker).file).not.toBe(sessionFile);
});

When("我设置当前会话名 {string}", async ({ page }, name: string) => {
  await send(page, `/name ${name}`);
  await expect(page.getByRole("main")).toContainText(name);
});

When("我再次打开恢复会话选择器并恢复第一会话", async ({ page }) => {
  await send(page, "/resume");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resume a saved session" })).toBeVisible();
  await dialog.getByPlaceholder("Search saved sessions...").fill("daily-session-one-unique");
  await dialog.getByRole("button", { name: /daily-session-one-unique/ }).click();
  await expect.poll(() => latestState().sessionId).toBe(firstSessionId);
});

When("我取消恢复会话选择器", async ({ page }) => {
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

When("我在未启用高级操作时选择第二会话恢复", async ({ page }) => {
  await send(page, "/resume");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /daily-session-two/ })
    .click();
});

When("我再次打开恢复会话选择器并拒绝草稿替换 {string}", async ({ page }, draft: string) => {
  await send(page, "/resume");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Resume a saved session" })).toBeVisible();
  await page.getByPlaceholder("Message Pi...").fill(draft);
  let dismissed = false;
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("discard the current draft");
    dismissed = true;
    await dialog.dismiss();
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /daily-session-one-unique/ })
    .click();
  expect(dismissed).toBe(true);
});

When("我记录当前运行时身份", async () => {
  await expect.poll(() => latestState().sessionId).toBe(firstSessionId);
  previousRuntime = latestState().runtimeId ?? "";
  expect(previousRuntime).toBeTruthy();
});

When("我记录当前会话文件并确认 HTML 导出", async ({ page }) => {
  const before = readFileSync(sessionFile, "utf8");
  const downloadPromise: Promise<import("@playwright/test").Download> = page.waitForEvent("download");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("complete session tree");
    await dialog.accept();
  });
  await send(page, "/export");
  const download = await downloadPromise;
  const destination = path.join(getActiveHarness()?.workspaceDir ?? ".", download.suggestedFilename());
  await download.saveAs(destination);
  expect(await download.failure()).toBeNull();
  const html = readFileSync(destination, "utf8");
  expect(html).toContain("<!DOCTYPE html>");
  const data = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/);
  if (!data?.[1]) throw new Error("Exported HTML has no embedded session data");
  const sessionData: unknown = JSON.parse(Buffer.from(data[1], "base64").toString("utf8"));
  expect(JSON.stringify(sessionData)).toContain("DAILY_SESSION_ONE_MARKER");
  expect(readFileSync(sessionFile, "utf8")).toBe(before);
});

Then("恢复会话选择器列出第一会话并标记当前会话", async ({ page }) => {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resume a saved session" })).toBeVisible();
  await expect(dialog.getByPlaceholder("Search saved sessions...")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /daily-session-one-unique/ })).toContainText(
    "DAILY_SESSION_ONE_MARKER",
  );
  await expect(dialog.getByRole("button", { name: /daily-session-two/ })).toContainText("Current");
  await expect(dialog.getByRole("button", { name: /daily-session-two/ })).toBeDisabled();
});

Then("第二会话仍保持当前", async ({ page }) => {
  await expect.poll(() => latestState().sessionId).toBe(secondSessionId);
  await expect(page.getByRole("log")).toContainText("DAILY_SESSION_TWO_MARKER");
});

Then("恢复会话选择器仍打开且草稿保留", async ({ page }) => {
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Resume a saved session" })).toBeVisible();
  await expect(page.getByPlaceholder("Message Pi...")).toHaveValue("第二会话未发送的草稿");
});

Then("当前会话仍为第二会话", async () => {
  await expect.poll(() => latestState().sessionId).toBe(secondSessionId);
});

Then("恢复使用原第一会话 ID 与历史", async ({ page }) => {
  await expect.poll(() => latestState().sessionId).toBe(firstSessionId);
  await expect(page.getByRole("log")).toContainText("DAILY_SESSION_ONE_MARKER");
  expect(readFileSync(sessionFile, "utf8")).toBe(sessionContents);
});

Then("高级会话操作需要重新启用", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Branch from message" }).first()).toBeDisabled();
});

Then("当前名称查询显示实际会话名称", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("Session name: daily-session-one-unique");
});

Then("会话统计显示 session ID、累计 tokens 与 context usage", async ({ page }) => {
  const details = page.getByRole("dialog");
  await expect(details).toContainText(firstSessionId);
  await expect(details).toContainText("Cumulative tokens (not context)");
  await expect(details).toContainText(/Context: (unknown|\d+ tokens)/);
});

When("我关闭会话详情", async ({ page }) => {
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

Then("下载的 HTML 包含当前会话唯一标记且原会话文件未改变", async () => {
  expect(readFileSync(sessionFile, "utf8")).toBe(sessionContents);
});

When("我再次启用会话分支操作", async ({ page }) => {
  await send(page, "/webui");
  await expect(page.getByRole("button", { name: "Branch from message" }).first()).toBeEnabled();
});

Then("会话统计保留 Messages 和 Tool calls", async ({ page }) => {
  const log = page.getByRole("log");
  await expect(log).toContainText("Session stats");
  await expect(log).toContainText("Messages:");
  await expect(log).toContainText("Tool calls:");
});

Then("收到新 runtime 的 state_sync 且 session ID 与历史不变", async () => {
  await expect.poll(() => states.at(-1)?.runtimeId).not.toBe(previousRuntime);
  expect(latestState().sessionId).toBe(firstSessionId);
  expect(readFileSync(sessionFile, "utf8")).toContain("DAILY_SESSION_ONE_MARKER");
});

Then("日常命令错误显示 {string}", async ({ page }, message: string) => {
  await expect(page.getByRole("alert")).toContainText(message);
});

Then("当前会话仍保持原第一会话文件未改", async () => {
  expect(readFileSync(sessionFile, "utf8")).toBe(sessionContents);
});

After(async () => {
  observing = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  observer?.close();
  observer = undefined;
});

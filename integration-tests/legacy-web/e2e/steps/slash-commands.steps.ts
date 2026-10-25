import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { getActiveHarness } from "./workspace-status.steps";

const { When, Then } = createBdd();

type SessionEntry = {
  type: string;
  id?: string;
  cwd?: string;
  parentSession?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
};
type SessionFile = { path: string; id: string; contents: string; entries: SessionEntry[] };
let sourceSession: SessionFile | undefined;
let cloneSession: SessionFile | undefined;
let selectedMessageText: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.id !== undefined && typeof value.id !== "string") return false;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
  if (value.parentSession !== undefined && typeof value.parentSession !== "string") return false;
  if (value.message !== undefined) {
    if (!isRecord(value.message)) return false;
    const message = value.message;
    if (message.role !== undefined && typeof message.role !== "string") return false;
    if (message.content !== undefined && typeof message.content !== "string") {
      if (!Array.isArray(message.content)) return false;
      if (
        !message.content.every(
          (part) =>
            isRecord(part) &&
            (part.type === undefined || typeof part.type === "string") &&
            (part.text === undefined || typeof part.text === "string"),
        )
      )
        return false;
    }
  }
  return true;
}

function readSessionFile(filePath: string): SessionFile | undefined {
  try {
    const contents = readFileSync(filePath, "utf8");
    const parsed: unknown[] = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    if (parsed.length === 0 || !parsed.every(isSessionEntry)) return undefined;
    const header = parsed[0];
    if (header?.type !== "session" || typeof header.id !== "string") return undefined;
    return { path: filePath, id: header.id, contents, entries: parsed };
  } catch {
    // Ignore a file while Pi is still writing a partial JSONL line.
    return undefined;
  }
}

function sessionFiles(): SessionFile[] {
  const harness = getActiveHarness();
  if (!harness) throw new Error("Pi Web UI harness is not active");
  const files: SessionFile[] = [];
  const visit = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const session = readSessionFile(filePath);
        if (session) files.push(session);
      }
    }
  };
  visit(harness.sessionDir);
  return files;
}

function hasText(session: SessionFile, text: string): boolean {
  return session.entries.some((entry) => JSON.stringify(entry).includes(text));
}

function firstUserMessageIndex(session: SessionFile, text: string): number {
  return session.entries.findIndex(
    (entry) =>
      entry.message?.role === "user" &&
      (typeof entry.message.content === "string"
        ? entry.message.content.includes(text)
        : entry.message.content?.some((part) => part.text?.includes(text))),
  );
}

function readCurrentSession(pathname: string): string {
  return readFileSync(pathname, "utf8");
}

Then("我记录当前 Pi 会话文件证据，包含消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log")).toContainText(text);
  await expect.poll(() => sessionFiles().filter((session) => hasText(session, text)).length).toBeGreaterThan(0);
  const matches = sessionFiles().filter((session) => hasText(session, text));
  const captured = matches[matches.length - 1];
  if (!captured) throw new Error(`Unable to find session containing ${text}`);
  sourceSession = captured;
  cloneSession = undefined;
  selectedMessageText = undefined;
  expect(sourceSession.path).toContain(`${path.sep}sessions${path.sep}`);
});

Then("clone 会话文件具有新 ID 并保留消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log")).toContainText(text);
  const source = sourceSession;
  expect(source, "capture the original session JSONL before cloning").toBeDefined();
  if (!source) throw new Error("Original session evidence is unavailable");
  const sameWorkspace = (session: SessionFile) => session.entries[0]?.cwd === source.entries[0]?.cwd;
  await expect
    .poll(
      () =>
        sessionFiles().filter(
          (session) => sameWorkspace(session) && session.path !== source.path && hasText(session, text),
        ).length,
    )
    .toBeGreaterThan(0);
  const matches = sessionFiles().filter(
    (session) => sameWorkspace(session) && session.path !== source.path && hasText(session, text),
  );
  const clone = matches[matches.length - 1];
  if (!clone) throw new Error("Unable to find cloned session");
  cloneSession = clone;
  expect(clone.id).not.toBe(source.id);
  expect(clone.entries[0]?.parentSession).toBe(source.path);
  const cloneEntryIds = new Set(clone.entries.slice(1).map((entry) => entry.id));
  for (const entry of source.entries.slice(1)) if (entry.id) expect(cloneEntryIds).toContain(entry.id);
  const selectedIndex = firstUserMessageIndex(clone, text);
  if (selectedIndex < 1) throw new Error(`Selected user message ${text} is not present in the clone`);
  const firstUserIndex = clone.entries.findIndex((entry) => entry.message?.role === "user");
  if (selectedIndex !== firstUserIndex) throw new Error(`Selected message ${text} is not the first user message`);
  selectedMessageText = text;
});

Then("原会话 JSONL 未被修改", async () => {
  const source = sourceSession;
  expect(source).toBeDefined();
  if (!source) throw new Error("Original session evidence is unavailable");
  expect(readCurrentSession(source.path)).toBe(source.contents);
});

Then("fork 会话文件具有新 ID 并且分叉在所选用户消息之前", async () => {
  const source = sourceSession;
  const clone = cloneSession;
  const selected = selectedMessageText;
  expect(source, "capture the original session JSONL before forking").toBeDefined();
  expect(clone, "capture the clone JSONL before forking").toBeDefined();
  if (!source || !clone || !selected) throw new Error("Session evidence required to verify fork is unavailable");
  await expect
    .poll(
      () =>
        sessionFiles().filter((session) => session.entries[0]?.parentSession === clone.path && session.id !== clone.id)
          .length,
    )
    .toBeGreaterThan(0);
  const fork = sessionFiles().find(
    (session) => session.entries[0]?.parentSession === clone.path && session.id !== clone.id,
  );
  if (!fork) throw new Error("Unable to find fork session parented by the clone");
  expect(fork.id).not.toBe(source.id);
  expect(fork.id).not.toBe(clone.id);
  const selectedIndex = firstUserMessageIndex(clone, selected);
  if (selectedIndex < 1) throw new Error(`Selected user message ${selected} is not present in the clone`);
  const expectedPrefix = clone.entries.slice(1, selectedIndex);
  expect(fork.entries.slice(1, 1 + expectedPrefix.length).map((entry) => entry.id)).toEqual(
    expectedPrefix.map((entry) => entry.id),
  );
  const excludedEntryIds = new Set(
    clone.entries
      .slice(selectedIndex)
      .map((entry) => entry.id)
      .filter(Boolean),
  );
  for (const entry of fork.entries.slice(1 + expectedPrefix.length)) {
    if (entry.id) expect(excludedEntryIds).not.toContain(entry.id);
  }
  expect(hasText(fork, selected)).toBe(false);
});

Then("原会话和 clone 会话 JSONL 均未被修改", async () => {
  const source = sourceSession;
  const clone = cloneSession;
  expect(source).toBeDefined();
  expect(clone).toBeDefined();
  if (!source || !clone) throw new Error("Session evidence required to verify immutability is unavailable");
  expect(readCurrentSession(source.path)).toBe(source.contents);
  expect(readCurrentSession(clone.path)).toBe(clone.contents);
});

When("我执行斜杠命令 {string}", async ({ page }, command: string) => {
  const input = page.getByPlaceholder("Message Pi...");
  await input.fill(command);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(input).toHaveValue("");
});

When("我打开设置面板", async ({ page }) => {
  const topbarSettings = page.getByRole("button", { name: "Open settings" });
  if (await topbarSettings.isVisible()) {
    await topbarSettings.click();
  } else {
    const search = page.getByPlaceholder("Search conversation...");
    if (!(await search.isVisible())) await page.getByRole("button", { name: "Toggle left sidebar" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
  }
  await expect(page.locator('[role="dialog"]')).toContainText("Settings");
});

When("我关闭设置面板", async ({ page }) => {
  await page.locator('[role="dialog"]').getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
});

When("我关闭模型选择器", async ({ page }) => {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

Then("thinking 等级按钮显示 {string}", async ({ page }, level: string) => {
  await expect(page.getByRole("button", { name: level, exact: true }).first()).toBeVisible();
});

Then("设置面板提供 {string} thinking 等级", async ({ page }, level: string) => {
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog.getByRole("button", { name: level, exact: true })).toBeVisible();
});

Then("设置面板可见", async ({ page }) => {
  await expect(page.locator('[role="dialog"]')).toContainText("Settings");
});

Then("模型选择器可见", async ({ page }) => {
  await expect(page.getByRole("dialog")).toContainText("Switch Model");
});

Then("聊天区显示会话空状态", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("Connect to the running Pi session and send a message.");
});

Then("左侧会话侧边栏可见", async ({ page }) => {
  await expect(page.getByPlaceholder("Search conversation...")).toBeVisible();
});

Then("聊天区不显示消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log").getByText(text, { exact: true })).toHaveCount(0, { timeout: 15_000 });
});

Then("聊天区包含系统消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log").getByText(text, { exact: false }).first()).toBeVisible();
});

Then("斜杠命令建议包含 {string}", async ({ page }, command: string) => {
  const input = page.getByPlaceholder("Message Pi...");
  const separator = [command.indexOf(":"), command.indexOf("-")]
    .filter((index) => index > 1)
    .sort((left, right) => left - right)[0];
  const prefix = separator ? command.slice(0, separator) : command.slice(0, Math.max(2, command.length - 2));
  await input.fill(prefix);
  await expect(page.getByRole("button").filter({ hasText: command }).first()).toBeVisible();
});

Then("聊天区显示系统消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log").getByText(text, { exact: true })).toBeVisible();
});

When("我启用会话分支操作", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("/webui");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("button", { name: "Branch from message" }).first()).toBeEnabled();
});

When("我在选择器后保留草稿并拒绝覆盖确认 {string}", async ({ page }, text: string) => {
  await page.getByPlaceholder("Message Pi...").fill(text);
  let confirmationShown = false;
  page.once("dialog", async (dialog) => {
    confirmationShown = true;
    expect(dialog.message()).toContain("Replace the current draft");
    await dialog.dismiss();
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /草稿保护源消息/ })
    .click();
  expect(confirmationShown).toBe(true);
});

When("我取消分叉消息选择器", async ({ page }) => {
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

Then("会话分支错误显示 {string}", async ({ page }, message: string) => {
  await expect(page.getByText(message, { exact: true })).toBeVisible();
});

Then("会话分支操作需要重新启用", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Branch from message" }).first()).toBeDisabled();
});

Then("分叉消息选择器显示 {string}", async ({ page }, text: string) => {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Fork from a user message" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: new RegExp(text) })).toBeVisible();
});

When("我从消息分叉会话 {string}", async ({ page }, text: string) => {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(text) })
    .click();
});

Then("输入框包含 {string}", async ({ page }, text: string) => {
  await expect(page.getByPlaceholder("Message Pi...")).toHaveValue(text);
});

Then("会话分支操作仍然可用", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Branch from message" }).first()).toBeEnabled();
});

Then("页面标题显示 {string}", async ({ page }, text: string) => {
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
});

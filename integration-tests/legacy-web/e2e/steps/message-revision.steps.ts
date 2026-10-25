import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

type RevisionEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content: unknown };
};
type Request = { method: string; params?: Record<string, unknown> };
type GenerationCounts = { prompts: number; revisions: number };

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let mobile = false;
let requests: Request[] = [];
let sourceAlphaId = "";
let sourceAlphaQuestionId = "";
let sourceBetaId = "";
let sourceBetaQuestionId = "";
let editedId = "";
let editedQuestionId = "";
let regeneratedId = "";
let regeneratedQuestionId = "";

function current() {
  if (!page) throw new Error("Revision page missing");
  return page;
}
function entries(): RevisionEntry[] {
  if (!harness) throw new Error("Revision harness missing");
  const { sessionDir } = harness;
  const files = readdirSync(sessionDir, { recursive: true }).filter(
    (f) => typeof f === "string" && f.endsWith(".jsonl"),
  );
  return files.flatMap((f) =>
    readFileSync(path.join(sessionDir, String(f)), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}
function messageId(role: string, text: string) {
  const entry = entries().find((e) => e.message?.role === role && JSON.stringify(e.message.content).includes(text));
  if (!entry) throw new Error(`Missing saved ${role} message ${text}`);
  return entry.id;
}
function answerId(text: string) {
  return messageId("assistant", text);
}
function parentId(id: string) {
  const entry = entries().find((candidate) => candidate.id === id);
  if (!entry?.parentId) throw new Error(`Missing parent for saved entry ${id}`);
  return entry.parentId;
}
function pager(id: string) {
  return current().locator(`[data-testid="message-version-pager"][data-entry-id="${id}"]`);
}
function countRequests(method: string) {
  return requests.filter((request) => request.method === method).length;
}
function generationCounts(): GenerationCounts {
  return {
    prompts: countRequests("prompt"),
    revisions: countRequests("submit_message_revision"),
  };
}
function expectNoGenerationRequests(before: GenerationCounts) {
  expect(generationCounts()).toEqual(before);
}
async function expectPager(entryId: string, index: number, total: number, userId?: string) {
  const control = pager(entryId);
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("aria-label", "消息版本");
  await expect(control).toContainText(new RegExp(`${index}\\s*\\/\\s*${total}`));
  if (userId) {
    const currentUserId = await control.getAttribute("data-current-user-id");
    if (currentUserId !== null) expect(currentUserId).toBe(userId);
  }
  return control;
}
async function expectPagerEdges(entryId: string, previousDisabled: boolean, nextDisabled: boolean) {
  const control = pager(entryId);
  const previous = control.getByRole("button", { name: "上一个消息版本", exact: true });
  const next = control.getByRole("button", { name: "下一个消息版本", exact: true });
  if (previousDisabled) await expect(previous).toBeDisabled();
  else await expect(previous).toBeEnabled();
  if (nextDisabled) await expect(next).toBeDisabled();
  else await expect(next).toBeEnabled();
}
async function send(text: string) {
  const p = current();
  await p.getByTestId("message-input").fill(text);
  await p.getByTestId("submit-message").click();
}
async function ready(text: string) {
  const p = current();
  await expect(p.getByRole("log")).toContainText(text);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeEnabled();
}
async function switchVersion(id: string) {
  const p = current();
  const row = p.locator(`[data-tree-entry-id="${id}"]`);
  if (!(await row.isVisible())) await p.getByTestId("toggle-left-sidebar").click();
  await row.getByRole("button", { name: "继续分支", exact: true }).click();
  if (mobile) await expect(p.getByRole("dialog")).toHaveCount(0);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeEnabled();
}
async function clickTwiceQuickly(button: Locator) {
  const p = current();
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("Message version pager button is not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p.mouse.click(x, y);
  await p.mouse.click(x, y);
}
async function expectSwitchCount(count: number) {
  await expect.poll(() => countRequests("switch_message_version")).toBe(count);
}

When("我打开消息修订真实 Pi 的 {string} 页面", async ({ browser }, viewport: string) => {
  harness = await startPiWebUi("message-revision");
  mobile = viewport === "mobile";
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  page = await context.newPage();
  requests = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const data = JSON.parse(String(payload));
      if (data.type === "req") requests.push(data);
    }),
  );
  await page.goto(harness.pageUrl);
  await expect(page.getByTestId("message-input")).toBeVisible();
});
When("我准备两轮可修订对话", async () => {
  await send("QUESTION_ALPHA");
  await expect(current().getByRole("log")).toContainText("ANSWER_ALPHA_ORIGINAL");
  await send("/webui");
  await ready("ANSWER_ALPHA_ORIGINAL");
  sourceAlphaId = answerId("ANSWER_ALPHA_ORIGINAL");
  sourceAlphaQuestionId = parentId(sourceAlphaId);
  await send("QUESTION_BETA");
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(current().getByRole("button", { name: "重新生成回答", exact: true })).toHaveCount(2);
  sourceBetaId = answerId("ANSWER_BETA_ORIGINAL");
  sourceBetaQuestionId = parentId(sourceBetaId);
});
When("我验证修订取消和草稿保护", async () => {
  const p = current();
  const before = countRequests("submit_message_revision");
  await p.getByRole("button", { name: "重新生成回答", exact: true }).last().click();
  await expect(p.getByRole("dialog")).toContainText("QUESTION_BETA");
  await expect(p.getByRole("dialog")).toContainText("不回滚代码文件");
  await p.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(countRequests("submit_message_revision")).toBe(before);
  await p.getByTestId("message-input").fill("KEEP_UNSENT_DRAFT");
  let alerted = false;
  p.once("dialog", async (dialog) => {
    alerted = true;
    await dialog.dismiss();
  });
  await p.getByRole("button", { name: "编辑并重新发送", exact: true }).first().click();
  expect(alerted).toBe(true);
  await expect(p.getByTestId("message-input")).toHaveValue("KEEP_UNSENT_DRAFT");
  await expect(p.getByRole("dialog")).toHaveCount(0);
  await p.getByTestId("message-input").fill("");
});
When("我编辑早期问题并验证忙碌保护", async () => {
  const p = current();
  await p.getByRole("button", { name: "编辑并重新发送", exact: true }).first().click();
  const dialog = p.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "编辑问题", exact: true })).toHaveValue("QUESTION_ALPHA");
  await dialog.getByRole("textbox", { name: "编辑问题", exact: true }).fill("  QUESTION_ALPHA_EDITED  ");
  await dialog.getByRole("button", { name: "编辑并重新发送", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeDisabled();
  await ready("ANSWER_ALPHA_EDITED");
  await expect(p.getByRole("log")).not.toContainText("QUESTION_BETA");
  await expect(p.getByRole("log")).not.toContainText("CONTEXT_LEAK");
  editedId = answerId("ANSWER_ALPHA_EDITED");
  editedQuestionId = parentId(editedId);
  const submit = requests.filter((request) => request.method === "submit_message_revision").at(-1);
  expect(submit?.params?.text).toBe("  QUESTION_ALPHA_EDITED  ");
  expect(typeof submit?.params?.previewId).toBe("string");
});
Then("编辑问题和回答版本分页可切回原分支并保留树切换回归", async () => {
  const p = current();
  const generationBaseline = generationCounts();
  const editedUserPager = await expectPager(editedQuestionId, 2, 2, editedQuestionId);
  await expectPager(editedId, 2, 2, editedQuestionId);
  await expectPagerEdges(editedQuestionId, false, true);
  await expectPagerEdges(editedId, false, true);

  await p.getByTestId("message-input").fill("KEEP_UNSENT_DRAFT");
  const switchesBeforeCancel = countRequests("switch_message_version");
  let cancelled = false;
  p.once("dialog", async (dialog) => {
    cancelled = true;
    await dialog.dismiss();
  });
  await editedUserPager.getByRole("button", { name: "上一个消息版本", exact: true }).click();
  expect(cancelled).toBe(true);
  expect(countRequests("switch_message_version")).toBe(switchesBeforeCancel);
  await expect(p.getByTestId("message-input")).toHaveValue("KEEP_UNSENT_DRAFT");
  await expectPager(editedQuestionId, 2, 2, editedQuestionId);

  let confirmed = false;
  p.once("dialog", async (dialog) => {
    confirmed = true;
    await dialog.accept();
  });
  await pager(editedQuestionId).getByRole("button", { name: "上一个消息版本", exact: true }).click();
  expect(confirmed).toBe(true);
  await expectSwitchCount(switchesBeforeCancel + 1);
  await expect(p.getByTestId("message-input")).toHaveValue("KEEP_UNSENT_DRAFT");
  await p.getByTestId("message-input").fill("");

  await ready("ANSWER_ALPHA_ORIGINAL");
  await expect(p.getByRole("log")).toContainText("ANSWER_BETA_ORIGINAL");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_ALPHA_EDITED");
  await expectPager(sourceAlphaQuestionId, 1, 2, sourceAlphaQuestionId);
  await expectPager(sourceAlphaId, 1, 2, sourceAlphaQuestionId);
  await expectPagerEdges(sourceAlphaQuestionId, true, false);
  await expectPagerEdges(sourceAlphaId, true, false);

  const nextAnswer = pager(sourceAlphaId).getByRole("button", { name: "下一个消息版本", exact: true });
  const beforeRapidClick = countRequests("switch_message_version");
  await clickTwiceQuickly(nextAnswer);
  await expectSwitchCount(beforeRapidClick + 1);
  await ready("ANSWER_ALPHA_EDITED");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_BETA_ORIGINAL");
  await expectPager(editedQuestionId, 2, 2, editedQuestionId);
  await expectPager(editedId, 2, 2, editedQuestionId);
  expectNoGenerationRequests(generationBaseline);

  await pager(editedId).getByRole("button", { name: "上一个消息版本", exact: true }).click();
  await expectSwitchCount(beforeRapidClick + 2);
  await ready("ANSWER_ALPHA_ORIGINAL");
  await expect(p.getByRole("log")).toContainText("ANSWER_BETA_ORIGINAL");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_ALPHA_EDITED");

  await pager(sourceAlphaId).getByRole("button", { name: "下一个消息版本", exact: true }).click();
  await expectSwitchCount(beforeRapidClick + 3);
  await ready("ANSWER_ALPHA_EDITED");

  // Continue is intentionally absent on the already-active leaf. Exercise
  // Tree from the edited path, where the original BETA leaf is inactive.
  await switchVersion(sourceBetaId);
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(p.getByRole("log")).not.toContainText("CONTEXT_LEAK");
  await expect(p.getByRole("button", { name: "重新生成回答", exact: true })).toHaveCount(2);
  expectNoGenerationRequests(generationBaseline);
});
When("我重新生成原 BETA 回答", async () => {
  const p = current();
  await p.getByRole("button", { name: "重新生成回答", exact: true }).last().click();
  const dialog = p.getByRole("dialog");
  await expect(dialog).toContainText("QUESTION_BETA");
  await dialog.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await ready("ANSWER_BETA_REGENERATED");
  await expect(p.getByRole("log")).not.toContainText("CONTEXT_LEAK");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_BETA_ORIGINAL");
  regeneratedId = answerId("ANSWER_BETA_REGENERATED");
  regeneratedQuestionId = parentId(regeneratedId);
  expect(regeneratedQuestionId).not.toBe(sourceBetaQuestionId);
  const submit = requests.filter((request) => request.method === "submit_message_revision").at(-1);
  expect(submit?.params?.text).toBeUndefined();
  await expectPager(regeneratedQuestionId, 2, 2, regeneratedQuestionId);
  await expectPager(regeneratedId, 2, 2, regeneratedQuestionId);
  await expectPagerEdges(regeneratedQuestionId, false, true);
  await expectPagerEdges(regeneratedId, false, true);
});
Then("重答分页刷新后可切换且不触发新生成", async () => {
  const p = current();
  const saved = entries();
  expect(new Set([sourceBetaId, editedId, regeneratedId]).size).toBe(3);
  expect(saved.find((entry) => entry.id === sourceBetaId)).toBeDefined();
  expect(saved.find((entry) => entry.id === editedId)).toBeDefined();
  await p.reload();
  await ready("ANSWER_BETA_REGENERATED");
  await send("/webui");
  await ready("ANSWER_BETA_REGENERATED");

  const generationBaseline = generationCounts();
  await expectPager(regeneratedQuestionId, 2, 2, regeneratedQuestionId);
  await expectPager(regeneratedId, 2, 2, regeneratedQuestionId);
  const beforePrevious = countRequests("switch_message_version");
  await pager(regeneratedId).getByRole("button", { name: "上一个消息版本", exact: true }).click();
  await expectSwitchCount(beforePrevious + 1);
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_BETA_REGENERATED");
  await expectPager(sourceBetaQuestionId, 1, 2, sourceBetaQuestionId);
  await expectPager(sourceBetaId, 1, 2, sourceBetaQuestionId);
  await expectPagerEdges(sourceBetaQuestionId, true, false);
  await expectPagerEdges(sourceBetaId, true, false);

  await pager(sourceBetaId).getByRole("button", { name: "下一个消息版本", exact: true }).click();
  await expectSwitchCount(beforePrevious + 2);
  await ready("ANSWER_BETA_REGENERATED");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_BETA_ORIGINAL");
  await expectPager(regeneratedQuestionId, 2, 2, regeneratedQuestionId);
  await expectPager(regeneratedId, 2, 2, regeneratedQuestionId);
  expectNoGenerationRequests(generationBaseline);
  expect(countRequests("submit_message_revision")).toBe(2);
});
After(async () => {
  if (context) await context.close();
  context = null;
  page = null;
  if (harness) await harness.stop();
  harness = null;
});

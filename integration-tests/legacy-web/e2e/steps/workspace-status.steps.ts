import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();

let fixtureName = "chat-lifecycle";
let workspaceGit = true;
let longSession = false;
let runtimeDir: string | undefined;
let harness: PiWebUiHarness | null = null;
let collapseHistorySynced = false;

export function getActiveHarness(): PiWebUiHarness | null {
  return harness;
}

export function setActiveHarness(value: PiWebUiHarness | null): void {
  harness = value;
}

export function configureLongSessionFixture(): void {
  fixtureName = "chat-lifecycle";
  workspaceGit = false;
  longSession = true;
}

export function configurePerformanceFixture(fixture: string): void {
  fixtureName = fixture;
  workspaceGit = false;
  longSession = fixture === "chat-lifecycle";
  runtimeDir = process.env.PI_E2E_RUNTIME_DIR;
}

export function configureDailyCommandsFixture(): void {
  fixtureName = "daily-commands";
  workspaceGit = false;
}

Given("当前工作区是 git 仓库", async () => {
  fixtureName = "chat-lifecycle";
  workspaceGit = true;
});

Given("skill 与扩展命令测试 fixture 已准备", async () => {
  fixtureName = "slash-commands";
  workspaceGit = false;
});

Given("当前工作区不是 git 仓库", async () => {
  fixtureName = "chat-lifecycle";
  workspaceGit = false;
});

Given("agent 会返回普通助手回复", async () => {
  fixtureName = "chat-lifecycle";
});

Given("折叠回归 faux fixture 已准备", async () => {
  fixtureName = "collapse-regression";
  workspaceGit = false;
});

When("我让 agent 执行折叠回归任务", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("Run the collapse regression task.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("log").getByText("Collapse regression write completed successfully.")).toBeVisible({
    timeout: 30_000,
  });
  // Assert interactions on the final real history, not a live row whose key is
  // about to be replaced by the scheduled settled snapshot.
  await expect.poll(() => collapseHistorySynced).toBe(true);
});

Then("思考正文默认折叠且可以展开", async ({ page }) => {
  const log = page.getByRole("log");
  const thinking = log.getByText(/COLLAPSE_REGRESSION_THINKING_BODY/);
  await expect(thinking).toBeHidden();
  const trigger = log.getByRole("button", { name: /Thought for/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(thinking).toBeVisible();
  await trigger.click();
  await expect(thinking).toBeHidden();
});

Then("write 工具默认折叠且摘要显示成功状态", async ({ page }) => {
  const log = page.getByRole("log");
  const toolTrigger = log.getByRole("button", { name: /write.*collapse-regression\.md/i });
  await expect(toolTrigger).toBeVisible();
  await expect(toolTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("img", { name: "Completed" })).toBeVisible();
  await expect(log.getByText("Parameters", { exact: true })).toBeHidden();
  await expect(log.getByText("Result", { exact: true })).toBeHidden();
  await toolTrigger.click();
  await expect(log.getByText("Parameters", { exact: true })).toBeVisible();
  await expect(log.getByText('"path": "collapse-regression.md"')).toBeVisible();
  await expect(log.getByText("Result", { exact: true })).toBeVisible();
  await expect(log.getByText(/Successfully wrote.*collapse-regression\.md/)).toBeVisible();
});

Then("刷新后思考和工具仍默认折叠", async ({ page }) => {
  await page.reload();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
  const log = page.getByRole("log");
  await expect(log.getByText(/COLLAPSE_REGRESSION_THINKING_BODY/)).toBeHidden();
  await expect(log.getByRole("button", { name: /Thought for/ })).toHaveAttribute("aria-expanded", "false");
  const toolTrigger = log.getByRole("button", { name: /write.*collapse-regression\.md/i });
  await expect(toolTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("img", { name: "Completed" })).toBeVisible();
  await expect(log.getByText("Parameters", { exact: true })).toBeHidden();
  await expect(log.getByText("Result", { exact: true })).toBeHidden();
});

Given("agent 会更新 workspace status 文档", async () => {
  fixtureName = "workspace-artifact";
});

Given("agent 会写入 workspace 外 Markdown artifact", async () => {
  fixtureName = "external-artifact";
});

Given("agent 会重复写入同一个 Markdown artifact", async () => {
  fixtureName = "duplicate-artifact";
});

Given("agent 会执行失败的 write 工具", async () => {
  fixtureName = "tool-failure";
});

When("我打开 Pi Web UI", async ({ page }) => {
  harness = await startPiWebUi(fixtureName, { git: workspaceGit, longSession, runtimeDir });
  collapseHistorySynced = false;
  if (fixtureName === "collapse-regression") {
    page.on("websocket", (socket) => {
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
          JSON.stringify(message.result.entries).includes("Collapse regression write completed successfully.")
        )
          collapseHistorySynced = true;
      });
    });
  }
  await page.goto(harness.pageUrl);
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
});

When("我让 agent 更新 workspace status 文档", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("Update the workspace status docs.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Updated the workspace status docs.")).toBeVisible({ timeout: 30_000 });
});

When("我让 agent 更新 external skill 文档", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("Update the external skill docs.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("log").getByText("Updated the external skill docs.")).toBeVisible({ timeout: 30_000 });
});

When("我让 agent 重复更新同一个 artifact", async ({ page }) => {
  await page.getByPlaceholder("Message Pi...").fill("Update the same artifact twice.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("log").getByText("Updated the same artifact twice.")).toBeVisible({ timeout: 30_000 });
});

When("我发送消息 {string}", async ({ page }, message: string) => {
  await page.getByPlaceholder("Message Pi...").fill(message);
  await page.getByRole("button", { name: "Submit" }).click();
});

When("我刷新 Pi Web UI", async ({ page }) => {
  await page.reload();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
});

async function openWorkspaceStatus(page: import("@playwright/test").Page) {
  const popup = page.getByTestId("workspace-status-float");
  if (!(await popup.isVisible())) {
    await page.getByRole("button", { name: "Open workspace status" }).click();
    await expect(popup).toBeVisible();
  }
  return popup;
}

When("我打开 workspace 状态 popup", async ({ page }) => {
  const popup = page.getByTestId("workspace-status-float");
  if (!(await popup.isVisible())) await page.getByRole("button", { name: "Open workspace status" }).click();
  await expect(popup).toBeVisible();
});

When("我关闭 workspace 状态 popup", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workspace-status-float")).toBeHidden();
});

Then("workspace 状态 popup 显示 git 状态", async ({ page }) => {
  const popup = await openWorkspaceStatus(page);
  await expect(popup.getByTestId("workspace-git-row")).toBeVisible();
});

Then("workspace 状态 popup 隐藏", async ({ page }) => {
  await expect(page.getByTestId("workspace-status-float")).toBeHidden();
});

Then("Workspace Float 显示当前分支", async ({ page }) => {
  const popup = await openWorkspaceStatus(page);
  await expect(popup.getByTestId("workspace-git-row")).toContainText(/main/);
});

Then("Workspace Float 显示 git additions 和 deletions", async ({ page }) => {
  const float = await openWorkspaceStatus(page);
  await expect(float.getByText(/\+\d+/)).toBeVisible();
  await expect(float.getByText(/-\d+/)).toBeVisible();
});

Then("Workspace Float 不显示 git additions 和 deletions", async ({ page }) => {
  const float = await openWorkspaceStatus(page);
  await expect(float.getByText(/\+\d+/)).toHaveCount(0);
  await expect(float.getByText(/-\d+/)).toHaveCount(0);
});

Then("Workspace Float 显示 git 状态不可用", async ({ page }) => {
  const row = (await openWorkspaceStatus(page)).getByTestId("workspace-git-row");
  await expect(row).toContainText("No git repository");
});

Then("Workspace Float 显示没有变更", async ({ page }) => {
  const row = (await openWorkspaceStatus(page)).getByTestId("workspace-git-row");
  await expect(row).toContainText("No changes");
});

Then("Workspace Float 显示 Markdown artifact", async ({ page }) => {
  await expect(
    (await openWorkspaceStatus(page)).getByTestId("workspace-artifact-row").filter({
      hasText: "workspace-status-float.md",
    }),
  ).toBeVisible();
});

Then("Workspace Float 显示 workspace 外 Markdown artifact", async ({ page }) => {
  await expect(
    (await openWorkspaceStatus(page)).getByTestId("workspace-artifact-row").filter({
      hasText: "external-skill.md",
    }),
  ).toBeVisible();
});

Then("Workspace Float 只显示一个 Markdown artifact", async ({ page }) => {
  await expect(
    (await openWorkspaceStatus(page)).getByTestId("workspace-artifact-row").filter({
      hasText: "workspace-status-float.md",
    }),
  ).toHaveCount(1);
});

When("我打开 Markdown artifact", async ({ page }) => {
  await (await openWorkspaceStatus(page))
    .getByTestId("workspace-artifact-row")
    .filter({ hasText: "workspace-status-float.md" })
    .click();
  await expect(page.getByTestId("workspace-status-float")).toBeHidden();
});

When("我打开 workspace 外 Markdown artifact", async ({ page }) => {
  await (await openWorkspaceStatus(page))
    .getByTestId("workspace-artifact-row")
    .filter({ hasText: "external-skill.md" })
    .click();
  await expect(page.getByTestId("workspace-status-float")).toBeHidden();
});

Then("右侧详情面板显示 artifact 文件内容", async ({ page }) => {
  const panel = page.locator("aside");
  await expect(panel).toContainText("workspace-status-float.md");
  await expect(panel).toContainText("current git branch and readable diff status");
});

Then("右侧详情面板显示 workspace 外 artifact 文件内容", async ({ page }) => {
  const panel = page.locator("aside");
  await expect(panel).toContainText("external-skill.md");
  await expect(panel).toContainText("outside the git workspace");
});

When("我隐藏右侧详情面板", async ({ page }) => {
  await page.locator("aside").getByTitle("Hide right panel").click();
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByTitle("Show right panel")).toBeVisible();
});

When("我打开 Changes 行", async ({ page }) => {
  const row = (await openWorkspaceStatus(page)).getByTestId("workspace-git-row");
  await expect(row).toBeVisible();
  await expect(row).toBeEnabled();
  await row.click();
  await expect(page.getByTestId("workspace-status-float")).toBeHidden();
});

When("我再次打开 Changes 行", async ({ page }) => {
  if (await page.locator("aside").getByTitle("Hide right panel").isVisible()) {
    await page.locator("aside").getByTitle("Hide right panel").click();
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.getByTitle("Show right panel")).toBeVisible();
  }
  const row = (await openWorkspaceStatus(page)).getByTestId("workspace-git-row");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await expect(row).toBeVisible();
    await expect(row).toBeEnabled();
    try {
      await row.click({ timeout: 2_000 });
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes("detached from the DOM")) throw error;
      await page.waitForTimeout(150);
    }
  }
});

Then("右侧详情面板显示 git diff tab", async ({ page }) => {
  const panel = page.locator("aside");
  await expect(panel).toContainText("Changes");
  await expect(panel).toContainText("docs/prd/workspace-status-float.md");
  await expect(panel).toContainText("+3");
  await expect(panel).toContainText("-1");
  await expect(panel).toContainText("The workspace float shows the current git branch");
});

Then("右侧详情面板只显示一个 Changes tab", async ({ page }) => {
  const panel = page.locator("aside");
  await expect(panel.getByRole("button", { name: "Changes" })).toHaveCount(1);
});

When("我关闭当前右侧详情 tab", async ({ page }) => {
  await page.locator("aside").getByTitle("Close tab").click();
});

Then("右侧详情面板隐藏", async ({ page }) => {
  await expect(page.locator("aside")).toHaveCount(0);
});

Then("显示恢复详情面板按钮", async ({ page }) => {
  await expect(page.getByTitle("Show right panel")).toBeVisible();
});

Then("聊天区显示消息 {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("log").getByText(text, { exact: true })).toBeVisible();
});

Then("聊天区显示工具调用 {string}", async ({ page }, toolName: string) => {
  await expect(page.getByText(toolName).first()).toBeVisible();
});

Then("聊天区显示工具错误状态", async ({ page }) => {
  await expect(page.getByText(/error|failed|EISDIR|directory/i)).toBeVisible();
});

Then("输入框恢复可提交状态", async ({ page }) => {
  const submit = page.getByRole("button", { name: "Submit" });
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();
});

When("我收起左侧边栏", async ({ page }) => {
  const search = page.getByPlaceholder("Search conversation...");
  if (await search.isVisible()) {
    // Mobile Sheet makes the main header inert; use its internal close entry.
    await page.getByRole("button", { name: "Close left sidebar", exact: true }).click();
  }
  await expect(search).toBeHidden();
});

When("我展开左侧边栏", async ({ page }) => {
  const search = page.getByPlaceholder("Search conversation...");
  if (!(await search.isVisible())) {
    await page.getByRole("button", { name: "Toggle left sidebar", exact: true }).click();
  }
  await expect(search).toBeVisible();
});

When("我打开 Pi Web UI 并设置移动视口", async ({ page }) => {
  harness = await startPiWebUi(fixtureName, { git: workspaceGit, longSession, runtimeDir });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness.pageUrl);
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
});

Then("左侧边栏不显示会话搜索框", async ({ page }) => {
  await expect(page.getByPlaceholder("Search conversation...")).toBeHidden();
});

Then("左侧边栏显示会话搜索框", async ({ page }) => {
  await expect(page.getByPlaceholder("Search conversation...")).toBeVisible();
});

Then("聊天输入框仍然完整可见", async ({ page }) => {
  const input = page.getByPlaceholder("Message Pi...");
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  const box = await input.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
});

After(async () => {
  await harness?.stop();
  harness = null;
  workspaceGit = true;
  longSession = false;
  runtimeDir = undefined;
});

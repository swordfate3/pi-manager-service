import { readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type HubCliHarness, startHubCli } from "../harness/hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();
const resumePath = "documents/求职/计算机硕士秋招简历-优化版.pdf";
const resumeBytes = "%PDF-1.7\nPi Web download fixture 中文\n%%EOF\n";
let hub: HubCliHarness | undefined;
let agent: PiWebUiHarness | undefined;
let context: BrowserContext | undefined;
let browserPage: Page | undefined;
let screen = "desktop";
let downloads = 0;
let prepareRequests = 0;
function page() {
  if (!browserPage) throw new Error("Download page not initialized");
  return browserPage;
}

Given("文件下载测试通过 {string} 在 {string} 打开", async ({ browser }, route: string, viewport: string) => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  screen = viewport;
  if (route === "hub") hub = await startHubCli({ repositoryRoot });
  agent = await startPiWebUi("file-download", {
    repositoryRoot,
    git: false,
    registration: hub?.issue("download-test"),
  });
  let url = agent.pageUrl;
  if (hub) {
    let sessionPath: string | undefined;
    await expect
      .poll(async () => {
        const listing = await (await fetch(`${hub?.url}api/sessions`)).json();
        sessionPath = listing.sessions[0]?.path;
        return sessionPath;
      })
      .toBeTruthy();
    url = new URL(sessionPath ?? "", hub.url).href;
  }
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: screen === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: screen === "mobile",
    hasTouch: screen === "mobile",
  });
  browserPage = await context.newPage();
  downloads = 0;
  prepareRequests = 0;
  page().on("download", () => downloads++);
  page().on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "req" && value.method === "prepare_file_download") prepareRequests++;
    });
  });
  await page().goto(url);
  await expect(page().getByTestId("message-input")).toBeVisible();
});

When("Pi 生成带中文路径的 PDF 回复", async () => {
  await page().getByTestId("message-input").fill("请生成中文简历文件并提供下载路径。");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log").getByRole("link", { name: "下载简历", exact: true })).toBeVisible();
  await expect(page().getByTestId("submit-message")).toBeEnabled();
});

Then("点击加粗路径后可以取消且不会下载", async ({ $testInfo }) => {
  const url = page().url();
  await page()
    .getByRole("log")
    .locator('[data-streamdown="strong"]')
    .getByRole("link", { name: resumePath, exact: true })
    .click();
  const dialog = page().getByRole("dialog", { name: "是否下载此文件？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("download-file-path")).toHaveText(resumePath);
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await page().screenshot({
    path: $testInfo.outputPath(`download-confirm-${screen}.png`),
    fullPage: true,
    animations: "disabled",
  });
  expect(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(downloads).toBe(0);
  expect(prepareRequests).toBe(0);
  expect(page().url()).toBe(url);
});

async function confirmAndCheck() {
  const result = page().waitForEvent("download");
  await page().getByRole("dialog").getByRole("button", { name: "是，下载", exact: true }).click();
  const downloaded = await result;
  expect(downloaded.suggestedFilename()).toBe("计算机硕士秋招简历-优化版.pdf");
  const local = await downloaded.path();
  expect(local).toBeTruthy();
  expect(readFileSync(local ?? "")).toEqual(Buffer.from(resumeBytes));
  await expect(page().getByRole("dialog")).toBeHidden();
}

Then("确认下载后保留中文文件名和原始文件内容", async () => {
  await page()
    .getByRole("log")
    .locator('[data-streamdown="strong"]')
    .getByRole("link", { name: resumePath, exact: true })
    .click();
  await confirmAndCheck();
  expect(downloads).toBe(1);
  expect(prepareRequests).toBe(1);
});

Then("Markdown 链接和行内代码路径也可以下载", async () => {
  await page().getByRole("log").getByRole("link", { name: "下载简历", exact: true }).click();
  await confirmAndCheck();
  await page()
    .getByRole("log")
    .getByRole("link", { name: resumePath, exact: true })
    .filter({ has: page().locator("code") })
    .click();
  await confirmAndCheck();
  await expect(page().getByRole("link", { name: "外部报告", exact: true })).toHaveAttribute(
    "href",
    "https://example.org/report.pdf",
  );
  await page().getByRole("link", { name: "外部报告", exact: true }).click();
  const external = page().getByRole("dialog", { name: "打开外部链接？" });
  await expect(external).toBeVisible();
  await expect(external).toContainText("https://example.org/report.pdf");
  await external.getByRole("button", { name: "取消", exact: true }).click();
  expect(prepareRequests).toBe(3);
});

Then("文件不存在时显示错误而不会离开聊天", async () => {
  const url = page().url();
  await page().getByRole("log").getByRole("link", { name: "documents/missing.pdf", exact: true }).click();
  await page().getByRole("dialog").getByRole("button", { name: "是，下载", exact: true }).click();
  await expect(page().getByRole("dialog").getByRole("alert")).toContainText("文件无法下载");
  expect(downloads).toBe(3);
  expect(page().url()).toBe(url);
  await page().getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
});

After(async () => {
  if (!browserPage) return;
  try {
    await context?.close();
    await agent?.stop();
  } finally {
    await hub?.close();
  }
  browserPage = undefined;
  context = undefined;
  agent = undefined;
  hub = undefined;
});

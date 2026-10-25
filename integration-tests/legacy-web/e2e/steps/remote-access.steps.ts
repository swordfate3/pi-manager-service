import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: BrowserContext | null = null;
let page: Page;
let chinese = false;

When(
  "I open remote onboarding on a real Pi in {string} with {string}",
  async ({ browser }, screen: string, locale: string) => {
    harness = await startPiWebUi("chat-lifecycle");
    chinese = locale === "zh-CN";
    context = await browser.newContext({
      locale,
      viewport: screen === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    });
    page = await context.newPage();
    await page.goto(`${harness.pageUrl}/#remote-access`);
    await expect(page.getByTestId("remote-access-panel")).toBeVisible();
  },
);

Then("onboarding can be skipped and reopened from settings", async () => {
  await page.getByRole("button", { name: chinese ? "暂时跳过" : "Skip for now", exact: true }).click();
  await expect(page.getByTestId("message-input")).toBeVisible();
  await page.getByRole("button", { name: chinese ? "打开设置" : "Open settings", exact: true }).click();
  await page.getByRole("button", { name: chinese ? "远程访问" : "Remote access", exact: true }).click();
  await expect(page.getByTestId("remote-access-panel")).toBeVisible();
});

When("I generate a new single-session deployment for pi.example.com", async () => {
  await page.getByTestId("access-mode").selectOption("remote");
  await page.getByTestId("remote-server").fill("server.example.com");
  await page.getByTestId("remote-ssh-user").fill("operator;id");
  await page.getByTestId("remote-domain").fill("pi.example.com");
  await page.getByTestId("remote-public-url").fill("https://pi.example.com/");
  await page.getByTestId("generate-materials").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("material-preview")).toHaveCount(0);
  await page.getByTestId("remote-ssh-user").fill("operator");
  await page.getByTestId("generate-materials").click();
  await page.getByRole("button", { name: chinese ? "保存非敏感草稿" : "Save nonsecret draft", exact: true }).click();
  await expect(
    page.getByText(
      chinese
        ? "草稿已保存在此浏览器中，Pi 设置和服务器凭据均未修改。"
        : "Draft saved in this browser. Pi settings and server credentials are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    localStorage.removeItem("pi-web-ui-remote-plan-v1");
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "pi-web-ui-remote-plan-v1") throw new Error("Storage disabled for this draft");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: chinese ? "保存非敏感草稿" : "Save nonsecret draft", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(chinese ? "草稿未保存" : "draft was not saved");
});

Then("deployment materials are pending and login management never requests a password", async ({ $testInfo }) => {
  await expect(page.getByTestId("deployment-status")).toContainText(chinese ? "待执行" : "Pending execution");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByTestId("material-select").selectOption("connect.sh");
  await expect(page.getByTestId("material-preview")).toContainText("ExitOnForwardFailure=yes");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: $testInfo.outputPath("remote-access-materials.png"),
    fullPage: true,
    animations: "disabled",
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-material").click();
  expect((await downloadPromise).suggestedFilename()).toBe("connect.sh");
  await page.getByRole("button", { name: chinese ? "登录管理" : "Login management", exact: true }).click();
  await expect(page.getByTestId("login-management")).toContainText("Caddy");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: $testInfo.outputPath("remote-access-login.png"),
    fullPage: true,
    animations: "disabled",
  });
});

When("I change the Pi listener port to {int}", async ({ page: _fixturePage }, port: number) => {
  await page.getByRole("button", { name: chinese ? "远程访问" : "Remote access", exact: true }).click();
  await page.getByTestId("remote-local-port").fill(String(port));
});

Then("generated materials are invalidated", async () => {
  await expect(page.getByTestId("material-preview")).toHaveCount(0);
  await expect(page.getByTestId("deployment-status")).toHaveCount(0);
});

When("I generate materials again", async () => {
  await page.getByTestId("generate-materials").click();
  await expect(page.getByTestId("material-preview")).toBeVisible();
});

Then("the generated connection plan uses Pi listener port {int}", async ({ page: _fixturePage }, port: number) => {
  await page.getByTestId("material-select").selectOption("connection-plan.json");
  await expect(page.getByTestId("material-preview")).toContainText(`"localPort": ${port}`);
});

After(async () => {
  await context?.close();
  await harness?.stop();
  context = null;
  harness = null;
});

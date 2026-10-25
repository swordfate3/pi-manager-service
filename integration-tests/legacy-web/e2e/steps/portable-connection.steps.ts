import http from "node:http";
import type { AddressInfo } from "node:net";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let proxy: http.Server | null = null;
let context: BrowserContext | null = null;
let connectionPage: Page | null = null;
let prefix = "/";
let screen = "desktop";
let wsConnected = false;
const failures: string[] = [];
const assets: string[] = [];

function page(): Page {
  if (!connectionPage) throw new Error("Portable connection browser page is not initialized");
  return connectionPage;
}

When("我在 {string} 和 {string} 打开独立 Pi 网页", async ({ browser }, entry: string, viewport: string) => {
  prefix = entry;
  screen = viewport;
  wsConnected = false;
  failures.length = 0;
  assets.length = 0;
  harness = await startPiWebUi("chat-lifecycle");
  const port = harness.port;
  // A real strip-prefix reverse proxy: no URL rewriting inside browser globals.
  proxy = http.createServer((request, response) => {
    if (!request.url?.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/${request.url.slice(prefix.length)}`,
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, socket, head) => {
    if (request.url !== `${prefix}ws`) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = http.request({ host: "127.0.0.1", port, path: "/ws", headers: request.headers });
    upstream.on("upgrade", (response, remote, upstreamHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      remote.pipe(socket).pipe(remote);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve) => proxy?.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: viewport === "mobile",
    hasTouch: viewport === "mobile",
  });
  connectionPage = await context.newPage();
  page().on("pageerror", (error) => failures.push(error.message));
  page().on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    if (["script", "stylesheet"].includes(response.request().resourceType()))
      assets.push(new URL(response.url()).pathname);
  });
  page().on("websocket", (socket) => {
    expect(new URL(socket.url()).pathname).toBe(`${prefix}ws`);
    socket.on("framereceived", () => {
      wsConnected = true;
    });
    socket.on("socketerror", (error) => failures.push(error));
  });
  await page().goto(`http://127.0.0.1:${proxyPort}${prefix}`);
  await expect(page().getByTestId("message-input")).toBeVisible();
});

Then("入口内的静态资源和 WebSocket 均成功连接", async () => {
  await expect.poll(() => wsConnected).toBe(true);
  expect(assets.length).toBeGreaterThan(0);
  expect(assets.every((value) => value.startsWith(`${prefix}assets/`))).toBe(true);
  expect(failures).toEqual([]);
  if (prefix !== "/")
    expect(await page().evaluate(() => navigator.serviceWorker.getRegistrations().then((value) => value.length))).toBe(
      0,
    );
});

When("我通过入口发送真实 Pi 测试消息", async () => {
  await page().getByTestId("message-input").fill("portable connection test");
  await page().getByTestId("submit-message").click();
});

Then("入口显示真实 Pi 回复并保存截图", async ({ $testInfo }) => {
  await expect(page().getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  expect(failures).toEqual([]);
  const screenshot = $testInfo.outputPath(`portable-${prefix === "/" ? "root" : "subpath"}-${screen}.png`);
  await page().screenshot({ path: screenshot, fullPage: true });
  await $testInfo.attach("portable connection rendered page", { path: screenshot, contentType: "image/png" });
});

Then("导出文件通过当前入口下载成功", async () => {
  const received = page().waitForEvent("download");
  page().once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await page().getByTestId("message-input").fill("/export");
  await page().getByTestId("submit-message").click();
  const download = await received;
  expect(new URL(download.url()).pathname).toMatch(new RegExp(`^${prefix}api/exports/[0-9a-f-]+$`));
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  expect(failures).toEqual([]);
});

After(async () => {
  await context?.close();
  context = null;
  connectionPage = null;
  if (proxy) await new Promise<void>((resolve) => proxy?.close(() => resolve()));
  proxy = null;
  await harness?.stop();
  harness = null;
});

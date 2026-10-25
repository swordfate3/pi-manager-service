import { createHash } from "node:crypto";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { whaleGif } from "../fixtures/whale-gif";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let usageRequests = 0;
let uploadRequests = 0;
// Synthetic 1x1 PNG, no third-party artwork is included in E2E/package.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==",
  "base64",
);
function current() {
  if (!page) throw new Error("Whale page unavailable");
  return page;
}
async function open(browser: import("@playwright/test").Browser, mobile: boolean) {
  harness = await startPiWebUi("chat-lifecycle", { usageHistory: true });
  context = await browser.newContext({
    locale: "en",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  page = await context.newPage();
  usageRequests = 0;
  uploadRequests = 0;
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const request = JSON.parse(String(payload));
      if (request.method === "get_usage_stats") usageRequests++;
      if (["prepare_upload", "prompt"].includes(request.method)) uploadRequests++;
    }),
  );
  page.on("request", (request) => {
    if (request.method() === "PUT" || request.method() === "POST") uploadRequests++;
  });
  await page.goto(harness.pageUrl);
  await expect(page.getByTestId("message-input")).toBeVisible();
  await expect(page.getByTestId("whale-pet")).toBeVisible();
}
When("我打开桌面鲸鱼娘的真实 Pi 页面", async ({ browser }) => open(browser, false));
When("我打开手机鲸鱼娘的真实 Pi 页面", async ({ browser }) => open(browser, true));

async function expectDefaultPosition() {
  const p = current();
  await expect
    .poll(async () => {
      const pet = await p.getByTestId("whale-pet").boundingBox();
      const anchor = await p.locator("[data-whale-anchor]").boundingBox();
      if (!pet || !anchor) return false;
      return (
        Math.abs(pet.x + pet.width - anchor.x - anchor.width) < 2 && Math.abs(pet.y + pet.height + 8 - anchor.y) < 2
      );
    })
    .toBe(true);
}

async function verifyDirectDrag(mobile: boolean) {
  const p = current();
  await expectDefaultPosition();
  const before = await p.getByTestId("whale-pet").boundingBox();
  if (!before) throw new Error("Whale bounds unavailable");
  const x = before.x + before.width / 2;
  const y = before.y + before.height / 2;
  if (mobile) {
    const cdp = await p.context().newCDPSession(p);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 80, y: y - 90 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  } else {
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x - 80, y - 90, { steps: 8 });
    await p.mouse.up();
  }
  await expect.poll(async () => (await p.getByTestId("whale-pet").boundingBox())?.x).toBeCloseTo(before.x - 80, 0);
  await expect(p.getByTestId("whale-usage-card")).toHaveCount(0);
  expect(usageRequests).toBe(0);
  await p.reload();
  await expect.poll(async () => (await p.getByTestId("whale-pet").boundingBox())?.x).toBeCloseTo(before.x - 80, 0);
  // The reset must work even though settings temporarily unmounts the pet DOM.
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-position-reset").click();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expectDefaultPosition();
  expect(await p.evaluate(() => localStorage.getItem("pi-web-ui-whale-position"))).toBeNull();
  await p.reload();
  await expectDefaultPosition();
  // Growing the input moves the automatic anchor, without making it a manual preference.
  const oldHeight = await p.locator("[data-whale-anchor]").evaluate((element) => element.clientHeight);
  await p.getByTestId("message-input").fill("line\n".repeat(8));
  await expect
    .poll(() => p.locator("[data-whale-anchor]").evaluate((element) => element.clientHeight))
    .toBeGreaterThan(oldHeight);
  await expectDefaultPosition();
  await p.getByTestId("message-input").fill("");
  await expectDefaultPosition();
}

async function importIdle() {
  const p = current();
  await p.getByTestId("open-settings").click();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  const input = p.getByTestId("whale-asset-idle");
  await input.setInputFiles({ name: "local-only.png", mimeType: "image/png", buffer: png });
  await expect(p.getByTestId("whale-assets-status")).toContainText(/saved|stored|persistent|browser/i);
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  const image = p.getByTestId("whale-pet").locator("img");
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toMatch(/^blob:/);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
}

async function rejectUnsafeImage() {
  const p = current();
  await p.getByTestId("open-settings").click();
  await p
    .getByTestId("whale-asset-idle")
    .setInputFiles({ name: "not-really.png", mimeType: "image/png", buffer: Buffer.from("<svg onload='alert(1)'/>") });
  await expect(p.getByRole("alert")).toContainText(/PNG|WebP|image|format|invalid|unsupported/i);
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await expect
    .poll(() =>
      p
        .getByTestId("whale-pet")
        .locator("img")
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
}
async function openCard() {
  const p = current();
  await p.getByTestId("whale-pet-body").click();
  const card = p.getByTestId("whale-usage-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("billed-model-a");
  await expect(card).toContainText("billed-model-b");
  await expect(card).toContainText("465");
  await expect(card).toContainText("Known subtotal");
  await expect(card).toContainText("unpriced");
  return card;
}
Then("我验证鲸鱼娘本地素材、会话用量与显示生命周期", async () => {
  const p = current();
  expect(usageRequests).toBe(0);
  await verifyDirectDrag(false);
  await importIdle();
  await rejectUnsafeImage();
  await p.emulateMedia({ reducedMotion: "reduce" });
  await openCard();
  expect(
    await p
      .getByTestId("whale-pet")
      .locator("img")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  const initialRequests = usageRequests;
  expect(initialRequests).toBeGreaterThan(0);
  await p.keyboard.press("Escape");
  await expect(p.getByTestId("whale-usage-card")).toHaveCount(0);
  await p.waitForTimeout(5200);
  expect(usageRequests).toBe(initialRequests);
  expect(uploadRequests).toBe(0);
  const drag = p.getByTestId("whale-drag");
  await drag.focus();
  const before = await p.getByTestId("whale-pet").boundingBox();
  await p.keyboard.press("ArrowLeft");
  const after = await p.getByTestId("whale-pet").boundingBox();
  if (!after || !before) throw new Error("Whale bounds unavailable");
  expect(after.x).toBeLessThan(before.x);
  await p.getByRole("button", { name: "Collapse whale", exact: true }).click();
  await expect(p.getByTestId("whale-pet")).toHaveClass(/compact/);
  await p.reload();
  await expect(p.getByTestId("whale-pet")).toHaveClass(/compact/);
  await p.getByRole("button", { name: "Hide whale", exact: true }).click();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-mode-full").click();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await p.getByTestId("whale-pet-body").click();
  await expect(p.getByTestId("whale-usage-card")).toContainText("465");
  await p.keyboard.press("Escape");
  await p.getByTestId("message-input").fill("/new");
  await p.getByTestId("submit-message").click();
  await expect(p.getByRole("log")).not.toContainText("SYNTHETIC_USAGE_RESPONSE");
  await p.getByTestId("whale-pet-body").click();
  await expect(p.getByTestId("whale-usage-card")).not.toContainText("billed-model-a");
  await expect(p.getByTestId("whale-usage-card")).not.toContainText("billed-model-b");
  await expect(p.getByTestId("whale-usage-card")).toContainText("No response yet");
});
Then("我验证手机鲸鱼娘边界和本地素材刷新恢复", async () => {
  const p = current();
  await verifyDirectDrag(true);
  await importIdle();
  await p.reload();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await openCard();
  for (const id of ["whale-pet", "whale-usage-card"]) {
    const bounds = await p.getByTestId(id).boundingBox();
    if (!bounds) throw new Error("Whale bounds unavailable");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  }
  await p.keyboard.press("Escape");
  const drag = await p.getByTestId("whale-drag").boundingBox();
  if (!drag) throw new Error("Whale drag handle unavailable");
  await p.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await p.mouse.down();
  await p.mouse.move(1, 1, { steps: 8 });
  await p.mouse.up();
  const pet = await p.getByTestId("whale-pet").boundingBox();
  if (!pet) throw new Error("Whale bounds unavailable");
  expect(pet.x).toBeGreaterThanOrEqual(0);
  expect(pet.y).toBeGreaterThanOrEqual(0);
  await openCard();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(uploadRequests).toBe(0);
});
Then("我验证键盘式视口收缩与恢复位置", async () => {
  const p = current();
  const pet = p.getByTestId("whale-pet");
  const stored = () => p.evaluate(() => localStorage.getItem("pi-web-ui-whale-position"));
  const y = async () => (await pet.boundingBox())?.y;
  const shrink = () => p.setViewportSize({ width: 390, height: 430 });
  const expand = () => p.setViewportSize({ width: 390, height: 844 });
  await expectDefaultPosition();
  // Default anchoring is recomputed rather than persisted on resize.
  await shrink();
  await expectDefaultPosition();
  await expand();
  await expectDefaultPosition();
  expect(await stored()).toBeNull();
  // Manual preference must survive temporary viewport clamping, modal suspension and reload.
  await p.getByTestId("whale-drag").focus();
  await p.keyboard.press("ArrowDown");
  const originalY = await y();
  const originalPreference = await stored();
  expect(originalY).toBeGreaterThan(500);
  await shrink();
  await expect.poll(y).toBeLessThan(320);
  expect(await stored()).toBe(originalPreference);
  await p.getByTestId("open-settings").click();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await p.reload();
  await expect.poll(y).toBeLessThan(320);
  expect(await stored()).toBe(originalPreference);
  await expand();
  await expect.poll(y).toBeCloseTo(originalY as number, 0);
  // A deliberate move while the viewport is small becomes the new preference.
  await shrink();
  await expect.poll(y).toBeLessThan(320);
  await p.getByTestId("whale-drag").focus();
  await p.keyboard.press("ArrowUp");
  const newY = await y();
  const newPreference = await stored();
  expect(newPreference).not.toBe(originalPreference);
  await expand();
  await expect.poll(y).toBeCloseTo(newY as number, 0);
  // Also cover visualViewport-only shrink/pan without changing layout dimensions.
  await p.getByTestId("whale-drag").focus();
  for (let i = 0; i < 12; i++) await p.keyboard.press("Shift+ArrowDown");
  const visualOriginalY = await y();
  const visualPreference = await stored();
  await p.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("visualViewport unavailable");
    Object.defineProperty(viewport, "height", { configurable: true, value: 430 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 40 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(y).toBeLessThan(351);
  expect(await stored()).toBe(visualPreference);
  await p.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("visualViewport unavailable");
    Reflect.deleteProperty(viewport, "height");
    Reflect.deleteProperty(viewport, "offsetTop");
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(y).toBeCloseTo(visualOriginalY as number, 0);
  expect(await stored()).toBe(visualPreference);
  expect(usageRequests).toBe(0);
  expect(uploadRequests).toBe(0);
});

Then("我验证缩放边界和拖动途中会话切换", async () => {
  const p = current();
  const cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 3 });
    await expect.poll(() => p.evaluate(() => window.visualViewport?.width ?? innerWidth)).toBeLessThan(640);
    await p.getByTestId("whale-drag").focus();
    for (let i = 0; i < 50; i++) await p.keyboard.press("Shift+ArrowRight");
    const bounds = await p.getByTestId("whale-pet").boundingBox();
    const visible = await p.evaluate(() => ({
      left: visualViewport?.offsetLeft ?? 0,
      width: visualViewport?.width ?? innerWidth,
    }));
    if (!bounds) throw new Error("Whale bounds unavailable");
    expect(bounds.width).toBe(160); // Layout viewport remains desktop even when visualViewport is narrow.
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(visible.left + visible.width - 11);
  } finally {
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await cdp.detach();
  }
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-position-reset").click();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expectDefaultPosition();
  const before = await p.getByTestId("whale-pet").boundingBox();
  if (!before) throw new Error("Whale bounds unavailable");
  await p.mouse.move(before.x + 60, before.y + 65);
  await p.mouse.down();
  await p.mouse.move(before.x - 50, before.y - 40, { steps: 8 });
  // A second actual WebSocket client switches the real Pi session while the pointer remains held.
  await p.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        let socket: WebSocket;
        let firstId = "";
        let finished = false;
        let reconnect: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
          finished = true;
          clearTimeout(timer);
          clearTimeout(reconnect);
          socket.close();
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Session switch timed out")), 15_000);
        const connect = () => {
          if (finished) return;
          socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
          // Real Pi replacement disposes sockets; reconnect only for observation, never re-dispatch /new.
          socket.onclose = () => {
            if (!finished) reconnect = setTimeout(connect, 100);
          };
          socket.onmessage = ({ data }) => {
            const message = JSON.parse(String(data));
            if (message.type === "res" && message.id === "whale-switch" && !message.ok) {
              finish(new Error(`Session switch rejected: ${message.error}`));
              return;
            }
            if (message.type === "event" && message.event === "webui_command_error") {
              finish(new Error("Session command failed"));
              return;
            }
            if (message.type !== "event" || message.event !== "state_sync") return;
            if (!firstId) {
              firstId = message.payload.sessionId;
              socket.send(
                JSON.stringify({ type: "req", id: "whale-switch", method: "prompt", params: { message: "/new" } }),
              );
            } else if (message.payload.sessionId !== firstId) finish();
          };
        };
        connect();
      }),
  );
  await expect(p.getByRole("log")).not.toContainText("SYNTHETIC_USAGE_RESPONSE");
  await p.mouse.up();
  await expect(p.getByTestId("whale-usage-card")).toHaveCount(0);
  expect(usageRequests).toBe(0);
  const moved = await p.getByTestId("whale-pet").boundingBox();
  if (!moved) throw new Error("Whale bounds unavailable");
  expect(moved.x).toBeLessThan(before.x);
  await p.reload();
  await expect.poll(async () => (await p.getByTestId("whale-pet").boundingBox())?.x).toBeCloseTo(moved.x, 0);
});

async function blobMime(p: Page, image: import("@playwright/test").Locator): Promise<string> {
  const source = await image.getAttribute("src");
  if (!source) throw new Error("Whale artwork image has no source");
  return p.evaluate(async (url) => (await (await fetch(url)).blob()).type, source);
}

async function storedIdleBytes(p: Page): Promise<Uint8Array> {
  const bytes = await p.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const request = indexedDB.open("pi-web-ui-whale-assets", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("assets", "readonly");
          const get = transaction.objectStore("assets").get("idle");
          get.onerror = () => reject(get.error);
          get.onsuccess = async () => {
            try {
              const blob = get.result as Blob | undefined;
              if (!blob) throw new Error("Idle artwork was not persisted");
              const content = Array.from(new Uint8Array(await blob.arrayBuffer()));
              resolve(content);
            } catch (error) {
              reject(error);
            } finally {
              database.close();
            }
          };
        };
      }),
  );
  return Uint8Array.from(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function nativeImageHash(image: import("@playwright/test").Locator): Promise<string> {
  // Screenshot the rendered <img> itself: Canvas drawImage would only expose an animated image's first frame.
  return sha256(await image.screenshot());
}

async function expectAnimatedGif(image: import("@playwright/test").Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => blobMime(current(), image)).toBe("image/gif");
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(16);
}

Then("我验证循环 GIF 播放、减弱动画和本地持久化", async () => {
  const p = current();
  expect(usageRequests).toBe(0);
  expect(uploadRequests).toBe(0);
  const expectedDigest = sha256(whaleGif);
  const settings = () => p.getByRole("region", { name: "Local whale artwork" });
  const thumbnail = () => settings().locator("img").first();
  const image = () => p.getByTestId("whale-pet").locator("img");
  const reduceCheckbox = () => p.getByRole("checkbox", { name: /Reduce companion animation/ });

  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-asset-idle").setInputFiles({
    name: "synthetic-two-frame.gif",
    mimeType: "image/gif",
    buffer: whaleGif,
  });
  await expect(p.getByTestId("whale-assets-status")).toContainText(/saved locally|saved|persistent|browser/i);
  await expect(thumbnail()).toBeVisible();
  await expect.poll(() => blobMime(p, thumbnail())).toBe("image/png");
  const persisted = await storedIdleBytes(p);
  expect(sha256(persisted)).toBe(expectedDigest);
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expectAnimatedGif(image());
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);

  // The image's native rendering changes between red/blue GIF frames (no Canvas readback).
  const initialFrameHash = await nativeImageHash(image());
  await expect
    .poll(
      async () => {
        await p.waitForTimeout(100);
        return nativeImageHash(image());
      },
      { timeout: 5_000 },
    )
    .not.toBe(initialFrameHash);

  // System reduced motion shows a static PNG, even if the user's own preference is off.
  await p.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => blobMime(p, image())).toBe("image/png");
  const systemPreviewHash = await nativeImageHash(image());
  await p.waitForTimeout(300);
  expect(await nativeImageHash(image())).toBe(systemPreviewHash);
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);
  await p.getByTestId("open-settings").click();
  await expect(reduceCheckbox()).not.toBeChecked();
  await reduceCheckbox().check();
  await expect(reduceCheckbox()).toBeChecked();
  await expect.poll(() => blobMime(p, thumbnail())).toBe("image/png");
  await reduceCheckbox().uncheck();
  await expect(reduceCheckbox()).not.toBeChecked();
  await expect.poll(() => blobMime(p, thumbnail())).toBe("image/png");
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect.poll(() => blobMime(p, image())).toBe("image/png");
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);
  await p.emulateMedia({ reducedMotion: "no-preference" });
  await expectAnimatedGif(image());

  // The user's setting alone has the same display-only effect and does not rewrite IndexedDB.
  await p.getByTestId("open-settings").click();
  await reduceCheckbox().check();
  await expect.poll(() => blobMime(p, thumbnail())).toBe("image/png");
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect.poll(() => blobMime(p, image())).toBe("image/png");
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);
  await p.getByTestId("open-settings").click();
  await reduceCheckbox().uncheck();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expectAnimatedGif(image());
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);

  // A malformed GIF and a real GIF declared as PNG both fail without replacing the saved original.
  await p.getByTestId("open-settings").click();
  const input = p.getByTestId("whale-asset-idle");
  await input.setInputFiles({
    name: "broken.gif",
    mimeType: "image/gif",
    buffer: Buffer.from([...Buffer.from("GIF89a"), 16, 0, 16, 0, 0, 0, 0]),
  });
  await expect(p.getByRole("alert")).toContainText(/GIF|image|file|format|invalid|unsupported|decode/i);
  await input.setInputFiles({ name: "gif-declared-png.png", mimeType: "image/png", buffer: whaleGif });
  await expect(p.getByRole("alert")).toContainText(/file type does not match/i);
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);
  await expect.poll(() => blobMime(p, thumbnail())).toBe("image/png");
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expectAnimatedGif(image());
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);

  await p.reload();
  await expectAnimatedGif(image());
  expect(sha256(await storedIdleBytes(p))).toBe(expectedDigest);
  const restoredFrameHash = await nativeImageHash(image());
  await expect
    .poll(
      async () => {
        await p.waitForTimeout(100);
        return nativeImageHash(image());
      },
      { timeout: 5_000 },
    )
    .not.toBe(restoredFrameHash);
  expect(usageRequests).toBe(0);
  expect(uploadRequests).toBe(0);
});

Then("我验证素材恢复竞态与部分持久化失败警告", async () => {
  const p = current();
  await importIdle();
  // Existing idle must survive a concurrent new-slot import while stored images decode slowly.
  await p.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) =>
      new Promise<ImageBitmap>((resolve, reject) => {
        setTimeout(() => {
          (decode as (...items: unknown[]) => Promise<ImageBitmap>)(...args).then(resolve, reject);
        }, 800);
      })) as typeof createImageBitmap;
  });
  await p.reload();
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-asset-success").setInputFiles({ name: "success.png", mimeType: "image/png", buffer: png });
  await expect(p.getByRole("region", { name: "Local whale artwork" }).locator("img")).toHaveCount(2);
  await expect(p.getByTestId("whale-assets-status")).toContainText("saved locally");
  // First write fails, next slot succeeds. The first slot must remain visibly marked temporary.
  await p.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (++calls === 1) throw new DOMException("Synthetic storage failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await p.getByTestId("whale-asset-idle").setInputFiles({ name: "temporary.png", mimeType: "image/png", buffer: png });
  await expect(p.getByTestId("whale-assets-status")).toContainText("This page only: Idle");
  await p
    .getByTestId("whale-asset-thinking")
    .setInputFiles({ name: "thinking.png", mimeType: "image/png", buffer: png });
  await expect(p.getByRole("region", { name: "Local whale artwork" }).locator("img")).toHaveCount(3);
  await expect(p.getByTestId("whale-assets-status")).toContainText("This page only: Idle");
  await expect(p.getByTestId("whale-assets-status")).not.toContainText("Assets are saved locally");
});

After(async () => {
  if (!harness) return;
  await context?.close();
  context = null;
  page = null;
  await harness.stop();
  harness = null;
});

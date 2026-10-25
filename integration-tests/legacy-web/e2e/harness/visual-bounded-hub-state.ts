/** Screenshot evidence through real Pi + packaged Hub, using only temporary synthetic sessions.
 * Playwright Chromium fallback: no callable in-app Browser automation is available.
 * No mocked routes, DOM/store injection, real providers, or production state.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { isBoundedGeneration } from "../../extensions/hub-generation.ts";
import { startHubCli } from "./hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./pi-process.ts";
import { observeBrowserErrors, startVisualEvidence } from "./visual-evidence.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const output = "docs/validation/artifacts/bounded-hub-state";
mkdirSync(output, { recursive: true });
const evidence = startVisualEvidence(`${output}/evidence.json`);
let browser: Browser | undefined;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function capture(page: Page, name: string) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No page horizontal overflow",
  );
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: "disabled" });
}

try {
  browser = await chromium.launch({ executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  for (const tools of [false, true]) {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const hub = await startHubCli({ repositoryRoot });
      let agent: PiWebUiHarness | undefined;
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let gate: ReturnType<typeof observeBrowserErrors> | undefined;
      const requests: { method: string; params: Record<string, unknown> }[] = [];
      const prefix = `${tools ? "tools" : "history"}-${viewport.width}`;
      try {
        context = await browser.newContext({ viewport, locale: "en", timezoneId: "UTC" });
        page = await context.newPage();
        gate = observeBrowserErrors(page);
        page.on("websocket", (socket) =>
          socket.on("framesent", (frame) => {
            const record = JSON.parse(String(frame.payload));
            if (record.type === "req") requests.push(record);
          }),
        );
        agent = await startPiWebUi("chat-lifecycle", {
          repositoryRoot,
          datedHistory: true,
          boundedVisualHistory: tools,
          registration: hub.issue("bounded-visual"),
        });
        const name = readdirSync(agent.sessionDir).find((name) => name.includes("8e91f4c2-3000"));
        assert.ok(name);
        const sessionFile = path.join(agent.sessionDir, name);
        const before = hash(sessionFile);
        let route = "";
        await expect
          .poll(async () => {
            route = (await (await fetch(`${hub.url}api/sessions`)).json()).sessions[0]?.path ?? "";
            return isBoundedGeneration(route.split("/")[2]);
          })
          .toBe(true);
        await page.goto(new URL(route, hub.url).href);
        await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
        await expect(page.getByRole("log")).toContainText(tools ? "BOUNDED_VISUAL_END" : "DATED_RECENT_END_MARKER");
        const preview = tools
          ? page.locator('[data-chat-item-kind="system"]').filter({ hasText: "History preview." }).last()
          : page.locator('[data-chat-item-kind="message"]').filter({ hasText: "DATED_LARGE_START" });
        const control = preview.getByRole("button", { name: "Load entry detail", exact: true });
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
        await capture(page, `${prefix}-preview`);
        assert.equal(requests.filter((r) => r.method === "get_entry_detail").length, 0, "No automatic detail prefetch");
        await control.click();
        const dialog = page.getByRole("dialog", { name: "Entry detail", exact: true });
        await expect(dialog.locator("pre")).toContainText(tools ? "OMITTED_TOOL_START" : "DATED_LARGE_START_");
        await expect(dialog.getByRole("button", { name: "Next detail chunk" })).toBeInViewport();
        await capture(page, `${prefix}-detail-first`);
        const firstText = await dialog.locator("pre").innerText();
        await dialog.getByRole("button", { name: "Next detail chunk" }).click();
        await expect(dialog.locator("pre")).not.toHaveText(firstText);
        await expect(dialog.getByRole("button", { name: "Next detail chunk" })).toBeEnabled();
        const nextText = await dialog.locator("pre").innerText();
        assert.ok(!nextText.includes(tools ? "OMITTED_TOOL_START" : "DATED_LARGE_START_"));
        assert.ok(Buffer.byteLength(nextText) <= 64 * 1024);
        assert.equal(requests.filter((r) => r.method === "get_entry_detail").length, 2);
        await capture(page, `${prefix}-detail-next`);
        // Change the real Pi branch from its RPC command context while the dialog is open.
        // This is a product event, not a direct frontend state change.
        await agent.rpc({ type: "prompt", message: "/webui" });
        // A second real browser transport issues the navigation, preserving the open dialog in this page.
        const { default: WebSocket } = await import("ws");
        const socketUrl = new URL(`${route}ws`, hub.url);
        socketUrl.protocol = "ws:";
        const socket = new WebSocket(socketUrl, { origin: new URL(hub.url).origin });
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Navigation timed out")), 10000);
            socket.once("error", reject);
            socket.once("open", () =>
              socket.send(
                JSON.stringify({
                  type: "req",
                  id: "visual-nav",
                  method: "navigate_tree",
                  params: { entryId: "datedbig" },
                }),
              ),
            );
            socket.on("message", (raw) => {
              const value = JSON.parse(String(raw));
              if (value.type === "res" && value.id === "visual-nav") {
                clearTimeout(timer);
                if (value.ok) resolve();
                else reject(new Error(value.error));
              }
            });
          });
        } finally {
          socket.terminate();
        }
        await expect(dialog).toBeHidden();
        await capture(page, `${prefix}-scope-reset`);
        await page.getByRole("button", { name: "Expand date filters", exact: true }).click();
        const oldDate = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        await page.getByLabel("History start date", { exact: true }).fill(oldDate);
        await page.getByLabel("History end date", { exact: true }).fill(oldDate);
        await page.getByRole("button", { name: "Apply dates", exact: true }).click();
        await expect(page.getByRole("log")).toContainText("DATED_OLD_ONLY_MARKER");
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("log")).not.toContainText("DATED_LARGE_START");
        await capture(page, `${prefix}-old-date`);
        gate.assertClean();
        assert.equal(hash(sessionFile), before, "Visual reads and navigation preserve original JSONL");
        evidence.recordCase({
          status: "passed",
          url: page.url(),
          viewport,
          fixture: tools ? "tool-eviction" : "20MiB-history",
          ...gate.errors,
          screenshots: ["preview", "detail-first", "detail-next", "scope-reset", "old-date"].map(
            (s) => `${output}/${prefix}-${s}.png`,
          ),
          detailRequests: 2,
          firstTextBytes: Buffer.byteLength(firstText),
          nextTextBytes: Buffer.byteLength(nextText),
          jsonlHashBefore: before,
          jsonlHashAfter: hash(sessionFile),
        });
      } catch (error) {
        // Failure evidence must survive even when taking a diagnostic screenshot fails.
        evidence.recordCase({
          status: "failed",
          viewport,
          fixture: tools ? "tool-eviction" : "20MiB-history",
          ...gate?.errors,
          failureHash: createHash("sha256").update(String(error)).digest("hex"),
        });
        await page?.screenshot({ path: `${output}/${prefix}-failure.png`, fullPage: true });
        throw error;
      } finally {
        gate?.stop();
        try {
          await context?.close();
        } finally {
          try {
            await agent?.stop();
          } finally {
            await hub.close();
          }
        }
      }
    }
  }
  await browser.close();
  browser = undefined;
  evidence.finish("passed");
  console.log("Visual evidence passed: 4 cases; five browser-error arrays empty per case; no failure exclusions.");
} catch (error) {
  evidence.finish("failed");
  throw error;
} finally {
  await browser?.close();
}

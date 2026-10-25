/** Actual Pi/packaged-Hub flow; Playwright Chromium fallback, no store/DOM injection. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, expect } from "@playwright/test";
import { isBoundedGeneration } from "../../extensions/hub-generation";
import { startHubCli } from "./hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "./pi-process";
import { observeBrowserErrors, startVisualEvidence } from "./visual-evidence";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const output = "docs/validation/artifacts/bounded-tool-toggle";
mkdirSync(output, { recursive: true });
const evidence = startVisualEvidence(`${output}/evidence.json`);
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const hub = await startHubCli({ repositoryRoot });
    let agent: PiWebUiHarness | undefined;
    let context: BrowserContext | undefined;
    let gate: ReturnType<typeof observeBrowserErrors> | undefined;
    try {
      context = await browser.newContext({ viewport, locale: "en", timezoneId: "UTC" });
      const page = await context.newPage();
      gate = observeBrowserErrors(page);
      const detailIds: string[] = [];
      page.on("websocket", (socket) =>
        socket.on("framesent", (frame) => {
          const message = JSON.parse(String(frame.payload));
          if (message.type === "req" && message.method === "get_entry_detail") detailIds.push(message.params.entryId);
        }),
      );
      agent = await startPiWebUi("chat-lifecycle", {
        repositoryRoot,
        boundedToolToggle: true,
        registration: hub.issue("toggle-visual"),
      });
      const name = readdirSync(agent.sessionDir).find((name) => name.includes("000000000004"));
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
      await page.getByRole("button", { name: "Expand date filters", exact: true }).click();
      await page.getByLabel("History start date", { exact: true }).fill("2023-11-14");
      await page.getByLabel("History end date", { exact: true }).fill("2023-11-14");
      await page.getByRole("button", { name: "Apply dates", exact: true }).click();
      const rows = page.locator('[data-chat-item-kind="tool"]');
      await expect(rows).toHaveCount(15);
      await expect(page.getByText("Showing 15 of 16 entries", { exact: true })).toBeVisible();
      const screenshots: string[] = [];
      const capture = async (suffix: string) => {
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "No page horizontal overflow",
        );
        const file = `${output}/toggle-${viewport.width}-${suffix}.png`;
        await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
        screenshots.push(file);
      };
      const command = async (name: string) => {
        await page.getByRole("button", { name: "Open command palette", exact: true }).click();
        await page.getByRole("button", { name: new RegExp(name) }).click();
        await expect(rows).toHaveCount(15);
        await expect(page.getByText("Showing 15 of 16 entries", { exact: true })).toBeVisible();
      };
      await capture("initial");
      await command("Expand All Tools");
      await expect(rows.locator('button[data-slot="collapsible-trigger"][aria-expanded="true"]')).toHaveCount(15);
      // Frame the code block rather than a card taller than the viewport.
      // Code blocks use content-visibility:auto: text presence alone does not
      // prove that a newly scrolled-in block has left its skipped-render state.
      await expect(rows.first().locator("pre").last()).toContainText('"custom"');
      await rows.first().locator("[data-language]").first().scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          rows
            .first()
            .locator("pre")
            .first()
            .evaluate((element) => element.checkVisibility({ contentVisibilityAuto: true })),
        )
        .toBe(true);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await capture("all-open");
      await command("Collapse All Tools");
      await expect(rows.locator('button[data-slot="collapsible-trigger"][aria-expanded="false"]')).toHaveCount(15);
      const firstToggle = rows.first().locator('button[data-slot="collapsible-trigger"]');
      await firstToggle.click();
      await expect(firstToggle).toHaveAttribute("aria-expanded", "true");
      await capture("single-open");
      await firstToggle.click();
      await expect(rows).toHaveCount(15);
      await page.getByRole("button", { name: "Older page", exact: true }).click();
      await expect(rows).toHaveCount(1);
      await expect(page.getByText("Showing 1 of 16 entries", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Older page", exact: true })).toHaveCount(0);
      const detail = page.getByRole("button", { name: "Load entry detail", exact: true });
      await detail.scrollIntoViewIfNeeded();
      await expect(detail).toBeInViewport();
      await capture("older-e0");
      assert.deepEqual(detailIds, [], "No automatic detail fetch");
      await detail.click();
      const dialog = page.getByRole("dialog", { name: "Entry detail", exact: true });
      await expect(dialog.locator("pre")).toContainText("custom");
      assert.deepEqual(detailIds, ["e0"], "Older-page row retains its exact detail identity");
      await capture("e0-detail");
      gate.assertClean();
      assert.equal(hash(sessionFile), before);
      evidence.recordCase({
        status: "passed",
        fixture: "near-byte-limit-tool-toggle",
        url: page.url(),
        viewport,
        ...gate.errors,
        screenshots,
        rowsBeforeAndAfterToggles: 15,
        olderPageRows: 1,
        detailIds,
        jsonlHashBefore: before,
        jsonlHashAfter: hash(sessionFile),
      });
    } catch (error) {
      evidence.recordCase({
        status: "failed",
        viewport,
        ...gate?.errors,
        failureHash: createHash("sha256").update(String(error)).digest("hex"),
      });
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
  await browser.close();
  browser = undefined;
  evidence.finish("passed");
  console.log(
    "Tool-toggle visual evidence passed: 2 cases; five browser-error arrays empty; exact e0 detail recovered; JSONL unchanged.",
  );
} catch (error) {
  evidence.finish("failed");
  throw error;
} finally {
  await browser?.close();
}

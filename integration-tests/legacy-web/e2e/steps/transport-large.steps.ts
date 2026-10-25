import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { transportContent } from "../fixtures/transport-data";
import { type HubCliHarness, startHubCli } from "../harness/hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let hub: HubCliHarness | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let errors: string[] = [];
let omitted = 0;
let maxBytes = 0;
let deltaFrames = 0;
let duplicatedDeltas = 0;
let omittedSources: string[] = [];
let syncRequests = 0;

async function open(browser: import("@playwright/test").Browser, useHub: boolean) {
  const repositoryRoot = path.resolve(__dirname, "../..");
  if (useHub) hub = await startHubCli({ repositoryRoot });
  harness = await startPiWebUi("transport-large", { registration: hub?.issue("transport-large") });
  let url = harness.pageUrl;
  if (hub) {
    let route: string | undefined;
    await expect
      .poll(async () => {
        const result = await (await fetch(`${hub?.url}api/sessions`)).json();
        route = result.sessions[0]?.path;
        return route;
      })
      .toBeTruthy();
    url = new URL(route as string, hub.url).href;
  }
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  page = await context.newPage();
  errors = [];
  omitted = 0;
  maxBytes = 0;
  deltaFrames = 0;
  duplicatedDeltas = 0;
  omittedSources = [];
  syncRequests = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (JSON.parse(String(payload)).method === "sync_request") syncRequests++;
    });
    socket.on("framereceived", ({ payload }) => {
      maxBytes = Math.max(maxBytes, Buffer.byteLength(payload));
      const frame = JSON.parse(String(payload));
      if (frame.type === "error") errors.push(frame.code);
      if (frame.event === "transport_omitted") {
        omitted++;
        omittedSources.push(frame.payload.sourceEvent);
      }
      if (frame.event === "message_update" && /_delta$/.test(frame.payload?.assistantMessageEvent?.type ?? "")) {
        deltaFrames++;
        if ("message" in frame.payload || "partial" in frame.payload.assistantMessageEvent) duplicatedDeltas++;
      }
    });
  });
  await page.goto(url);
  await expect(page.getByTestId("message-input")).toBeVisible();
}
When("我打开直连大型传输真实 Pi 页面", async ({ browser }) => open(browser, false));
When("我打开 Hub 大型传输真实 Pi 页面", async ({ browser }) => open(browser, true));
Then("我验证大型传输提示、有界恢复与原文件", async () => {
  if (!page || !harness) throw new Error("Transport fixture unavailable");
  const p = page;
  await p.getByTestId("message-input").fill("Run synthetic transport fixture");
  await p.getByTestId("submit-message").click();
  await expect(p.getByRole("log")).toContainText("TRANSPORT_RECOVERY_COMPLETE", { timeout: 60_000 });
  await expect(p.getByRole("button", { name: "Completed write transport-large.txt", exact: true })).toBeVisible();
  await expect(p.getByTestId("transport-notice")).toContainText("full data remains in the original session");
  expect(errors).toEqual([]);
  expect(omitted).toBeGreaterThan(0);
  expect(deltaFrames).toBeGreaterThan(0);
  expect(duplicatedDeltas).toBe(0);
  expect(omittedSources).toContain("tool_execution_start");
  expect(omittedSources).toContain("tool_execution_end");
  await expect(p.getByTestId("submit-message")).toHaveAttribute("aria-label", "Submit");
  expect(maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  await p.waitForTimeout(750); // Allow the 250ms terminal debounce to settle.
  const settledSyncRequests = syncRequests;
  expect(settledSyncRequests).toBeLessThan(12);
  await p.waitForTimeout(600);
  expect(syncRequests).toBe(settledSyncRequests);
  const actual = readFileSync(path.join(harness.workspaceDir, "transport-large.txt"));
  expect(actual.length).toBe(Buffer.byteLength(transportContent));
  expect(createHash("sha256").update(actual).digest("hex")).toBe(
    createHash("sha256").update(transportContent).digest("hex"),
  );
  const sessionDir = harness.sessionDir;
  const persisted = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(path.join(sessionDir, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  const toolCall = persisted
    .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
    .find((block) => block.type === "toolCall" && block.name === "write");
  expect(toolCall?.arguments.content).toBe(transportContent);
  const result = persisted.find((entry) => entry.message?.role === "toolResult");
  expect(result?.message.content[0]?.text).toBe(`TRANSPORT_RESULT_${transportContent}`);
  await p.getByRole("button", { name: "Dismiss transport notice", exact: true }).click();
  await expect(p.getByTestId("transport-notice")).toHaveCount(0);
  await p.reload();
  await expect(p.getByRole("log")).toContainText("TRANSPORT_RECOVERY_COMPLETE");
  await expect(p.getByRole("button", { name: "Completed write transport-large.txt", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
After(async () => {
  if (!harness) return;
  try {
    await context?.close();
  } finally {
    try {
      await harness.stop();
    } finally {
      await hub?.close();
    }
  }
  page = null;
  context = null;
  harness = null;
  hub = null;
});

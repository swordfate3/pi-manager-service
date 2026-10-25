import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { type BrowserContext, type CDPSession, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type HubCliHarness, startHubCli } from "../harness/hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();
const textBytes = Buffer.from("UPLOAD_TEXT_CONTENT_MARKER：上传说明原始内容。\n");
const binaryBytes = Buffer.alloc(17 * 1024 * 1024, 0xa7);
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
let agent: PiWebUiHarness | undefined;
let hub: HubCliHarness | undefined;
let context: BrowserContext | undefined;
let browserPage: Page | undefined;
let cdp: CDPSession | undefined;
let screen = "desktop";
let promptFrames: Record<string, unknown>[] = [];
let prepareCount = 0;
let uploadRequests = 0;
let initialSessionId = "";
let latestSessionId = "";
let stateSyncCount = 0;
let maxRequestFrame = 0;
let uploadChunkRequests: { uploadId: string; index: number; stateSyncCount: number }[] = [];
let acknowledgedChunks = new Map<string, number[]>();
let prepareRequestNames = new Map<string, string>();
let uploadNames = new Map<string, string>();
let prepareResponses: { filename: string; uploadId: string; nextChunk: number }[] = [];
let resumeTextPath = "";
let stateSyncBeforeReload = 0;
let resumeBinaryPath = "";
let resumeBinaryDigest = "";

function page() {
  if (!browserPage) throw new Error("Upload fixture not started");
  return browserPage;
}

function createResumeBinary(filename: string) {
  const fd = openSync(filename, "wx", 0o600);
  const hash = createHash("sha256");
  const block = Buffer.allocUnsafe(1024 * 1024);
  const size = 17 * 1024 * 1024;
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(block.length, size - offset);
      for (let index = 0; index < length; index++) block[index] = (offset + index) % 251;
      const bytes = block.subarray(0, length);
      hash.update(bytes);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
      offset += length;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

async function waitForChunkAcks(uploadId: string, count: number) {
  await expect
    .poll(() => acknowledgedChunks.get(uploadId)?.length ?? 0, { timeout: 60000 })
    .toBeGreaterThanOrEqual(count);
}

async function hashFile(filename: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

function savedFiles() {
  if (!agent) throw new Error("Missing upload workspace");
  const root = path.join(agent.workspaceDir, ".pi-uploads");
  const files: string[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && !entry.name.startsWith(".")) files.push(file);
    }
  };
  try {
    scan(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

async function throttleUploads() {
  if (!cdp) cdp = await context?.newCDPSession(page());
  await cdp?.send("Network.enable");
  await cdp?.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: 1024 * 1024,
  });
}

Given("附件上传测试通过 {string} 在 {string} 打开", async ({ browser }, route: string, viewport: string) => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  screen = viewport;
  if (route === "hub") hub = await startHubCli({ repositoryRoot });
  agent = await startPiWebUi("file-upload", {
    repositoryRoot,
    git: false,
    registration: hub?.issue("synthetic-upload"),
  });
  let url = agent.pageUrl;
  if (hub) {
    let routePath = "";
    await expect
      .poll(async () => {
        const listing = await (await fetch(`${hub?.url}api/sessions`)).json();
        routePath = listing.sessions[0]?.path ?? "";
        return routePath;
      })
      .toBeTruthy();
    url = new URL(routePath, hub.url).href;
  }
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: screen === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  browserPage = await context.newPage();
  promptFrames = [];
  initialSessionId = "";
  latestSessionId = "";
  prepareCount = 0;
  uploadRequests = 0;
  stateSyncCount = 0;
  maxRequestFrame = 0;
  uploadChunkRequests = [];
  acknowledgedChunks = new Map();
  prepareRequestNames = new Map();
  uploadNames = new Map();
  prepareResponses = [];
  resumeTextPath = "";
  resumeBinaryPath = "";
  stateSyncBeforeReload = 0;
  resumeBinaryDigest = "";
  page().on("request", (request) => {
    if (request.method() !== "PUT") return;
    const match = new URL(request.url()).pathname.match(/\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/);
    if (match) uploadChunkRequests.push({ uploadId: match[1], index: Number(match[2]), stateSyncCount });
    if (new URL(request.url()).pathname.includes("/api/uploads/")) uploadRequests++;
  });
  page().on("requestfinished", async (request) => {
    if (request.method() !== "PUT" || !new URL(request.url()).pathname.includes("/chunks/")) return;
    try {
      const response = await request.response();
      if (!response?.ok()) return;
      const result = await response.json();
      if (typeof result.uploadId === "string" && Number.isInteger(result.nextChunk)) {
        const chunks = acknowledgedChunks.get(result.uploadId) ?? [];
        const index = result.nextChunk - 1;
        if (!chunks.includes(index)) chunks.push(index);
        acknowledgedChunks.set(result.uploadId, chunks);
      }
    } catch {
      // An interrupted request has no acknowledgement and is intentionally absent.
    }
  });
  page().on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "event" && value.event === "state_sync") {
        stateSyncCount++;
        latestSessionId = value.payload.sessionId;
        if (!initialSessionId) initialSessionId = latestSessionId;
      }
      if (value.type === "res" && prepareRequestNames.has(value.id) && value.ok) {
        const filename = prepareRequestNames.get(value.id);
        if (filename && typeof value.result?.uploadId === "string") {
          uploadNames.set(filename, value.result.uploadId);
          prepareResponses.push({ filename, uploadId: value.result.uploadId, nextChunk: value.result.nextChunk ?? 0 });
        }
      }
    });
    socket.on("framesent", (frame) => {
      maxRequestFrame = Math.max(maxRequestFrame, Buffer.byteLength(String(frame.payload)));
      const value = JSON.parse(String(frame.payload));
      if (value.type === "req" && value.method === "prompt") promptFrames.push(value.params);
      if (value.type === "req" && value.method === "prepare_upload") {
        prepareCount++;
        if (typeof value.params?.filename === "string") prepareRequestNames.set(value.id, value.params.filename);
      }
    });
  });
  await page().goto(url);
  await expect(page().getByTestId("message-input")).toBeVisible();
  const uploadButton = page().getByTestId("attachment-add");
  await expect(uploadButton).toBeVisible();
  await expect(uploadButton).toHaveAccessibleName("上传文件");
  await expect(uploadButton).toHaveText("上传文件");
  await expect(uploadButton.locator("svg.lucide-paperclip")).toBeVisible();
  await expect.poll(() => initialSessionId).toBeTruthy();
});

When("我选择中文说明、原始图片和大于消息限制的二进制附件", async () => {
  await page()
    .locator('input[type="file"]')
    .setInputFiles([
      { name: "中文说明.txt", mimeType: "text/plain", buffer: textBytes },
      { name: "原始图片.png", mimeType: "image/png", buffer: imageBytes },
      { name: "large-fixture.bin", mimeType: "application/octet-stream", buffer: binaryBytes },
    ]);
  await expect(page().getByTestId("attachment-item")).toHaveCount(3);
});

Then("选择附件不会立即写入工作区", async () => {
  expect(prepareCount).toBe(0);
  expect(uploadRequests).toBe(0);
  expect(savedFiles()).toHaveLength(0);
});

When("我发送附件并让 Pi 读取上传说明", async ({ $testInfo }) => {
  await throttleUploads();
  await page().getByTestId("message-input").fill("请读取附件中的中文说明文件。");
  await page().getByTestId("submit-message").click();
  await expect(page().getByTestId("upload-cancel")).toBeVisible();
  await expect(page().getByTestId("upload-progress").first()).toBeVisible();
  await page().screenshot({ path: $testInfo.outputPath(`upload-progress-${screen}.png`), fullPage: true });
  expect(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page().getByRole("log")).toContainText("已通过真实 read 工具读取上传的中文说明文件。", {
    timeout: 45000,
  });
});

Then("附件按原始字节保存在当前会话目录且 Pi 收到文件路径", async () => {
  const files = savedFiles();
  expect(files).toHaveLength(3);
  for (const [name, bytes] of [
    ["中文说明.txt", textBytes],
    ["原始图片.png", imageBytes],
    ["large-fixture.bin", binaryBytes],
  ] as const) {
    const file = files.find((candidate) => path.basename(candidate) === name);
    expect(file).toBeTruthy();
    expect(readFileSync(file ?? "")).toEqual(bytes);
    expect(file?.startsWith(path.join(agent?.workspaceDir ?? "", ".pi-uploads", initialSessionId) + path.sep)).toBe(
      true,
    );
    expect(statSync(file ?? "").mode & 0o077).toBe(0);
  }
  expect(promptFrames).toHaveLength(1);
  expect(promptFrames[0].uploads).toHaveLength(3);
  expect(promptFrames[0].images).toBeUndefined();
  const sessionFiles = readdirSync(agent?.sessionDir ?? "").filter((name) => name.endsWith(".jsonl"));
  const session = sessionFiles.map((file) => readFileSync(path.join(agent?.sessionDir ?? "", file), "utf8")).join("\n");
  expect(session).toContain("UPLOAD_TEXT_CONTENT_MARKER");
  expect(session).toContain(".pi-uploads/");
  expect(session).toContain('"name":"read"');
});

When("附件保存目录被符号链接阻断", async () => {
  if (!agent) throw new Error("Missing upload workspace");
  symlinkSync(agent.sessionDir, path.join(agent.workspaceDir, ".pi-uploads"));
});

When("我尝试发送附件", async () => {
  await page().getByTestId("message-input").fill("请读取附件中的中文说明文件。");
  await page().getByTestId("submit-message").click();
});

Then("上传失败不会发送消息且附件和草稿保留", async () => {
  await expect(page().getByRole("alert").first()).toBeVisible();
  await expect(page().getByTestId("upload-cancel")).toBeHidden();
  await expect(page().getByTestId("attachment-item")).toHaveCount(3);
  await expect(page().getByTestId("message-input")).toHaveValue("请读取附件中的中文说明文件。");
  expect(promptFrames).toHaveLength(0);
  // prepare grants a receipt; the PUT is where secure directory traversal rejects the symlink.
  expect(uploadRequests).toBe(1);
  expect(readdirSync(agent?.sessionDir ?? "").filter((name) => name.includes("upload"))).toHaveLength(0);
});

When("恢复正常目录后重试上传", async () => {
  if (!agent) throw new Error("Missing upload workspace");
  unlinkSync(path.join(agent.workspaceDir, ".pi-uploads"));
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("已通过真实 read 工具读取上传的中文说明文件。", {
    timeout: 45000,
  });
});

Then("上传过程中可见进度且聊天帧不含附件原始数据", async () => {
  // The 17 MiB binary needs three 8 MiB chunk PUTs; text and image need one each.
  expect(uploadRequests).toBe(5);
  expect(prepareCount).toBe(3);
  expect(maxRequestFrame).toBeLessThan(32 * 1024);
});

When("我选择超过单文件限制的附件", async () => {
  if (!agent) throw new Error("Missing upload workspace");
  // Selection rejects by file metadata; this sparse file is never read into memory.
  const file = path.join(agent.sessionDir, "too-large.bin");
  writeFileSync(file, "");
  truncateSync(file, 8 * 1024 * 1024 * 1024 + 1);
  await page().locator('input[type="file"]').setInputFiles(file);
});

Then("网页拒绝超限文件且不会上传", async () => {
  await expect(page().getByRole("alert")).toBeVisible();
  await expect(page().getByTestId("attachment-item")).toHaveCount(0);
  expect(prepareCount).toBe(0);
  expect(uploadRequests).toBe(0);
});

When("我取消进行中的附件上传", async () => {
  await throttleUploads();
  await page().getByTestId("message-input").fill("UPLOAD_CANCEL_DRAFT");
  await page().getByTestId("submit-message").click();
  await expect(page().getByTestId("upload-cancel")).toBeVisible();
  await page().getByTestId("upload-cancel").click();
});

When("两个附件保存后取消最后一个上传", async () => {
  await throttleUploads();
  await page().getByTestId("message-input").fill("UPLOAD_CANCEL_DRAFT");
  await page().getByTestId("submit-message").click();
  await expect.poll(() => uploadRequests).toBe(3);
  await expect.poll(() => savedFiles().length).toBe(2);
  await page().getByTestId("upload-cancel").click();
});

When("我重试已取消的附件提交", async () => {
  await page().getByTestId("message-input").fill("请读取附件中的中文说明文件。");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("已通过真实 read 工具读取上传的中文说明文件。", {
    timeout: 45000,
  });
});

Then("重试只重新上传被取消的文件", async () => {
  expect(prepareCount).toBe(4);
  // Two completed one-chunk files stay saved; retry sends all three chunks of
  // the cancelled 17 MiB file (including its unacknowledged first chunk).
  expect(uploadRequests).toBe(6);
  expect(promptFrames).toHaveLength(1);
});

When("上传期间其他网页创建新会话", async () => {
  if (!context || !agent) throw new Error("Missing upload fixture");
  const control = await context.newPage();
  await control.goto(agent.pageUrl);
  await expect(control.getByTestId("message-input")).toBeVisible();
  await throttleUploads();
  await page().getByTestId("message-input").fill("OLD_SCOPE_UPLOAD_DRAFT");
  await page().getByTestId("submit-message").click();
  await expect.poll(() => uploadRequests).toBe(3);
  await expect.poll(() => savedFiles().length).toBe(2);
  await control.getByTestId("message-input").fill("/new");
  await control.getByTestId("submit-message").click();
  await expect(control.getByRole("log")).not.toContainText("OLD_SCOPE_UPLOAD_DRAFT");
  await control.close();
});

Then("新会话不保留旧附件也不自动发送且已完成文件仍保留", async () => {
  await expect(page().getByTestId("attachment-item")).toHaveCount(0);
  await expect(page().getByTestId("upload-cancel")).toBeHidden();
  await expect(page().getByTestId("message-input")).toBeEnabled();
  expect(promptFrames).toHaveLength(0);
  await expect.poll(() => savedFiles().length).toBe(2);
  expect(savedFiles().every((file) => file.includes(`${path.sep}${initialSessionId}${path.sep}`))).toBe(true);
  // Pi defers creating JSONL until a message is persisted; compare real sync identities, not file counts.
  await expect.poll(() => latestSessionId).not.toBe(initialSessionId);
  expect(latestSessionId).toBeTruthy();
});

Then("取消上传不会发送 Pi 消息且草稿保留", async () => {
  await expect(page().getByTestId("message-input")).toHaveValue("UPLOAD_CANCEL_DRAFT");
  await expect(page().getByTestId("upload-cancel")).toBeHidden();
  expect(promptFrames).toHaveLength(0);
  await expect(page().getByTestId("attachment-item")).toHaveCount(3);
});

When("我选择可恢复的大文件附件", async () => {
  if (!agent) throw new Error("Missing upload workspace");
  resumeTextPath = path.join(agent.sessionDir, "中文说明.txt");
  writeFileSync(resumeTextPath, textBytes, { mode: 0o600 });
  resumeBinaryPath = path.join(agent.sessionDir, "resume-original-binary.bin");
  resumeBinaryDigest = createResumeBinary(resumeBinaryPath);
  await page().locator('input[type="file"]').setInputFiles([resumeTextPath, resumeBinaryPath]);
  await expect(page().getByTestId("attachment-item")).toHaveCount(2);
});

When("上传至少两个分片确认后刷新浏览器", async () => {
  await throttleUploads();
  await page().getByTestId("message-input").fill("请读取附件中的中文说明文件。");
  await page().getByTestId("submit-message").click();
  await expect(page().getByTestId("upload-cancel")).toBeVisible();
  await expect.poll(() => uploadNames.get("resume-original-binary.bin"), { timeout: 30000 }).toBeTruthy();
  const uploadId = uploadNames.get("resume-original-binary.bin");
  if (!uploadId) throw new Error("Binary upload preparation was not observed");
  await waitForChunkAcks(uploadId, 2);
  stateSyncBeforeReload = stateSyncCount;
  const confirmedBeforeReload = [...(acknowledgedChunks.get(uploadId) ?? [])];
  expect(confirmedBeforeReload.length).toBeGreaterThanOrEqual(2);
  await page().reload();
  await expect(page().getByTestId("message-input")).toBeVisible();
  await expect.poll(() => stateSyncCount).toBeGreaterThan(stateSyncBeforeReload);
  expect(promptFrames).toHaveLength(0);
});

When("我重选同一个文件并发送", async () => {
  await page().locator('input[type="file"]').setInputFiles([resumeTextPath, resumeBinaryPath]);
  await expect(page().getByTestId("attachment-item")).toHaveCount(2);
  await page().getByTestId("message-input").fill("请读取附件中的中文说明文件。");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("已通过真实 read 工具读取上传的中文说明文件。", {
    timeout: 60000,
  });
});

Then("刷新后只上传服务端尚未确认的分片且 Pi 收到路径", async () => {
  if (!agent) throw new Error("Missing upload workspace");
  const preparedAgain = prepareResponses.filter((entry) => entry.filename === "resume-original-binary.bin");
  expect(preparedAgain.length).toBeGreaterThanOrEqual(2);
  const [beforeReload, afterReload] = preparedAgain.slice(-2);
  expect(afterReload.uploadId).toBe(beforeReload.uploadId);
  expect(afterReload.nextChunk).toBeGreaterThanOrEqual(2);
  const totalChunks = Math.ceil(statSync(resumeBinaryPath).size / (8 * 1024 * 1024));
  expect(afterReload.nextChunk).toBeLessThan(totalChunks);
  const postReloadPuts = uploadChunkRequests
    .filter((entry) => entry.uploadId === beforeReload.uploadId && entry.stateSyncCount > stateSyncBeforeReload)
    .map((entry) => entry.index);
  expect(postReloadPuts).toEqual(
    Array.from({ length: totalChunks - afterReload.nextChunk }, (_, i) => afterReload.nextChunk + i),
  );
  expect(postReloadPuts.some((index) => index < afterReload.nextChunk)).toBe(false);

  const files = savedFiles();
  expect(files).toHaveLength(2);
  const textFile = files.find((file) => path.basename(file) === "中文说明.txt");
  const binaryFile = files.find((file) => path.basename(file) === "resume-original-binary.bin");
  expect(textFile).toBeTruthy();
  expect(binaryFile).toBeTruthy();
  expect(readFileSync(textFile ?? "")).toEqual(textBytes);
  expect(await hashFile(binaryFile ?? "")).toBe(resumeBinaryDigest);
  expect(promptFrames).toHaveLength(1);
  expect(promptFrames[0].uploads).toHaveLength(2);
  expect(promptFrames[0].images).toBeUndefined();
  expect(JSON.stringify(promptFrames[0])).not.toContain(textBytes.toString("utf8"));
  const sessionFiles = readdirSync(agent.sessionDir).filter((name) => name.endsWith(".jsonl"));
  const sessionDir = agent.sessionDir;
  const session = sessionFiles.map((file) => readFileSync(path.join(sessionDir, file), "utf8")).join("\n");
  expect(session).toContain("UPLOAD_TEXT_CONTENT_MARKER");
  expect(session).toContain(".pi-uploads/");
  expect(session).toContain('"name":"read"');
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
  cdp = undefined;
  agent = undefined;
  hub = undefined;
});

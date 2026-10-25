import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolToggleEntries, toolToggleRange } from "../fixtures/bounded-tool-toggle";

export type PiWebUiHarness = {
  pageUrl: string;
  port: number;
  workspaceDir: string;
  sessionDir: string;
  rpc: (command: Record<string, unknown>) => Promise<unknown>;
  respondToUI: (id: string, confirmed: boolean) => void;
  stop: () => Promise<void>;
};

export type PiWebUiHarnessOptions = {
  extraExtensions?: string[];
  onRpcEvent?: (event: Record<string, unknown>) => void;
  git?: boolean;
  longSession?: boolean;
  /** A saved conversation whose original snapshot exceeds the Hub frame limit. */
  datedHistory?: boolean;
  /** Real persisted tool rows that exercise browser eviction and system preview controls. */
  boundedVisualHistory?: boolean;
  /** Compact valid history whose rendered tool rows approach the browser byte limit. */
  boundedToolToggle?: boolean;
  /** Synthetic multi-model, mixed-priced usage across branches and dates. */
  usageHistory?: boolean;
  /** Optional immutable release root; defaults to the working repository. */
  runtimeDir?: string;
  /** Explicit root for Node ESM integration runners (Playwright supplies __dirname). */
  repositoryRoot?: string;
  registration?: { socketPath: string; credentialFile: string };
};

export async function startPiWebUi(fixtureName: string, options: PiWebUiHarnessOptions = {}): Promise<PiWebUiHarness> {
  const repoRoot = options.repositoryRoot ?? path.resolve(__dirname, "../..");
  const selectedRuntime = options.runtimeDir ?? process.env.PI_E2E_RUNTIME_DIR;
  const runtimeDir = selectedRuntime ? path.resolve(selectedRuntime) : repoRoot;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-web-ui-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const externalDir = path.join(tempRoot, "external");
  const agentDir = path.join(tempRoot, "agent");
  const sessionDir = path.join(tempRoot, "sessions");
  const port = await getFreePort();

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  if (options.git !== false) prepareGitWorkspace(workspaceDir);
  const longSessionFile = options.boundedToolToggle
    ? writeToolToggleFixture(sessionDir, workspaceDir)
    : options.usageHistory
      ? writeUsageHistoryFixture(sessionDir, workspaceDir)
      : options.datedHistory || options.boundedVisualHistory
        ? writeDatedHistoryFixture(sessionDir, workspaceDir, options.boundedVisualHistory)
        : options.longSession
          ? writeLongSessionFixture(sessionDir, workspaceDir)
          : undefined;

  const processOutput: string[] = [];
  const piProcess = spawn(
    process.env.PI_E2E_BIN || path.join(runtimeDir, "node_modules/.bin/pi"),
    [
      "--mode",
      "rpc",
      "--model",
      "faux/faux-1",
      "--api-key",
      "faux-key",
      "--session-dir",
      sessionDir,
      ...(longSessionFile ? ["--session", longSessionFile] : []),
      "--name",
      "Pi Web UI E2E",
      "--approve",
      ...(fixtureName === "slash-commands" ? [] : ["--no-skills", "--no-prompt-templates"]),
      "--no-context-files",
      ...(fixtureName === "slash-commands"
        ? [
            "--skill",
            path.join(repoRoot, "e2e/fixtures/skills/e2e-skill"),
            "--prompt-template",
            path.join(repoRoot, "e2e/fixtures/prompts/e2e-prompt.md"),
          ]
        : []),
      "--extension",
      path.join(repoRoot, "e2e/fixtures/faux-provider-extension.ts"),
      ...(fixtureName === "slash-commands"
        ? ["--extension", path.join(repoRoot, "e2e/fixtures/slash-command-extension.ts")]
        : []),
      "--extension",
      path.join(runtimeDir, "extensions/mirror-server.ts"),
      ...(options.extraExtensions ?? []).flatMap((extension) => ["--extension", extension]),
    ],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_E2E: "1",
        PI_OFFLINE: "1",
        PI_WEB_UI_HOST: "127.0.0.1",
        PI_WEB_UI_PORT: String(port),
        PI_WEB_UI_DISABLED: "false",
        PI_WEB_UI_PUBLIC_URL: "",
        PI_WEB_UI_REGISTRY_SOCKET: options.registration?.socketPath ?? "",
        PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: options.registration?.credentialFile ?? "",
        PI_WEB_UI_STATIC_DIR: path.join(runtimeDir, "dist"),
        PI_WEB_UI_E2E_FIXTURE: fixtureName,
        PI_WEB_UI_E2E_EXTERNAL_ARTIFACT: path.join(externalDir, "external-skill.md"),
      },
    },
  );

  captureProcessOutput(piProcess, processOutput);
  let rpcSequence = 0;
  let rpcBuffer = "";
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  piProcess.stdout.on("data", (chunk: Buffer) => {
    rpcBuffer += chunk.toString("utf8");
    while (rpcBuffer.includes("\n")) {
      const end = rpcBuffer.indexOf("\n");
      const line = rpcBuffer.slice(0, end);
      rpcBuffer = rpcBuffer.slice(end + 1);
      let record: { type?: string; id?: string; success?: boolean; data?: unknown; error?: string };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      options.onRpcEvent?.(record as Record<string, unknown>);
      if (record.type !== "response" || !record.id) continue;
      const request = pending.get(record.id);
      if (record.success) request?.resolve(record.data);
      else request?.reject(new Error(record.error ?? "RPC failed"));
    }
  });
  const rejectPending = () => {
    for (const request of pending.values()) request.reject(new Error("Pi process stopped"));
  };
  piProcess.once("exit", rejectPending);
  try {
    await waitForWebUi(`http://127.0.0.1:${port}`, piProcess, processOutput);
  } catch (error) {
    await stopProcess(piProcess);
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    respondToUI(id, confirmed) {
      piProcess.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, confirmed })}\n`);
    },
    rpc(command) {
      const id = `harness-${++rpcSequence}`;
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          pending.delete(id);
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("RPC response timeout"));
        }, 10_000);
        pending.set(id, {
          resolve(data) {
            finish();
            resolve(data);
          },
          reject(error) {
            finish();
            reject(error);
          },
        });
        piProcess.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      });
    },
    pageUrl: `http://127.0.0.1:${port}`,
    port,
    workspaceDir,
    sessionDir,
    async stop() {
      rejectPending();
      await stopProcess(piProcess);
      if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function writeUsageHistoryFixture(sessionDir: string, workspaceDir: string): string {
  const sessionId = "8e91f4c2-3000-4500-8500-000000000017";
  const file = path.join(sessionDir, `${Date.now()}_${sessionId}.jsonl`);
  const now = Date.now();
  const old = now - 14 * 86400000;
  const usage = (scale: number, cost: number) => ({
    input: 100 * scale,
    output: 20 * scale,
    cacheRead: 30 * scale,
    cacheWrite: 5 * scale,
    reasoning: 10 * scale,
    cacheWrite1h: 2 * scale,
    totalTokens: 155 * scale,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  const user = (id: string, parentId: string | null, time: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: "SYNTHETIC_USAGE_ONLY", timestamp: time },
  });
  const assistant = (id: string, parentId: string, time: number, model: string, scale: number, cost: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "SYNTHETIC_USAGE_RESPONSE" }],
      api: "anthropic-messages",
      provider: "fixture-provider",
      model: "selected-alias",
      responseModel: model,
      usage: usage(scale, cost),
      timestamp: time,
      stopReason: "stop",
    },
  });
  writeFileSync(
    file,
    `${[
      { type: "session", version: 3, id: sessionId, timestamp: new Date(old).toISOString(), cwd: workspaceDir },
      user("usage-user", null, old),
      assistant("usage-priced", "usage-user", old + 1, "billed-model-a", 1, 0.001),
      // This is a sibling branch, not part of the current leaf's prompt context.
      assistant("usage-unknown", "usage-user", now - 2, "billed-model-b", 2, 0),
      user("usage-current", "usage-priced", now),
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
    "utf8",
  );
  return file;
}

function writeToolToggleFixture(sessionDir: string, workspaceDir: string): string {
  const id = "8e91f4c2-3000-4500-8500-000000000004";
  const file = path.join(sessionDir, `${Date.now()}_${id}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date(toolToggleRange.from).toISOString(),
      cwd: workspaceDir,
    }),
  ];
  for (const [index, entry] of toolToggleEntries().entries()) {
    lines.push(JSON.stringify({ ...entry, parentId: index ? `e${index - 1}` : null }));
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function writeDatedHistoryFixture(sessionDir: string, workspaceDir: string, visual = false): string {
  const sessionId = "8e91f4c2-3000-4500-8500-000000000003";
  const file = path.join(sessionDir, `${Date.now()}_${sessionId}.jsonl`);
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const oldTime = midnight - 14 * 86400000 + 3600000;
  const recentTime = midnight + 1000;
  const iso = (time: number) => new Date(time).toISOString();
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: iso(oldTime), cwd: workspaceDir }),
  ];
  let parentId: string | null = null;
  function user(id: string, text: string, time: number) {
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: iso(time),
        message: { role: "user", content: text, timestamp: time },
      }),
    );
    parentId = id;
  }
  user("datedold", "DATED_OLD_ONLY_MARKER", oldTime);
  for (let index = 0; index < 150; index++) {
    user(`dated-${String(index).padStart(4, "0")}`, `DATED_RECENT_${index}`, recentTime + index);
  }
  const id = "datedbig";
  lines.push(
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: iso(recentTime + 200),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `DATED_LARGE_START_${"x".repeat(20 * 1024 * 1024)}_DATED_LARGE_END` }],
        api: "anthropic-messages",
        provider: "faux",
        model: "faux-1",
        timestamp: recentTime + 200,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
      },
    }),
  );
  parentId = id;
  user("datedend", "DATED_RECENT_END_MARKER", recentTime + 300);
  if (visual) {
    const append = (id: string, message: Record<string, unknown>, offset: number) => {
      lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: iso(recentTime + offset), message }));
      parentId = id;
    };
    append(
      "visual-tools",
      {
        role: "assistant",
        api: "anthropic-messages",
        provider: "faux",
        model: "faux-1",
        content: Array.from({ length: 205 }, (_, i) => ({
          type: "toolCall",
          id: `v${i}`,
          name: "read",
          arguments: { path: "x" },
        })),
        timestamp: recentTime + 400,
        stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
      400,
    );
    append(
      "visual-omitted-result",
      {
        role: "toolResult",
        toolCallId: "v0",
        toolName: "read",
        content: [
          { type: "text", text: `OMITTED_TOOL_START\n${'long tool output 中😀\\"\n'.repeat(10000)}\nOMITTED_TOOL_END` },
        ],
        isError: false,
        timestamp: recentTime + 401,
      },
      401,
    );
    append(
      "visual-long-result",
      {
        role: "toolResult",
        toolCallId: "v204",
        toolName: "read",
        content: [
          { type: "text", text: `VISIBLE_TOOL_START\n${'long tool output 中😀\\"\n'.repeat(10000)}\nVISIBLE_TOOL_END` },
        ],
        isError: false,
        timestamp: recentTime + 402,
      },
      402,
    );
    user("visual-end", "BOUNDED_VISUAL_END", recentTime + 403);
  }
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  const savedId = "9e91f4c2-0000-4500-8500-000000000014";
  writeFileSync(
    path.join(sessionDir, `old-saved_${savedId}.jsonl`),
    `${[
      { type: "session", version: 3, id: savedId, timestamp: iso(oldTime), cwd: workspaceDir },
      {
        type: "message",
        id: "savedold",
        parentId: null,
        timestamp: iso(oldTime),
        message: { role: "user", content: "SAVED_OLD_DATE_MARKER", timestamp: oldTime },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
    "utf8",
  );
  return file;
}

function writeLongSessionFixture(sessionDir: string, workspaceDir: string): string {
  const sessionId = "7e91f4c2-6000-4500-8500-000000006000";
  const file = path.join(sessionDir, `${Date.now()}_${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: workspaceDir })];
  let parentId: string | null = null;
  const ids: string[] = [];
  for (let index = 0; index < 6000; index += 1) {
    const id = index.toString(16).padStart(8, "0");
    ids.push(id);
    const role = index % 2 === 0 ? "user" : "assistant";
    const text = index === 5999 ? "LONG_SESSION_END_MARKER_7e91f4" : `${role} history entry ${index}`;
    const message =
      role === "user"
        ? { role, content: text, timestamp: Date.now() + index }
        : {
            role,
            content: [{ type: "text", text }],
            api: "anthropic-messages",
            provider: "faux",
            model: "faux-1",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: "stop",
            timestamp: Date.now() + index,
          };
    lines.push(JSON.stringify({ type: "message", id, parentId, timestamp, message }));
    parentId = id;
  }
  for (const [targetIndex, label] of [
    [500, "LONG_BRANCH_LABEL_ALPHA"],
    [3000, "LONG_BRANCH_LABEL_BETA"],
    [5000, "LONG_BRANCH_LABEL_GAMMA"],
  ] as const) {
    const id = `f${targetIndex.toString(16).padStart(7, "0")}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id: `branch-${targetIndex}`,
        parentId: ids[targetIndex],
        timestamp,
        message: { role: "user", content: `SIDE_BRANCH_${targetIndex}`, timestamp: Date.now() },
      }),
      JSON.stringify({ type: "label", id, parentId, timestamp, targetId: ids[targetIndex], label }),
    );
    parentId = id;
  }
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function prepareGitWorkspace(workspaceDir: string) {
  const prdDir = path.join(workspaceDir, "docs/prd");
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    path.join(prdDir, "workspace-status-float.md"),
    ["# PRD: Workspace Status Float", "", "Baseline content before the E2E agent update."].join("\n"),
    "utf8",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pi-web-ui-e2e@example.test"], { cwd: workspaceDir });
  execFileSync("git", ["config", "user.name", "Pi Web UI E2E"], { cwd: workspaceDir });
  execFileSync("git", ["add", "."], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial workspace"], { cwd: workspaceDir, stdio: "ignore" });
}

function captureProcessOutput(process: ChildProcessWithoutNullStreams, output: string[]) {
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString("utf8"));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  process.stdout.on("data", capture);
  process.stderr.on("data", capture);
}

async function waitForWebUi(
  url: string,
  process: ChildProcessWithoutNullStreams,
  processOutput: string[],
  timeoutMs = 20_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`pi exited before Web UI started:\n${processOutput.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}:\n${processOutput.join("")}`);
}

async function stopProcess(process: ChildProcessWithoutNullStreams) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        if (process.exitCode === null) process.kill("SIGKILL");
        resolve(undefined);
      }, 2_000),
    ),
  ]);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

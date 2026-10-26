import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertDead, harness } from "../tests/helpers/native-harness.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("real Pi 1.1.0 generates using only a synthetic provider then shuts down orderly", async (t) => {
  const { backend, request, workspace, parent } = await harness(t, "normal", {
    piExecutable: path.join(root, "node_modules/.bin/pi"),
    provider: { extensionPath: path.join(root, "integration-tests/fixtures/native-provider.ts"), name: "native-fixture", model: "deterministic" },
    startupTimeoutMs: 15_000, rpcTimeoutMs: 5000, generationTimeoutMs: 10_000, stopTimeoutMs: 3000, maxFrameBytes: 1024 * 1024,
  });
  // A discovered project extension must never run, even in the selected cwd.
  await mkdir(path.join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(path.join(workspace, ".pi", "extensions", "poison.ts"), "throw new Error('PROJECT_RESOURCE_MUST_NOT_LOAD');\n");
  await writeFile(path.join(workspace, "AGENTS.md"), "PROJECT_CONTEXT_MUST_NOT_LOAD\n");
  const identity = await backend.create(request);
  const logPath = path.join(identity.stateDir, "home", "acceptance.jsonl");
  const started = JSON.parse((await readFile(logPath, "utf8")).trim().split("\n")[0]);
  assert.equal(started.version, "1.1.0");
  assert.equal(started.cwd, workspace);
  assert.equal(started.provider, "native-fixture");
  assert.equal(started.model, "deterministic");
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_MANAGER_CONFIG", "PI_WEB_UI_HUB_CONFIG"]) assert.ok(started.env[key].startsWith(parent + path.sep), key);
  assert.equal(started.env.OPENAI_API_KEY, undefined);
  assert.equal(started.env.ANTHROPIC_API_KEY, undefined);
  const generated = await backend.generate(request.instanceId, "Return the synthetic acceptance reply.");
  assert.deepEqual(generated, {
    disposition: "started", text: "NATIVE_PI_GENERATION_OK 答复🙂\u2028line\u2029end", agentEndObserved: true, settled: true, aborted: false,
  });
  assert.equal((await backend.inspect(request.instanceId))?.stderrBytes, 0);
  assert.deepEqual(await backend.stop(request.instanceId), { status: "stopped", exitCode: 0, signal: null, forced: false });
  const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((entry) => entry.event), ["session_start", "model_call", "session_shutdown"]);
  assert.equal(events[1].projectContextLoaded, false);
  assertDead(identity.pid);
  assert.deepEqual(backend.list(), []);
});

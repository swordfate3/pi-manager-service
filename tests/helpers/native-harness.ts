import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { NativeBackend, NativeBackendConfig } from "../../manager/backends/native.ts";

export async function harness(t: TestContext, scenario = "normal", overrides: Partial<NativeBackendConfig> = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-native-test-"));
  const workspace = path.join(parent, "workspaces", "project");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "scenario.json"), JSON.stringify(scenario));
  const executable = path.join(parent, "fake-pi");
  const fixture = await readFile(new URL("../fixtures/native-child.mjs", import.meta.url), "utf8");
  await writeFile(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const config: NativeBackendConfig = {
    piExecutable: executable,
    workspaceRoots: { work: path.dirname(workspace) },
    stateRoot: path.join(parent, "state"),
    agentRoot: path.join(parent, "agents"),
    startupTimeoutMs: 1500,
    rpcTimeoutMs: 500,
    generationTimeoutMs: 1500,
    stopTimeoutMs: 150,
    maxFrameBytes: 4096,
    maxStderrBytes: 512,
    ...overrides,
  };
  const module = await import("../../manager/backends/native.ts").catch(() => {
    assert.fail("NativeBackend must implement the approved owned-child lifecycle");
  });
  const backend: NativeBackend = new module.NativeBackend(config);
  t.after(async () => {
    for (const instance of backend.list()) {
      const result = await backend.stop(instance.instanceId);
      assert.notEqual(result.status, "ownership-lost", "test child must not leak");
    }
    await rm(parent, { recursive: true, force: true });
  });
  const request = { instanceId: "test-instance", workspace: { root: "work", path: "project" } };
  return { backend, config, parent, workspace, request };
}

export async function observation(workspace: string): Promise<any> {
  return JSON.parse(await readFile(path.join(workspace, "observed.json"), "utf8"));
}

export async function waitFor(check: () => Promise<boolean>, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "condition did not become true before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function assertDead(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
}

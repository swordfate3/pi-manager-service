import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeHub, readHubConfig } from "../../hub/config.ts";
import { issueManagementCode } from "../../hub/management.ts";
import { startHub } from "../../hub/server.ts";

test("authenticated Hub approves a real temporary Gate task and reconciles the same receipt", {
  timeout: 15000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-gate-live-"));
  const credentialFile = path.join(directory, "management.json");
  const child = spawn(
    "python3",
    [fileURLToPath(new URL("../fixtures/hub-gate-management.py", import.meta.url)), credentialFile],
    { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let failure = "";
  child.stderr.on("data", (data) => {
    failure += String(data).slice(0, 2000);
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  const lines = createInterface({ input: child.stdout });
  try {
    const handshake = (await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line)),
      exit.then(() => {
        throw new Error(`Gate fixture exited before readiness: ${failure}`);
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Gate fixture timeout")), 5000);
        timer.unref();
      }),
    ])) as { endpoint: string; id: string };
    const file = path.join(directory, "hub.json");
    initializeHub(file, { port: 0, management: { port: 0 } });
    const config = readHubConfig(file);
    config.gateManagement = { endpoint: handshake.endpoint, credentialFile };
    hub = await startHub(config, { versions: { source: async () => ({}) } });
    assert.ok(hub.managementUrl);
    const origin = new URL(hub.managementUrl).origin;
    const unlock = await fetch(`${origin}/api/management/unlock`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: issueManagementCode(config).code }),
    });
    assert.equal(unlock.status, 200);
    const cookie = unlock.headers.get("set-cookie");
    assert.ok(cookie);
    const headers = {
      Cookie: cookie.split(";")[0],
      Origin: origin,
      "Content-Type": "application/json",
      "X-Pi-Hub-Csrf": (await unlock.json()).csrf,
    };
    const read = await fetch(`${origin}/api/management/gate`, { headers });
    assert.equal(read.status, 200);
    const overview = await read.json();
    const task = overview.tasks.find((item: { id: string }) => item.id === handshake.id);
    assert.ok(task);
    const body = {
      kind: task.kind,
      id: task.id,
      revision: task.revision,
      action: "approve",
      decision_id: "f".repeat(32),
    };
    const decisionUrl = `${origin}/api/management/gate/decisions`;
    const approved = await fetch(decisionUrl, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(approved.status, 200);
    const receipt = await approved.json();
    assert.equal(receipt.status, "recorded");
    const replay = await fetch(decisionUrl, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    const lookup = await fetch(`${decisionUrl}/${body.decision_id}`, { headers });
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), receipt);
    const conflict = await fetch(decisionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, action: "reject" }),
    });
    assert.equal(conflict.status, 409);
    const completed = await fetch(`${origin}/api/management/gate/tasks/deployment/${task.id}`, { headers });
    assert.equal(completed.status, 200);
    const current = await completed.json();
    assert.equal(current.status, "deployed");
    assert.deepEqual(current.actions, ["rollback"]);
    assert.ok(!JSON.stringify(overview).includes('"token"'));
    assert.ok(!JSON.stringify(overview).includes('"snapshot"'));
  } finally {
    await hub?.close();
    lines.close();
    child.stdin.end("stop\n");
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

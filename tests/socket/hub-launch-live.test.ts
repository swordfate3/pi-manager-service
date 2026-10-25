/** Real Hub→Gate HTTP/SQLite; Docker daemon only is a recording substitute. */
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

test("real temporary Gate and Hub browse, launch once, query and reject changed identities", {
  timeout: 20000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-launch-live-"));
  const credentialFile = path.join(directory, "management.json");
  const child = spawn(
    "python3",
    [fileURLToPath(new URL("../fixtures/hub-gate-launches.py", import.meta.url)), credentialFile],
    { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk).slice(0, 2000);
  });
  const lines = createInterface({ input: child.stdout });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const handshake = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line)),
      exit.then(() => {
        throw new Error(`Gate fixture exited: ${error}`);
      }),
    ]);
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
    const request = (route: string, body?: unknown) =>
      fetch(`${origin}/api/management/gate/${route}`, {
        headers,
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const profile = await (await request("launch-config")).json();
    assert.equal(profile.enabled, true);
    const listing = await (await request("workspaces?path=pi_projects")).json();
    assert.deepEqual(listing.entries, [{ name: "project-a", path: "pi_projects/project-a" }]);
    const selected = await (await request("workspaces?path=pi_projects/project-a")).json();
    const body = {
      id: "a".repeat(32),
      path: selected.path,
      label: "手机新建",
      policy_revision: profile.revision,
      workspace_revision: selected.revision,
    };
    assert.equal((await request("launches", body)).status, 200);
    assert.equal((await request("launches", body)).status, 200);
    assert.equal((await request("launches", { ...body, label: "different" })).status, 409);
    let current: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 60; attempt++) {
      current = await (await request(`launches/${body.id}`)).json();
      if (current.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(current.status, "running");
    assert.equal(current.sessionUrl, undefined, "Docker running is not registered Pi");
    const jobs = await (await request("launches")).json();
    assert.equal(jobs.jobs.length, 1);
    assert.ok(!JSON.stringify(jobs).includes('"token"'));
    assert.equal(
      (await request("launches", { ...body, id: "b".repeat(32), policy_revision: "f".repeat(64) })).status,
      409,
    );
    assert.equal((await request("workspaces?path=../outside")).status, 400);
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

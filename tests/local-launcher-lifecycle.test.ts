import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalLauncher } from "../manager/local-launcher.ts";
import { LocalStore, type StoredRun } from "../manager/local-store.ts";
import { WorkspacePolicy } from "../manager/workspaces.ts";
import type { ExecutorConfig } from "../manager/config.ts";

const id = "pi-local-" + "a".repeat(24);
const record = (state: StoredRun["state"]): StoredRun => ({ id, key: "original-request",
  workspace: { root: "projects", path: "demo" }, state, created: 1, containerId: "c".repeat(64),
  error: "previous failure", ...(state === "ready" ? { path: "/s/old-session/" } : {}) });

async function fixture(t: test.TestContext, mode: string, rows: StoredRun[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-local-lifecycle-"));
  const home = path.join(root, "home"), projects = path.join(home, "projects"), stateRoot = path.join(root, "state");
  await mkdir(path.join(projects, "demo"), { recursive: true });
  const store = await LocalStore.open(stateRoot); store.saveRuns(rows);
  const fixtureState = path.join(root, "docker-state.json"), childInfo = path.join(root, "child.json");
  const probeStarted = path.join(root, "probe-started"), probeRelease = path.join(root, "probe-release");
  const setMode = (value: string) => writeFile(fixtureState, JSON.stringify({ mode: value }));
  await setMode(mode);
  const docker = path.join(root, "docker"), launcherFile = path.join(root, "launcher");
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs');
async function main() {
let mode = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureState)}, 'utf8')).mode;
if (process.argv[2] !== 'inspect') process.exit(99);
const name = process.argv[3];
if (mode === 'held-missing') {
  fs.writeFileSync(${JSON.stringify(probeStarted)}, 'started');
  await new Promise(resolve => { const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(probeRelease)})) { clearInterval(timer); resolve(); }
  }, 10); });
  mode = 'missing';
}
if (mode === 'missing') { console.error('Error: No such container: ' + name); process.exit(1); }
if (mode === 'missing-lowercase') { console.error('error: no such object: ' + name); process.exit(1); }
if (mode === 'missing-daemon') { console.error('Error response from daemon: No such container: ' + name); process.exit(1); }
if (mode === 'missing-other') { console.error('error: no such object: unrelated-container'); process.exit(1); }
if (mode === 'missing-socket') { console.error('dial unix /var/run/docker.sock: connect: no such file or directory'); process.exit(1); }
if (mode === 'unavailable') { console.error('Cannot connect to the Docker daemon'); process.exit(1); }
if (mode === 'malformed') { console.log('[]'); process.exit(0); }
console.log(JSON.stringify([{ Id: (mode === 'replacement' ? 'd' : 'c').repeat(64), Name: '/' + name,
  Config: {Labels: {'cn.swordfate.pi.local-id': name}},
  Mounts: [{Destination: '/workspace', Source: ${JSON.stringify(path.join(projects, "demo"))}}],
  State: {Running: mode !== 'exited' && mode !== 'replacement'} }]));
}
void main();
`, { mode: 0o700 });
  await writeFile(launcherFile, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const runId = 'b'.repeat(32), root = process.env.PI_PIRUN_WEB_HUB_RUNS_DIR;
fs.mkdirSync(path.join(root, runId), {recursive: true});
fs.writeFileSync(path.join(root, runId, 'launch.json'), JSON.stringify({pid: process.pid, workspace: process.cwd(), run_id: runId}));
fs.writeFileSync(${JSON.stringify(childInfo)}, JSON.stringify({pid: process.pid}));
process.stdin.resume();
`, { mode: 0o700 });
  const config = { port: 0, chatPort: 0, home, workspaceRoots: { projects },
    defaultWorkspace: { root: "projects", path: "demo" }, stateRoot, launcher: launcherFile,
    hubCli: path.join(root, "hub.mjs"), dockerExecutable: docker, startupTimeoutMs: 100 };
  const policy = await WorkspacePolicy.open({ stateRoot,
    submitSocket: path.join(root, "submit/rpc.sock"), adminSocket: path.join(root, "admin/rpc.sock"),
    principals: [], trustedLocalNative: true, native: { piExecutable: process.execPath,
      workspaceRoots: { projects }, stateRoot: path.join(root, "native"), agentRoot: path.join(root, "agent") },
    workspaces: {}, workspaceBrowser: { home, defaultRoot: "projects" },
  } as ExecutorConfig);
  const launcher = await LocalLauncher.open(config, policy, { sessionPath: async () => mode === "pending" ? undefined : "/s/test-session/" }, store);
  t.after(async () => { await launcher.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, config, policy, launcher, store, setMode, childInfo, probeStarted, probeRelease };
}

for (const state of ["failed", "unknown", "ready"] as const) {
  for (const mode of ["missing", "exited"]) {
    test(`${state} history becomes stopped when Docker confirms ${mode}, preserving history and request identity`, async t => {
      const f = await fixture(t, mode, [record(state)]);
      assert.equal(f.launcher.list()[0].state, "stopped");
      assert.equal(f.launcher.list()[0].path, undefined);
      assert.equal(f.store.runs().length, 1);
      const repeat = await f.launcher.start({ key: "original-request", workspace: { root: "projects", path: "demo" } });
      assert.equal(repeat.id, id); assert.equal(repeat.state, "stopped");
    });
  }
}

for (const mode of ["unavailable", "malformed", "replacement"]) {
  test(`Docker ${mode} never counts as proof that a failed instance stopped`, async t => {
    const f = await fixture(t, mode, [record("failed")]);
    assert.equal(f.launcher.list()[0].state, "unknown");
    assert.equal(f.launcher.list()[0].path, undefined);
  });
}

for (const [mode, expected] of [["missing-lowercase", "stopped"], ["missing-daemon", "stopped"],
  ["missing-other", "unknown"], ["missing-socket", "unknown"]] as const) {
  test(`Docker CLI ${mode} classifies only an exact missing-container response as ${expected}`, async t => {
    const f = await fixture(t, mode, [record("failed")]);
    assert.equal(f.launcher.list()[0].state, expected);
  });
}

test("a running container with an exited launcher remains visible and stop-capable", async t => {
  const f = await fixture(t, "running", [record("failed")]);
  assert.equal(f.launcher.list()[0].state, "unknown");
});

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const until = Date.now() + 6000;
  while (!await predicate()) {
    if (Date.now() > until) assert.fail("lifecycle state did not converge");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("an abnormal launcher exit and removed container converge to stopped without restarting the workbench", async t => {
  const f = await fixture(t, "running");
  const started = await f.launcher.start({ key: "new-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(() => f.launcher.list()[0].state === "ready");
  const { pid } = JSON.parse(await readFile(f.childInfo, "utf8"));
  await f.setMode("missing");
  process.kill(pid, "SIGKILL");
  await waitFor(() => f.launcher.list()[0].state === "stopped");
  assert.equal(f.launcher.list()[0].id, started.id);
  assert.equal(f.store.runs()[0].state, "stopped");
});

test("a launcher still starting is not considered stopped just because its container has not appeared yet", async t => {
  const f = await fixture(t, "pending");
  await f.setMode("missing");
  await f.launcher.start({ key: "slow-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(() => f.launcher.list()[0].state === "unknown");
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(f.launcher.list()[0].state, "unknown");
});

test("a stale registry lease cannot keep a removed container visible even if the launcher has not exited", async t => {
  const f = await fixture(t, "running");
  await f.launcher.start({ key: "removed-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(() => f.launcher.list()[0].state === "ready");
  await f.setMode("missing");
  await waitFor(() => f.launcher.list()[0].state === "stopped");
});

test("readiness before the first Docker identity does not hide a live launcher still creating its container", async t => {
  const f = await fixture(t, "missing");
  await f.launcher.start({ key: "early-lease-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(async () => { try { await readFile(f.childInfo); return true; } catch { return false; } });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(f.launcher.list()[0].state, "unknown");
  assert.equal(f.launcher.list()[0].path, undefined);
  assert.equal(f.store.runs()[0].containerId, undefined);
  await f.setMode("running");
  await waitFor(() => f.launcher.list()[0].state === "ready");
  assert.equal(f.store.runs()[0].containerId, "c".repeat(64));
});

test("initial readiness is never published while the first Docker inspection is pending", async t => {
  const f = await fixture(t, "held-missing");
  await f.launcher.start({ key: "held-probe-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(async () => { try { await readFile(f.probeStarted); return true; } catch { return false; } });
  try {
    assert.notEqual(f.launcher.list()[0].state, "ready");
    assert.equal(f.launcher.list()[0].path, undefined);
    assert.equal(f.store.runs()[0].containerId, undefined);
  } finally { await writeFile(f.probeRelease, "release"); }
  await waitFor(() => f.launcher.list()[0].state === "unknown");
  await f.setMode("running");
  await waitFor(() => f.launcher.list()[0].state === "ready");
});

test("a stale registry lease does not restore ready during a Docker outage between probes", async t => {
  const f = await fixture(t, "running");
  await f.launcher.start({ key: "outage-request", workspace: { root: "projects", path: "demo" } });
  await waitFor(() => f.launcher.list()[0].state === "ready");
  await f.setMode("unavailable");
  await waitFor(() => f.launcher.list()[0].state === "unknown");
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(f.launcher.list()[0].state, "unknown");
  assert.equal(f.launcher.list()[0].path, undefined);
  await f.setMode("running");
  await waitFor(() => f.launcher.list()[0].state === "ready");
});

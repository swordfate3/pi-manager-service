// Exercise the packaged CLI, never the source server/config or the caller's real hub state.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type HubCapability = { runId: string; credentialFile: string; socketPath: string };
export type HubCliHarness = {
  readonly url: string;
  readonly socketPath: string;
  issue: (label: string) => HubCapability;
  revoke: (capability: HubCapability) => void;
  restart: () => Promise<void>;
  close: () => Promise<void>;
};

type Ready = { localUrl: string; socketPath: string };

export function isolatedHubCliEnvironment(directory: string): NodeJS.ProcessEnv {
  const { HOME: _home, PI_MANAGER_CONFIG: _manager, PI_WEB_UI_HUB_CONFIG: _legacy, ...inherited } = process.env;
  const home = path.join(directory, "home");
  const fallback = path.join(directory, "fallback");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(fallback, { recursive: true, mode: 0o700 });
  return {
    ...inherited,
    HOME: home,
    PI_MANAGER_CONFIG: path.join(fallback, "manager.json"),
    PI_WEB_UI_HUB_CONFIG: path.join(fallback, "legacy-hub.json"),
  };
}

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

export async function startHubCli(options: { repositoryRoot: string; runtimeDir?: string }): Promise<HubCliHarness> {
  // Match the Pi harness's runtime selection. Missing/broken installed assets must fail, not fall back to source.
  const runtimeDir = path.resolve(options.runtimeDir ?? process.env.PI_E2E_RUNTIME_DIR ?? options.repositoryRoot);
  const cli = path.join(runtimeDir, "dist/hub/pi-web-hub.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-e2e-"));
  const config = path.join(dir, "config.json");
  const env = isolatedHubCliEnvironment(dir);
  let child: ChildProcess | undefined;
  let ready: Ready | undefined;
  let capabilityIndex = 0;
  let closed = false;

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--config", config], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    // Never include stdout/stderr or raw parsing errors: a regressed CLI could print a capability token.
    if (result.error || result.status !== 0) {
      // Whitelist only a fixed non-secret diagnostic; never echo child output.
      const reason = result.stderr?.includes("Hub state lock busy") ? ": state writer lock busy" : "";
      throw new Error(`Hub CLI ${args[0]} failed${reason}`);
    }
    return result;
  }

  async function serve() {
    const process = spawn(globalThis.process.execPath, [cli, "serve", "--config", config], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = process;
    // Drain, but deliberately do not report raw child output.
    process.stderr.resume();
    ready = await new Promise<Ready>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => fail(), 10000);
      const cleanup = () => {
        clearTimeout(timer);
        process.stdout.off("data", onData);
        process.off("error", fail);
        process.off("exit", fail);
        process.stdout.resume();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Hub CLI serve did not become ready"));
      };
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 64 * 1024) return fail();
        if (!output.includes("\n")) return;
        try {
          const value = JSON.parse(output.split("\n")[0]);
          const url = new URL(value.localUrl);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || typeof value.socketPath !== "string")
            return fail();
          cleanup();
          resolve({ localUrl: value.localUrl, socketPath: value.socketPath });
        } catch {
          fail();
        }
      };
      process.stdout.on("data", onData);
      process.once("error", fail);
      process.once("exit", fail);
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (child) await stopChild(child);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  try {
    run("init", "--port", "0");
    await serve();
  } catch {
    await close();
    throw new Error("Unable to start the selected runtime's Hub CLI");
  }

  return {
    get url() {
      if (!ready || closed) throw new Error("Hub CLI is not running");
      return ready.localUrl;
    },
    get socketPath() {
      if (!ready || closed) throw new Error("Hub CLI is not running");
      return ready.socketPath;
    },
    issue(label) {
      if (closed) throw new Error("Hub CLI is closed");
      const credentialFile = path.join(dir, `capability-${++capabilityIndex}.json`);
      const result = run("issue", "--label", label, "--output", credentialFile);
      try {
        const value = JSON.parse(result.stdout);
        // Token access stays inside this helper, never returned or interpolated in an assertion/error.
        const credential = JSON.parse(readFileSync(credentialFile, "utf8"));
        if (
          !/^[a-f0-9]{64}$/.test(credential.token) ||
          !/^[a-f0-9]{32}$/.test(credential.run_id) ||
          value.runId !== credential.run_id ||
          value.credentialFile !== credentialFile ||
          value.socketPath !== ready?.socketPath ||
          (statSync(credentialFile).mode & 0o077) !== 0 ||
          `${result.stdout}${result.stderr}`.includes(credential.token)
        )
          throw new Error();
        return { runId: value.runId, credentialFile, socketPath: value.socketPath };
      } catch {
        throw new Error("Hub CLI issue returned invalid or exposed credentials");
      }
    },
    revoke(capability) {
      if (closed) throw new Error("Hub CLI is closed");
      run("revoke", "--run-id", capability.runId);
    },
    async restart() {
      if (closed) throw new Error("Hub CLI is closed");
      try {
        if (child) await stopChild(child);
        await serve();
      } catch {
        await close();
        throw new Error("Unable to restart Hub CLI");
      }
    },
    close,
  };
}

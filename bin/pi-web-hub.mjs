#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

const help = `Pi Web Hub — independent multi-session portal

  pi-web-hub init [--port 16180] [--public-url https://pi.example.com/]
    [--management-port 16181] [--management-public-url https://admin.example.com/]
  pi-web-hub serve
  pi-web-hub issue --label "Project A" --output /private/session-a.json [--backend-host 127.0.0.1]
  pi-web-hub revoke --run-id <session-capability-id>
  pi-web-hub pair                     Generate a single-use management code (10 minutes)
  pi-web-hub revoke-management        Revoke all browser management sessions

All commands accept --config <file> (default ~/.config/pi-manager/config.json).
The hub never launches agents or deploys SSH/TLS/login. See docs/hub.md.
Mount only the runtime directory and the individual credential into a Pi container;
never expose the hub administrator state directory to agents.
`;

async function main(args) {
  const command = args.shift();
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  const commands = new Map([
    ["init", ["--config", "--port", "--public-url", "--management-port", "--management-public-url"]],
    ["serve", ["--config"]],
    ["issue", ["--config", "--label", "--output", "--backend-host"]],
    ["revoke", ["--config", "--run-id"]],
    ["pair", ["--config"]],
    ["revoke-management", ["--config"]],
  ]);
  const permitted = commands.get(command);
  if (!permitted) throw new Error("Unknown hub command; use --help");
  const options = new Map();
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (!permitted.includes(key) || options.has(key) || !value || value.startsWith("--"))
      throw new Error("Invalid hub arguments; use --help");
    options.set(key, value);
  }
  const configFile = path.resolve(
    options.get("--config") ?? process.env.PI_MANAGER_CONFIG ?? path.join(homedir(), ".config/pi-manager/config.json"),
  );
  if (command === "init") {
    const port = options.has("--port") ? Number(options.get("--port")) : 16180;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
    const publicUrl = options.get("--public-url");
    if (publicUrl !== undefined) {
      const { validatedPublicUrl } = await import("../protocol/connection-config.ts");
      if (new URL(validatedPublicUrl(publicUrl)).pathname !== "/")
        throw new Error("Hub public URL must use the domain root");
    }
    let management;
    if (options.has("--management-public-url") && !options.has("--management-port"))
      throw new Error("Management port required");
    if (options.has("--management-port")) {
      const { managementConfig } = await import("../hub/config.ts");
      management = managementConfig(
        {
          port: Number(options.get("--management-port")),
          ...(options.has("--management-public-url") ? { publicUrl: options.get("--management-public-url") } : {}),
        },
        port,
        publicUrl,
      );
    }
    initializeHub(configFile, { port, ...(publicUrl ? { publicUrl } : {}), ...(management ? { management } : {}) });
    process.stdout.write(`${JSON.stringify({ configured: true, configFile })}\n`);
    return;
  }
  const config = readHubConfig(configFile);
  if (command === "pair") {
    // Explicit trusted-terminal operation, never called by the HTTP server or model tools.
    process.stdout.write(`${JSON.stringify(issueManagementCode(config))}\n`);
  } else if (command === "revoke-management") {
    revokeManagement(config);
    process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
  } else if (command === "issue") {
    if (!options.has("--output") || !options.has("--label")) throw new Error("issue requires --output and --label");
    const credentialFile = path.resolve(options.get("--output"));
    const credential = issueSession(config, credentialFile, {
      label: options.get("--label"),
      backendHost: options.get("--backend-host"),
    });
    // Deliberately omit token. These paths are intended for the trusted launcher.
    process.stdout.write(
      `${JSON.stringify({ runId: credential.run_id, credentialFile, socketPath: config.socketPath })}\n`,
    );
  } else if (command === "revoke") {
    if (!options.has("--run-id")) throw new Error("revoke requires --run-id");
    revokeSession(config, options.get("--run-id"));
    process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
  } else if (command === "serve") {
    const hub = await startHub(config);
    process.stdout.write(
      `${JSON.stringify({ localUrl: hub.url, portalUrl: `${config.publicUrl ?? hub.url}sessions/`, socketPath: hub.socketPath, ...(hub.managementUrl ? { managementUrl: hub.managementUrl } : {}) })}\n`,
    );
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void hub
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    throw new Error("Unknown hub command; use --help");
  }
}

main(process.argv.slice(2)).catch(() => {
  // User paths/values may contain secrets. Never echo raw exceptions or arguments.
  process.stderr.write(
    "Pi Web Hub failed. Check arguments, private file permissions, configuration and port/socket availability. Use --help.\n",
  );
  process.exitCode = 1;
});

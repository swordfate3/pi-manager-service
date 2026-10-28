// Explicit host-side local installation. Never touches production role configs,
// Docker images/volumes, SSH tunnels, DNS or remote hosts. Start is separate.
import { cp, mkdir, readFile, realpath, stat, writeFile, copyFile, chmod } from "node:fs/promises";
import { DatabaseSync, backup as backupDatabase } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--stack") throw Error("Usage: node install-local-workbench.mjs --stack /absolute/pi-stack");
const stack = await realpath(args[1]), source = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const deploymentSource = path.resolve(source, "../pi-stack-deployment");
if (stack === "/" || (await stat(stack)).uid !== process.getuid()) throw Error("Stack must be owned by the current user");
const destination = path.join(stack, "local-workbench");
const backup = path.join(stack, "backup", "local-workbench-" + new Date().toISOString().replaceAll(/[:.]/g, "-"));
await mkdir(backup, { recursive: true, mode: 0o700 });
// Back up before replacing binaries/config. SQLite's backup API takes a
// consistent snapshot, including when a prior manager is still running.
for(const name of ["dist/hub/pi-web-hub.mjs","dist/manager/pi-manager-local.mjs","config/config.json","state/runs.json"]) {
  try {await stat(path.join(destination,name));await mkdir(path.dirname(path.join(backup,name)),{recursive:true,mode:0o700});await copyFile(path.join(destination,name),path.join(backup,name));await chmod(path.join(backup,name),0o600);}
  catch(error) {if(error.code !== "ENOENT") throw error;}
}
try {
  const file=path.join(destination,"state/manager.sqlite3");await stat(file);
  const database=new DatabaseSync(file,{readOnly:true});
  try {await backupDatabase(database,path.join(backup,"manager.sqlite3"));await chmod(path.join(backup,"manager.sqlite3"),0o600);} finally {database.close();}
} catch(error) {if(error.code !== "ENOENT") throw error;}
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const name of ["dist/hub", "dist/manager", "node_modules", "config", "state"]) await mkdir(path.join(destination, name), { recursive: true, mode: 0o700 });
for (const name of ["dist/hub/pi-web-hub.mjs", "dist/manager/pi-manager-local.mjs"]) await copyFile(path.join(source, name), path.join(destination, name));
await copyFile(path.join(source, "docs/local-workbench.md"), path.join(stack, "docs/local-workbench.md"));
const require = createRequire(import.meta.url);
await cp(path.dirname(require.resolve("ws/package.json")), path.join(destination, "node_modules/ws"), { recursive: true });
for (const name of ["pi-pirun", "pi-web-hub-session", "pi-dockerctl"]) {
  await copyFile(path.join(stack, "scripts", name), path.join(backup, name));
  await copyFile(path.join(deploymentSource, "scripts", name), path.join(stack, "scripts", name));
}
const home = await realpath(process.env.HOME), root = path.join(home, "gitproject");
const config = path.join(destination, "config/config.json");
try {
  await stat(config);
  // Normalize only the installer-created trailing separator defect; preserve
  // the user's ports, roots, default workspace and other existing choices.
  const current = JSON.parse(await readFile(config, "utf8"));
  if (Array.isArray(current.protectedRoots) && current.protectedRoots.some(root => root !== path.resolve(root))) {
    await copyFile(config, path.join(backup, "local-config.json"));
    current.protectedRoots = current.protectedRoots.map(root => path.resolve(root));
    await writeFile(config, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  }
}
catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(config, JSON.stringify({ port: 18403, chatPort: 18404, home, workspaceRoots: { gitproject: root },
    defaultWorkspace: { root: "gitproject", path: "pi_projects" }, stateRoot: path.join(destination, "state"),
    launcher: path.join(stack, "scripts/pirun"), hubCli: path.join(destination, "dist/hub/pi-web-hub.mjs"),
    protectedRoots: [source, deploymentSource, stack], dockerExecutable: "/usr/bin/docker", startupTimeoutMs: 120000 }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
const unit = path.join(stack, "systemd/pi-local-workbench.service");
const quoted = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
// WorkingDirectory is a scalar path, not an ExecStart command word; wrapping it
// in command-style quotes makes older systemd treat the quote as part of the path.
const workingDirectory = stack.replaceAll("%", "%%").replaceAll(" ", "\\x20");
await writeFile(unit, `[Unit]\nDescription=Pi local workbench (loopback only, original pirun)\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${quoted(process.execPath)} ${quoted(path.join(destination, "dist/manager/pi-manager-local.mjs"))} --config ${quoted(config)}\nWorkingDirectory=${workingDirectory}\nEnvironment=PATH=${path.dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=25\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o644 });
console.log(JSON.stringify({ installed: true, url: "http://127.0.0.1:18403/", unit, config, backup,
  note: "Local only. No production or remote service changed. Review then systemctl --user link/start the unit." }));

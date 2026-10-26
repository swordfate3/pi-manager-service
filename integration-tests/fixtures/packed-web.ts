import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Install only the selected Web archive; supply its declared runtime/SDK peers. */
export async function packedWeb(root: string, webRoot: string, peerRoot = path.resolve("node_modules")) {
  const run = promisify(execFile);
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", root], {
    cwd: webRoot, timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"), NPM_CONFIG_CACHE: path.join(root, "npm-cache") },
  });
  const start = stdout.indexOf("["); assert.ok(start >= 0, "npm pack must return an archive");
  const [{ filename }] = JSON.parse(stdout.slice(start));
  await run("tar", ["-xzf", path.join(root, filename), "-C", root]);
  const installed = path.join(root, "package");
  await access(path.join(installed, "dist", "index.html"));
  await mkdir(path.join(installed, "node_modules", "@earendil-works"), { recursive: true });
  await symlink(path.join(peerRoot, "ws"), path.join(installed, "node_modules", "ws"));
  for (const name of ["pi-coding-agent", "pi-ai"]) {
    await symlink(path.join(peerRoot, "@earendil-works", name), path.join(installed, "node_modules", "@earendil-works", name));
  }
  return installed;
}

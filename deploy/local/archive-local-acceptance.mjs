// Archive ONLY exact test resources journalled by accept-local-workbench.mjs.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename, copyFile, lstat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const stack = "/home/fate/docker_files/pi-stack", reports = process.argv.slice(2);
// SQLite now owns the journal. This historical JSON-only archive helper must
// never silently edit a stale JSON file and claim it changed current records.
try {await lstat(path.join(stack,"local-workbench/state/manager.sqlite3"));throw Error("SQLite workbench: legacy JSON archive disabled; no data changed.");}
catch(error) {if(error.code !== "ENOENT") throw error;}
assert.ok(reports.length > 0);
const records = [];
for (const directory of reports) {
  assert.match(directory, /^\/tmp\/pi-local-accept-[A-Za-z0-9_-]+$/);
  const report = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
  assert.match(report.workspace, /^\/home\/fate\/gitproject\/pi-local-workbench-check-[a-f0-9]{8}$/);
  records.push(report);
}
const docker = (...args) => execFileSync("/usr/bin/docker", args, { encoding: "utf8" });
const ids = docker("ps", "-q").trim().split(/\s+/).filter(Boolean);
const running = ids.length ? JSON.parse(docker("inspect", ...ids)) : [];
for (const record of records) assert.ok(!running.some(container => container.Name === "/" + record.id || container.Mounts.some(mount => mount.Source === record.workspace)));
const stateFile = path.join(stack, "local-workbench/state/runs.json");
const runs = JSON.parse(await readFile(stateFile, "utf8"));
const ownIds = new Set(records.map(record => record.id).filter(Boolean));
for (const run of runs.filter(run => ownIds.has(run.id))) assert.equal(run.state, "stopped");
const archive = path.join(stack, "backup", "local-workbench-acceptance-" + new Date().toISOString().replaceAll(/[:.]/g, "-"));
await mkdir(archive, { mode: 0o700 });
await copyFile(stateFile, path.join(archive, "runs-before.json"));
for (const record of records) {
  const info = await lstat(record.workspace); assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid());
  await rename(record.workspace, path.join(archive, path.basename(record.workspace)));
}
await writeFile(stateFile, JSON.stringify(runs.filter(run => !ownIds.has(run.id))), { mode: 0o600 });
await writeFile(path.join(archive, "reports.json"), JSON.stringify(records, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ archived: records.length, archive, removedVolumes: false, remainingInstances: runs.filter(run => !ownIds.has(run.id)).length }));

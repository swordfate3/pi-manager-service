import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspacePolicy } from "../manager/workspaces.ts";
import type { ExecutorConfig } from "../manager/config.ts";

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "pi-local-browser-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "projects"), privateRoot = path.join(root, "private");
  await mkdir(path.join(root, "demo"), { recursive: true });
  await mkdir(privateRoot);
  await writeFile(path.join(root, "report.txt"), "contents must never be returned");
  const policy = await WorkspacePolicy.open({ stateRoot: path.join(home, "state"),
    submitSocket: path.join(home, "submit/rpc.sock"), adminSocket: path.join(home, "admin/rpc.sock"),
    principals: [], trustedLocalNative: true, native: { piExecutable: process.execPath,
      workspaceRoots: { projects: root }, stateRoot: path.join(home, "native"), agentRoot: path.join(home, "agent") },
    workspaces: {}, workspaceBrowser: { home, defaultRoot: "projects" },
  } as ExecutorConfig);
  const browse = async (request: unknown) => {
    assert.equal(typeof (policy as any).browseEntries, "function", "local file-name browser is not implemented");
    return (policy as any).browseEntries(request, [privateRoot]);
  };
  return { home, root, privateRoot, policy, browse };
}

test("local browser exposes metadata for regular files and directories, not contents or protected/symlink entries", async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, "report.txt"), path.join(f.root, "file-link"));
  await symlink(f.privateRoot, path.join(f.root, "directory-link"));
  await writeFile(path.join(f.root, "bad\nname.txt"), "hidden invalid name");
  const page = await f.browse({ root: "projects", path: "" });
  assert.deepEqual(page.entries.map((entry: any) => [entry.name, entry.kind, entry.path]), [
    ["demo", "directory", "demo"], ["report.txt", "file", "report.txt"],
  ]);
  assert.equal(page.total, 2); assert.equal(page.nextOffset, null); assert.equal(page.truncated, false);
  assert.ok(page.entries.every((entry: any) => Number.isFinite(entry.modifiedAt)));
  assert.ok(!JSON.stringify(page).includes("contents must never"));
  assert.ok(!JSON.stringify(page).includes(f.home));
  await assert.rejects(f.policy.resolve({ root: "projects", path: "report.txt" }), { status: 400 });
});

test("name filtering happens before the 200-entry page boundary and supports case-insensitive file names", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 205; index++) await mkdir(path.join(f.root, `item-${index}`));
  await writeFile(path.join(f.root, "ZZZ-Target.PDF"), "private file content");
  const filtered = await f.browse({ root: "projects", path: "", query: "target.pdf", sort: "name-asc", offset: 0 });
  assert.deepEqual(filtered.entries.map((entry: any) => entry.name), ["ZZZ-Target.PDF"]);
  assert.equal(filtered.total, 1);
  const first = await f.browse({ root: "projects", path: "", query: "item-", sort: "name-asc" });
  assert.equal(first.entries.length, 200); assert.equal(first.total, 205); assert.equal(first.nextOffset, 200);
  assert.equal(first.entries[0].name, "item-0"); assert.equal(first.entries[199].name, "item-199");
  const second = await f.browse({ root: "projects", path: "", query: "item-", offset: 200 });
  assert.deepEqual(second.entries.map((entry: any) => entry.name), ["item-200", "item-201", "item-202", "item-203", "item-204"]);
  assert.equal(second.nextOffset, null);
});

test("sorting is numeric and deterministic, folders stay before files, and modification ordering uses actual metadata", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "folder10")); await mkdir(path.join(f.root, "folder2"));
  await writeFile(path.join(f.root, "file10"), "ten"); await writeFile(path.join(f.root, "file2"), "two");
  await utimes(path.join(f.root, "folder10"), 1000, 1000); await utimes(path.join(f.root, "folder2"), 2000, 2000);
  await utimes(path.join(f.root, "file10"), 3000, 3000); await utimes(path.join(f.root, "file2"), 4000, 4000);
  const names = async (sort: string) => (await f.browse({ root: "projects", path: "", query: "1", sort })).entries.map((entry: any) => entry.name);
  assert.deepEqual(await names("modified-desc"), ["folder10", "file10"]);
  const sorted = await f.browse({ root: "projects", path: "", sort: "name-desc" });
  assert.deepEqual(sorted.entries.filter((entry: any) => /^(folder|file)/.test(entry.name)).map((entry: any) => entry.name), ["folder10", "folder2", "file10", "file2"]);
  const newest = await f.browse({ root: "projects", path: "", sort: "modified-desc" });
  assert.deepEqual(newest.entries.filter((entry: any) => /^(folder|file)/.test(entry.name)).map((entry: any) => entry.name), ["folder2", "folder10", "file2", "file10"]);
  const oldest = await f.browse({ root: "projects", path: "", sort: "modified-asc" });
  assert.deepEqual(oldest.entries.filter((entry: any) => /^(folder|file)/.test(entry.name)).map((entry: any) => entry.name), ["folder10", "folder2", "file10", "file2"]);
});

test("enhanced browsing rejects traversal, protected directories, unknown fields and malformed query/pagination", async t => {
  const f = await fixture(t);
  for (const request of [ { path: "../" }, { path: "private" }, { path: "report.txt" }, { sort: "shell-command" },
    { offset: -1 }, { offset: 0.5 }, { offset: "200" }, { offset: null }, { sort: null }, { query: null },
    { query: "a".repeat(201) }, { query: "bad\nquery" }, { extra: true } ]) {
    await assert.rejects(f.browse({ root: "projects", path: "", ...request }), { status: 400 });
  }
});

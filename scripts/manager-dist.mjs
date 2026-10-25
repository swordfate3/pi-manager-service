import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "build-manifest.json";
const SOURCE_DIRECTORIES = ["bin", "hub", "protocol", "gate/gate", "runtime"];
const SOURCE_FILES = [
  "gate/gatectl",
  "package.json",
  "package-lock.json",
  "scripts/manager-dist.mjs",
  "tsconfig.json",
  "vite.config.ts",
];
const REQUIRED_OUTPUTS = ["hub/pi-web-hub.mjs"];
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const fail = (message) => {
  throw new Error(message);
};

function validateKey(key) {
  if (
    typeof key !== "string" ||
    !key ||
    key.includes("\\") ||
    key.includes("\0") ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key) ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("Invalid inventory path");
  }
}

async function checkedRoot(rootPath) {
  const root = path.resolve(rootPath);
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Project root must be a real directory");
  return root;
}

async function checkedPath(root, key, expected) {
  validateKey(key);
  let current = root;
  for (const [index, part] of key.split("/").entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
    const final = index === key.split("/").length - 1;
    if (!final && !stat.isDirectory()) fail(`Expected directory in path: ${key}`);
    if (final && expected === "file" && !stat.isFile()) fail(`Expected regular file: ${key}`);
    if (final && expected === "directory" && !stat.isDirectory()) fail(`Expected directory: ${key}`);
  }
  return current;
}

async function hashFile(root, key) {
  const absolute = await checkedPath(root, key, "file");
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | NOFOLLOW);
    return digest(await handle.readFile());
  } catch (error) {
    if (error.code === "ELOOP") fail(`Refusing to follow symlink: ${key}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function walk(root, key, records, prefix = "") {
  const directory = await checkedPath(root, key, "directory");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    const child = `${key}/${entry.name}`;
    if (entry.isSymbolicLink()) fail(`Refusing to follow symlink: ${child}`);
    if (entry.isDirectory()) await walk(root, child, records, prefix);
    else if (entry.isFile()) records.push({ path: `${prefix}${child}`, sha256: await hashFile(root, child) });
    else fail(`Unsupported source entry: ${child}`);
  }
}

function inventory(records) {
  const files = records.sort((left, right) => compare(left.path, right.path));
  return { count: files.length, sha256: digest(JSON.stringify(files)), files };
}

export async function createSourceInventory(rootPath = DEFAULT_ROOT) {
  const root = await checkedRoot(rootPath);
  const records = [];
  for (const directory of SOURCE_DIRECTORIES) await walk(root, directory, records);
  for (const key of SOURCE_FILES) records.push({ path: key, sha256: await hashFile(root, key) });
  return inventory(records);
}

async function createOutputInventory(root) {
  const records = [];
  const dist = await checkedPath(root, "dist", "directory");
  async function visit(directory, relative) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const key = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), key);
      else if (entry.isFile() && key !== `dist/${MANIFEST}`) {
        records.push({ path: key.slice("dist/".length), sha256: await hashFile(root, key) });
      } else if (!entry.isFile()) fail(`Unsupported output entry: ${key}`);
    }
  }
  await visit(dist, "dist");
  const result = inventory(records);
  for (const required of REQUIRED_OUTPUTS) {
    if (!result.files.some((entry) => entry.path === required)) fail(`Build output is incomplete: dist/${required}`);
  }
  return result;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function writeManifest(rootPath = DEFAULT_ROOT) {
  const root = await checkedRoot(rootPath);
  const source = await createSourceInventory(root);
  const outputs = await createOutputInventory(root);
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "dist", MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, source, outputs }, null, 2)}\n`,
    { mode: 0o644 },
  );
  await chmod(path.join(root, "dist", "hub", "pi-web-hub.mjs"), 0o755);
  return { source, outputs };
}

export async function verifyManifest(rootPath = DEFAULT_ROOT) {
  const root = await checkedRoot(rootPath);
  const manifestPath = await checkedPath(root, `dist/${MANIFEST}`, "file");
  const recorded = JSON.parse(await readFile(manifestPath, "utf8"));
  if (recorded?.schemaVersion !== 1) fail("Unsupported build manifest");
  const source = await createSourceInventory(root);
  const outputs = await createOutputInventory(root);
  if (!same(recorded.source, source)) fail("Source inventory differs from the built distribution");
  if (!same(recorded.outputs, outputs)) fail("Output inventory differs from the built distribution");
  return recorded;
}

async function main(args) {
  if (args.length > 1 || (args[0] && args[0] !== "--write")) fail("Usage: manager-dist.mjs [--write]");
  if (args[0] === "--write") await writeManifest();
  else await verifyManifest();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Manager distribution verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

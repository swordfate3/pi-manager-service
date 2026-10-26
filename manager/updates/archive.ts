import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { StageError } from "./errors.ts";
import { record, strictJson } from "./json.ts";
import { PI_PACKAGE, type ResolvedRelease } from "./release.ts";

export const ARCHIVE_LIMITS = Object.freeze({ artifactBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024,
  treeBytes: 64 * 1024 * 1024, entries: 20_000, manifestBytes: 1024 * 1024, depth: 32 });
export interface ArchiveEntry { readonly name: string; readonly directory: boolean; readonly data: Buffer }
export interface CandidateExecutable { readonly name: string; readonly relativePath: string; readonly sha256: string }
export interface CheckedArchive {
  readonly entries: readonly ArchiveEntry[];
  readonly executables: readonly CandidateExecutable[];
  readonly candidateExecutable: string | null;
  readonly contentSha256: string;
  readonly packageLockSha256: string | null;
}
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const invalid = (): never => { throw new StageError("archive-invalid"); };

/** Canonical portable spelling: no traversal, platform aliases, control bytes or alternate separators. */
export function safeRelative(name: string): boolean {
  const parts = name.split("/");
  return name.length > 0 && name.length <= 1024 && parts.length <= ARCHIVE_LIMITS.depth && parts.every(part =>
    part.length > 0 && part !== "." && part !== ".." && /^[\x20-\x7e]+$/.test(part) && !/[\\:<>"|?*]/.test(part) &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function headerString(header: Buffer, start: number, size: number): string {
  const field = header.subarray(start, start + size);
  const nul = field.indexOf(0);
  if (nul !== -1 && field.subarray(nul).some(byte => byte !== 0)) return invalid();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(nul < 0 ? field : field.subarray(0, nul)); }
  catch { return invalid(); }
}
function octal(field: Buffer): number {
  const text = field.toString("ascii");
  if (field.some(byte => byte > 127) || !/^[ ]*[0-7]+[\x00 ]*$/.test(text)) return invalid();
  const value = Number.parseInt(text.trim().replace(/\0.*$/, ""), 8);
  if (!Number.isSafeInteger(value) || value < 0) return invalid(); return value;
}

/** Strict ustar subset; PAX/GNU extensions are refused rather than interpreted ambiguously. */
export async function checkArchive(data: Buffer, release: ResolvedRelease): Promise<CheckedArchive> {
  let tar: Buffer;
  try {
    tar = await new Promise<Buffer>((resolve, reject) => gunzip(data, { maxOutputLength: ARCHIVE_LIMITS.expandedBytes },
      (error, result) => error ? reject(error) : resolve(result)));
  } catch { throw new StageError("archive-invalid"); }
  if (tar.length < 1024 || tar.length % 512 !== 0) return invalid();
  const explicit = new Set<string>(), nodes = new Map<string, ArchiveEntry>(), aliases = new Map<string, string>();
  let total = 0, offset = 0, ended = false, headers = 0;
  function add(name: string, directory: boolean, content: Buffer) {
    const alias = name.toLowerCase();
    if (aliases.has(alias) && aliases.get(alias) !== name) return invalid();
    aliases.set(alias, name);
    const existing = nodes.get(name);
    if (existing && (!existing.directory || !directory)) return invalid();
    if (!existing) nodes.set(name, Object.freeze({ name, directory, data: content }));
    if (nodes.size > ARCHIVE_LIMITS.entries) throw new StageError("resource-limit");
  }
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) return invalid();
      ended = true; break;
    }
    if (++headers > ARCHIVE_LIMITS.entries) throw new StageError("resource-limit");
    if (header.toString("ascii", 257, 263) !== "ustar\0" || header.toString("ascii", 263, 265) !== "00") return invalid();
    const checksum = octal(header.subarray(148, 156));
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== checksum) return invalid();
    const type = header[156]; const directory = type === 53;
    if (type !== 0 && type !== 48 && !directory) return invalid();
    if (headerString(header, 157, 100) !== "") return invalid();
    const prefix = headerString(header, 345, 155), base = headerString(header, 0, 100);
    let name = prefix ? `${prefix}/${base}` : base;
    if (directory && name.endsWith("/")) name = name.slice(0, -1);
    if (!safeRelative(name) || (name !== "package" && !name.startsWith("package/")) || (name === "package" && !directory) || explicit.has(name)) return invalid();
    explicit.add(name);
    const size = octal(header.subarray(124, 136));
    total += size;
    if (total > ARCHIVE_LIMITS.treeBytes) throw new StageError("resource-limit");
    if ((directory && size !== 0) || offset + size > tar.length) return invalid();
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) add(parts.slice(0, i).join("/"), true, Buffer.alloc(0));
    add(name, directory, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) return invalid();
  const manifest = nodes.get("package/package.json");
  if (!manifest || manifest.directory || manifest.data.length > ARCHIVE_LIMITS.manifestBytes) throw new StageError("manifest-mismatch");
  let value: unknown;
  try { value = strictJson(manifest.data); } catch { throw new StageError("manifest-mismatch"); }
  if (!record(value) || value.name !== release.packageName || value.version !== release.version || !record(value.engines) || value.engines.node !== release.nodeEngine)
    throw new StageError("manifest-mismatch");
  const bins = typeof value.bin === "string" ? { [release.packageName.split("/").at(-1)!]: value.bin } : value.bin ?? {};
  if (!record(bins) || Object.keys(bins).length > 100) throw new StageError("manifest-mismatch");
  const executables: CandidateExecutable[] = [];
  for (const [name, target] of Object.entries(bins).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    // npm permits a leading ./ in bin, but no other path normalization is accepted.
    const relative = typeof target === "string" && target.startsWith("./") ? target.slice(2) : target;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || typeof relative !== "string" || !safeRelative(relative)) throw new StageError("manifest-mismatch");
    const file = nodes.get(`package/${relative}`);
    if (!file || file.directory) throw new StageError("manifest-mismatch");
    executables.push(Object.freeze({ name, relativePath: file.name, sha256: hash(file.data) }));
  }
  const primary = release.packageName === PI_PACKAGE ? executables.find(e => e.name === "pi") : executables.length === 1 ? executables[0] : undefined;
  if (release.packageName === PI_PACKAGE && !primary) throw new StageError("manifest-mismatch");
  const ordered = [...nodes.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const rows = ordered.map(entry => entry.directory ? [entry.name, "directory", 0o500] : [entry.name, "file", 0o400, entry.data.length, hash(entry.data)]);
  const lock = nodes.get("package/package-lock.json");
  if (lock?.directory) return invalid();
  return Object.freeze({ entries: Object.freeze(ordered), executables: Object.freeze(executables), candidateExecutable: primary?.relativePath ?? null,
    contentSha256: hash(JSON.stringify(rows)), packageLockSha256: lock ? hash(lock.data) : null });
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, symlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { strictJson } from './json.ts';

export class CandidateError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Candidate installation refused: ${code}`); this.name = 'CandidateError'; this.code = code; }
}
export const TREE_BYTES = 512 * 1024 * 1024, TREE_ENTRIES = 60000, TMPFS_BYTES = 1024 * 1024 * 1024;
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function safe(name: string): boolean {
  return name.length > 0 && name.length <= 1024 && name.split('/').length <= 32 && name.split('/').every(p =>
    p !== '' && p !== '.' && p !== '..' && /^[\x21-\x7e]+$/.test(p) && !/[\\:<>"|?*]/.test(p));
}
export async function privateRoot(root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/' || root.includes('\0') || await realpath(root) !== root) throw new CandidateError('root-unsafe');
  const uid = process.getuid?.(), system = (await lstat('/')).uid;
  for (let dir = root;; dir = path.dirname(dir)) {
    const s = await lstat(dir);
    if (!s.isDirectory() || (s.uid !== uid && s.uid !== system) || ((s.mode & 0o022) && !(s.uid === system && (s.mode & 0o1000)))) throw new CandidateError('root-unsafe');
    if (dir === root && (s.uid !== uid || (s.mode & 0o777) !== 0o700)) throw new CandidateError('root-unsafe');
    if (dir === '/') break;
  }
}
export async function boundedFile(file: string, max: number) {
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.size > max || (s.mode & 0o022)) throw new CandidateError('file-unsafe');
    const b = Buffer.alloc(s.size + 1), { bytesRead } = await f.read(b, 0, b.length, 0);
    const after = await f.stat();
    if (bytesRead !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs) throw new CandidateError('file-changed');
    return b.subarray(0, bytesRead);
  } finally { await f.close(); }
}
export async function writeNew(file: string, data: string | Buffer, mode = 0o400) {
  const f = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(data); await f.sync(); await f.chmod(mode); } finally { await f.close(); }
}
export async function syncDir(dir: string) {
  const f = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await f.sync(); } finally { await f.close(); }
}
export interface CandidateBudget { maxCandidates: number; maxBytes: number; maxEntries: number }
export function budget(value: Partial<CandidateBudget> = {}): CandidateBudget {
  const result = { maxCandidates: 4, maxBytes: 4 * 1024 ** 3, maxEntries: 250000, ...value };
  if (Object.keys(result).sort().join() !== 'maxBytes,maxCandidates,maxEntries' || Object.values(result).some(v => !Number.isSafeInteger(v) || v < 1) ||
    result.maxCandidates > 32 || result.maxBytes > 32 * 1024 ** 3 || result.maxEntries > 2000000) throw new CandidateError('options-invalid');
  return Object.freeze(result);
}
/** Count unknown partials at their full reservation, never at a claimed receipt size. */
export async function admit(root: string, limits: CandidateBudget) {
  let bytes = 0, entries = 0, candidates = 0;
  async function walk(dir: string, depth: number): Promise<number> {
    let subtotal = 0;
    const stream = await opendir(dir, { bufferSize: 1 });
    for await (const e of stream) {
      if (++entries > limits.maxEntries || depth > 35) throw new CandidateError('resource-limit');
      const p = path.join(dir, e.name), s = await lstat(p);
      if (s.uid !== process.getuid?.() || (!s.isSymbolicLink() && (s.mode & 0o022))) throw new CandidateError('root-unsafe');
      if (e.isDirectory()) subtotal += await walk(p, depth + 1);
      else if (e.isFile() && s.nlink === 1) subtotal += s.size;
      else if (e.isSymbolicLink() && path.basename(dir) === '.bin') {
        const resolved = await realpath(p);
        if (!resolved.startsWith(root + '/')) throw new CandidateError('root-unsafe');
        subtotal += s.size;
      } else throw new CandidateError('root-unsafe');
      if (subtotal > limits.maxBytes) throw new CandidateError('resource-limit');
    }
    return subtotal;
  }
  const stream = await opendir(root, { bufferSize: 1 });
  for await (const e of stream) {
    if (++entries > limits.maxEntries) throw new CandidateError('resource-limit');
    const p = path.join(root, e.name), s = await lstat(p);
    if (/^c-[a-f0-9]{64}$/.test(e.name) && e.isDirectory()) { candidates++; bytes += Math.max(TREE_BYTES + 2 * 1024 ** 2, await walk(p, 1)); }
    else if (['policy.json', '.writer'].includes(e.name) && s.isFile() && s.nlink === 1) bytes += s.size;
    else throw new CandidateError('root-unsafe');
    if (bytes > limits.maxBytes || candidates > limits.maxCandidates) throw new CandidateError('resource-limit');
  }
  if (candidates + 1 > limits.maxCandidates || bytes + TREE_BYTES + 2 * 1024 ** 2 + TMPFS_BYTES > limits.maxBytes ||
      entries + TREE_ENTRIES + 8 > limits.maxEntries) throw new CandidateError('resource-limit');
}

/** Streaming receiver: limits precede every filesystem write, not a post-install scan. */
export class CandidateReceiver {
  #file?: { handle: FileHandle; remaining: number; digest: ReturnType<typeof createHash>; row: any[] };
  #rows: any[][] = []; #seen = new Set<string>(); #directories = new Set<string>(); #bytes = 0; #result: any;
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async accept(line: Buffer) {
    if (line.length > 1024 * 1024 || this.#result) throw new CandidateError('output-invalid');
    const item: any = strictJson(line);
    if (!item || Object.keys(item).length !== 1) throw new CandidateError('output-invalid');
    if (this.#file) {
      if (item.end === true && this.#file.remaining === 0) {
        const f = this.#file;
        if (f.digest.digest('hex') !== f.row[4]) throw new CandidateError('content-invalid');
        await f.handle.sync(); await f.handle.chmod(f.row[2]); await f.handle.close(); this.#file = undefined; return;
      }
      if (typeof item.data !== 'string' || item.data.length > 65536) throw new CandidateError('output-invalid');
      const data = Buffer.from(item.data, 'base64');
      if (data.toString('base64') !== item.data || data.length === 0 || data.length > this.#file.remaining) throw new CandidateError('output-invalid');
      await this.#file.handle.writeFile(data); this.#file.digest.update(data); this.#file.remaining -= data.length; return;
    }
    if (item.result) { this.#result = item.result; return; }
    const row = item.entry;
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !safe(row[0]) || this.#seen.has(row[0]) || this.#seen.size >= TREE_ENTRIES) throw new CandidateError('output-invalid');
    const [name, type, mode] = row, target = path.join(this.root, name), parent = path.posix.dirname(name);
    if (parent !== '.' && !this.#directories.has(parent)) throw new CandidateError('output-invalid');
    this.#seen.add(name); this.#rows.push(row);
    if (type === 'directory' && row.length === 3 && mode === 0o500) {
      await mkdir(target, { mode: 0o700 }); this.#directories.add(name); return;
    }
    if (type === 'link' && row.length === 3 && path.posix.basename(parent) === '.bin' && typeof mode === 'string' && /^[a-zA-Z0-9@_./-]+$/.test(mode) && mode.length <= 1024 && !mode.startsWith('/')) {
      const resolved = path.resolve(path.dirname(target), mode);
      if (!resolved.startsWith(this.root + '/')) throw new CandidateError('output-invalid');
      this.#bytes += Buffer.byteLength(mode);
      if (this.#bytes > TREE_BYTES) throw new CandidateError('resource-limit');
      await symlink(mode, target); return;
    }
    if (type !== 'file' || row.length !== 5 || ![0o400, 0o500].includes(mode) || !Number.isSafeInteger(row[3]) || row[3] < 0 || !/^[a-f0-9]{64}$/.test(row[4])) throw new CandidateError('output-invalid');
    this.#bytes += row[3]; if (this.#bytes > TREE_BYTES) throw new CandidateError('resource-limit');
    this.#file = { handle: await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), remaining: row[3], digest: createHash('sha256'), row };
  }
  async finish() {
    if (this.#file || !this.#result) throw new CandidateError('output-incomplete');
    this.#rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const r = this.#result;
    if (r.contentSha256 !== hash(JSON.stringify(this.#rows)) || r.bytes !== this.#bytes || r.entries !== this.#rows.length) throw new CandidateError('content-invalid');
    for (const row of [...this.#rows].reverse()) if (row[1] === 'directory') { await chmod(path.join(this.root, row[0]), 0o500); await syncDir(path.join(this.root, row[0])); }
    await chmod(this.root, 0o500); await syncDir(this.root);
    return r;
  }
  async close() { await this.#file?.handle.close(); this.#file = undefined; }
}
export async function treeHash(root: string): Promise<string> {
  const s = await lstat(root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root || await realpath(root) !== root ||
      !s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o500) throw new CandidateError('content-invalid');
  const rows: any[][] = []; let bytes = 0;
  async function visit(dir: string, prefix: string) {
    const stream = await opendir(dir, { bufferSize: 1 });
    for await (const e of stream) {
      const name = prefix + e.name, p = path.join(dir, e.name), s = await lstat(p), mode = s.mode & 0o7777;
      if (!safe(name) || rows.length >= TREE_ENTRIES) throw new CandidateError('content-invalid');
      if (s.isDirectory() && mode === 0o500) { rows.push([name, 'directory', mode]); await visit(p, name + '/'); }
      else if (s.isFile() && [0o400, 0o500].includes(mode) && s.nlink === 1) {
        bytes += s.size; if (bytes > TREE_BYTES) throw new CandidateError('content-invalid');
        // Streaming read rather than a whole native dependency allocation.
        const f = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW), h = createHash('sha256');
        try { for await (const chunk of f.createReadStream({ autoClose: false })) h.update(chunk); } finally { await f.close(); }
        rows.push([name, 'file', mode, s.size, h.digest('hex')]);
      } else if (s.isSymbolicLink() && path.basename(dir) === '.bin') {
        const link = await readlink(p), resolved = await realpath(p);
        bytes += Buffer.byteLength(link); if (bytes > TREE_BYTES) throw new CandidateError('content-invalid');
        if (path.isAbsolute(link) || !resolved.startsWith(root + '/') || !(await lstat(resolved)).isFile()) throw new CandidateError('content-invalid');
        rows.push([name, 'link', link]);
      } else throw new CandidateError('content-invalid');
    }
  }
  await visit(root, ''); rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); return hash(JSON.stringify(rows));
}

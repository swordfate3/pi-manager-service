import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { strictJson } from './json.ts';

export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function refuse(code: string): never { throw Object.assign(new Error(`Compatibility refused: ${code}`), { code }); }
export function absolute(p: string) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p || p === '/' || p.length > 2048 || /[\x00-\x1f\\]/.test(p)) refuse('options-invalid');
  return p;
}
export async function fileBytes(file: string, max = 1024 * 1024) {
  if (await realpath(file) !== file) refuse('input-unsafe');
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o022) || s.size > max) refuse('input-unsafe');
    const b = Buffer.alloc(s.size + 1), { bytesRead } = await f.read(b, 0, b.length, 0), after = await f.stat();
    if (bytesRead !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) refuse('input-changed');
    return b.subarray(0, bytesRead);
  } finally { await f.close(); }
}
/** Narrow single-session format: linear v3 text/system dialogue and name metadata, no tool/custom/branch/migration input. */
export function sessionIdentity(bytes: Uint8Array) {
  try {
    if (!bytes.length || bytes.length > 1024 * 1024) throw Error();
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n');
    if (lines.length < 2 || lines.length > 4096 || lines.some(l => Buffer.byteLength(l) > 65536)) throw Error();
    const [head, ...rows]: any[] = lines.map(l => strictJson(Buffer.from(l)));
    const id = (s: any) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
    if (head.type !== 'session' || head.version !== 3 || !id(head.id) || typeof head.cwd !== 'string' || !path.isAbsolute(head.cwd)) throw Error();
    const seen = new Set(); let leaf: string | null = null, messages = 0;
    for (const row of rows) {
      if (!id(row.id) || seen.has(row.id) || row.parentId !== leaf || typeof row.timestamp !== 'string') throw Error();
      if (row.type === 'message') {
        const m = row.message;
        if (!m || !['user', 'assistant', 'system'].includes(m.role) || !Number.isFinite(m.timestamp)) throw Error();
        if (typeof m.content !== 'string' && (!Array.isArray(m.content) || !m.content.length || m.content.some((b: any) => b.type !== 'text' || typeof b.text !== 'string'))) throw Error();
        if (m.role === 'system') {
          if (m.sections && (typeof m.sections !== 'object' || Array.isArray(m.sections) || Object.values(m.sections).some(v => v !== null && typeof v !== 'string'))) throw Error();
          for (const key of ['tools', 'toolsAdded', 'toolsRemoved']) if (m[key] !== undefined && (!Array.isArray(m[key]) || m[key].length)) throw Error();
        } else messages++;
      } else if (row.type === 'model_change') {
        if (typeof row.provider !== 'string' || typeof row.modelId !== 'string') throw Error();
      } else if (row.type === 'thinking_level_change') {
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(row.thinkingLevel)) throw Error();
      } else if (row.type === 'session_info') {
        if (typeof row.name !== 'string' || row.name.length > 1024) throw Error();
      } else throw Error();
      seen.add(row.id); leaf = row.id;
    }
    if (!messages) throw Error();
    return { sha256: digest(bytes), sessionId: head.id as string, leafId: leaf!, version: 3, messages };
  } catch { return refuse('session-invalid'); }
}

/** Independent bounded inventory; never executes a package's own verifier. No ambient dependencies. */
export async function inventory(root: string, containerMountRoot = false) {
  absolute(root); if (await realpath(root) !== root) refuse('input-unsafe');
  const files: { path: string; sha256: string; size: number }[] = []; let bytes = 0, entries = 0;
  async function walk(dir: string, prefix: string, depth: number) {
    const s = await lstat(dir);
    // Docker creates the parent of individually mounted source files as root.
    // This exception never applies to files/subdirectories or ordinary host profiles.
    if (!s.isDirectory() || (s.uid !== process.getuid?.() && !(containerMountRoot && depth === 0 && s.uid === 0)) || (s.mode & 0o022) || depth > 32) refuse('input-unsafe');
    for await (const e of await opendir(dir, { bufferSize: 1 })) {
      if (++entries > 20000 || !/^[A-Za-z0-9@_. -]+$/.test(e.name) || e.name === 'node_modules' || e.name === '.git') refuse('input-unsafe');
      const rel = prefix + e.name, file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file, rel + '/', depth + 1);
      else if (e.isFile()) {
        const size = (await lstat(file)).size; bytes += size;
        if (bytes > 128 * 1024 ** 2) refuse('input-unsafe');
        files.push({ path: rel, sha256: digest(await fileBytes(file, 32 * 1024 ** 2)), size });
      } else refuse('input-unsafe');
    }
  }
  await walk(root, '', 0); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: digest(JSON.stringify(files)), files, bytes };
}
export async function webInventory(root: string) {
  const all = await inventory(root), manifest: any = strictJson(await fileBytes(path.join(root, 'dist/build-manifest.json')));
  const pkg: any = strictJson(await fileBytes(path.join(root, 'package.json')));
  if (pkg.name !== '@kkkiio/pi-web-ui' || pkg.bin || !pkg.peerDependencies?.['@earendil-works/pi-coding-agent'] ||
    all.files.some(f => /^(hub|gate|runtime)\//.test(f.path))) refuse('web-invalid');
  if (manifest.schemaVersion !== 1) refuse('web-invalid');
  for (const kind of ['source', 'outputs']) {
    const inv = manifest[kind];
    if (!inv || !Array.isArray(inv.files) || inv.files.length > 20000 || inv.count !== inv.files.length || digest(JSON.stringify(inv.files)) !== inv.sha256) refuse('web-invalid');
    const seen = new Set<string>();
    for (const row of inv.files) {
      if (typeof row.path !== 'string' || !hex(row.sha256) || seen.has(row.path) || row.path.split('/').some((p: string) => !p || p === '.' || p === '..')) refuse('web-invalid');
      seen.add(row.path);
      const actual = all.files.find(f => f.path === (kind === 'outputs' ? 'dist/' : '') + row.path);
      // npm archives omit frontend build inputs; every shipped source and output must match.
      if ((kind === 'outputs' || actual) && actual?.sha256 !== row.sha256) refuse('web-invalid');
    }
    // The build-source subset is not a package inventory (e.g. imessage-bridge).
    // All shipped extras are independently covered by the administrator-pinned all.sha256.
    const shippedOutputs = all.files.filter(f => f.path.startsWith('dist/') && f.path !== 'dist/build-manifest.json');
    if (kind === 'outputs' && shippedOutputs.some(f => !seen.has(f.path.slice(5)))) refuse('web-invalid');
  }
  if (!all.files.some(f => f.path === 'dist/index.html') || !all.files.some(f => f.path === 'extensions/mirror-server.ts')) refuse('web-invalid');
  return { ...all, sourceSha256: manifest.source.sha256, outputSha256: manifest.outputs.sha256, packageVersion: pkg.version };
}

/** Same canonical tree format as CandidateInstaller, independently read at the daemon mount boundary. */
export async function candidateTreeHash(root: string) {
  const rows: any[][] = []; let bytes = 0;
  async function visit(dir: string, prefix: string, depth: number) {
    const ds = await lstat(dir);
    if (!ds.isDirectory() || ds.uid !== process.getuid?.() || (ds.mode & 0o7777) !== 0o500 || depth > 32 || await realpath(dir) !== dir) refuse('candidate-changed');
    for await (const e of await opendir(dir, { bufferSize: 1 })) {
      const name = prefix + e.name, p = path.join(dir, e.name), s = await lstat(p), mode = s.mode & 0o7777;
      if (rows.length >= 60000 || s.uid !== process.getuid?.()) refuse('candidate-changed');
      if (s.isDirectory()) { rows.push([name, 'directory', mode]); await visit(p, name + '/', depth + 1); }
      else if (s.isFile() && s.nlink === 1 && [0o400, 0o500].includes(mode)) {
        bytes += s.size; if (bytes > 512 * 1024 ** 2) refuse('candidate-changed');
        const f = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), h = createHash('sha256');
        try { for await (const chunk of f.createReadStream({ autoClose: false })) h.update(chunk); } finally { await f.close(); }
        rows.push([name, 'file', mode, s.size, h.digest('hex')]);
      } else if (s.isSymbolicLink() && path.basename(dir) === '.bin') {
        const link = await readlink(p), target = await realpath(p); bytes += Buffer.byteLength(link);
        if (path.isAbsolute(link) || !target.startsWith(root + '/') || !(await lstat(target)).isFile() || bytes > 512 * 1024 ** 2) refuse('candidate-changed');
        rows.push([name, 'link', link]);
      } else refuse('candidate-changed');
    }
  }
  await visit(root, '', 0); rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return digest(JSON.stringify(rows));
}

/** Resolve fixed ESM entrypoints by the selected package's import export, never ambient require conditions. */
export async function selectedModule(root: string, name: string, subpath = '.') {
  if (!['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].includes(name) || !['.', './compat'].includes(subpath)) refuse('sdk-export-invalid');
  const dir = path.join(root, 'node_modules', name), manifest: any = strictJson(await fileBytes(path.join(dir, 'package.json')));
  const exp = manifest.exports?.[subpath], relative = typeof exp === 'string' ? exp : exp?.import;
  if (manifest.name !== name || typeof relative !== 'string' || !/^\.\/dist\/[A-Za-z0-9_./-]+\.js$/.test(relative) || relative.split('/').slice(1).some(p => p === '..' || p === '.' || !p)) refuse('sdk-export-invalid');
  const file = path.join(dir, relative);
  if (await realpath(file) !== file || !(await lstat(file)).isFile()) refuse('sdk-export-invalid');
  return file;
}

export function parseProbe(bytes: Uint8Array, binding: any): any {
  try {
    if (bytes.length > 65536) throw Error();
    const r: any = strictJson(bytes);
    if (Object.keys(r).sort().join() !== 'binding,observations,schema,status' || r.schema !== 1 || r.status !== 'compatible' ||
      JSON.stringify(r.binding) !== JSON.stringify(binding) || !Array.isArray(r.observations)) throw Error();
    const names = ['selected-sdk', 'web-read', 'generation-settled', 'barrier-rejected', 'exact-cancel', 'generation-resumed', 'session-restored', 'web-void-tainted'];
    if (r.observations.length !== names.length || r.observations.some((x: any, i: number) => x.event !== names[i])) throw Error();
    const [sdk, web, first, fence, cancel, resumed, restore, taint] = r.observations;
    if (sdk.version !== binding.release.version || sdk.node !== binding.node || !sdk.module.startsWith('/candidate/node_modules/') ||
      web.httpStatus !== 200 || web.readOk !== true || !hex(web.bodySha256) ||
      first.disposition !== 'started' || first.aborted !== false || first.text !== 'COMPAT_RESPONSE' ||
      fence.promptOk !== false || fence.mutationOk !== false || fence.wrongCancelOk !== false ||
      cancel.cancelled !== true || resumed.disposition !== 'started' || resumed.aborted !== false || resumed.text !== 'COMPAT_RESPONSE' ||
      !hex(restore.copySha256) || !hex(restore.messagesSha256) || !restore.sessionId || !restore.leafId || restore.beforeLeaf !== restore.leafId ||
      restore.beforeSession !== restore.sessionId || taint.dispatchOk !== true || taint.prepareOk !== false || taint.settled !== true) throw Error();
    if (binding.session && (restore.copySha256 !== binding.session.sha256 || restore.sessionId !== binding.session.sessionId || restore.leafId !== binding.session.leafId)) throw Error();
    return r;
  } catch { return refuse('probe-invalid'); }
}

// Content + metadata digest; reads only, never follows symlinks out of the runtime.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
const root = '/home/node/.local', hash = createHash('sha256');
let files = 0;
async function visit(relative) {
  const p = path.join(root, relative), s = await lstat(p);
  hash.update(JSON.stringify([relative, s.mode, s.uid, s.gid]));
  if (s.isSymbolicLink()) hash.update(await readlink(p));
  else if (s.isDirectory()) for (const name of (await readdir(p)).sort()) await visit(path.join(relative, name));
  else if (s.isFile()) { files++; for await (const chunk of createReadStream(p)) hash.update(chunk); }
  else throw new Error('Unexpected runtime file type');
}
await visit('');
console.log(JSON.stringify({ digest: hash.digest('hex'), files }));

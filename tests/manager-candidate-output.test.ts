import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { CandidateReceiver, admit, budget, TREE_BYTES } from '../manager/updates/candidate-storage.ts';

async function temporary(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), 'candidate-output-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const line = (value: unknown) => Buffer.from(JSON.stringify(value));
test('bounded artifact reads reject FIFOs immediately rather than blocking during open', async t => {
  const root = await temporary(t), file = path.join(root, 'fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [file]).status, 0);
  const result = spawnSync(process.execPath, ['--import', './tests/register-ts.mjs', '--input-type=module', '-e',
    "import {boundedFile} from './manager/updates/candidate-storage.ts'; try {await boundedFile(process.argv[1],1024);process.exitCode=2} catch(e) {process.exitCode=e.code==='file-unsafe'?0:3}", file],
    { timeout: 2000, encoding: 'utf8' });
  assert.equal(result.status, 0, 'FIFO open must not hang: ' + result.error);
});
test('receiver rejects excess declared bytes before creating a file, not after writing it', async t => {
  const root = await temporary(t), receiver = new CandidateReceiver(root);
  await assert.rejects(receiver.accept(line({ entry: ['huge', 'file', 256, TREE_BYTES + 1, '0'.repeat(64)] })), { code: 'resource-limit' });
  assert.deepEqual(await readdir(root), []);
});
test('receiver rejects traversal, missing parents, unsafe symlinks and oversized protocol lines before writes', async t => {
  for (const row of [['../escape', 'directory', 320], ['missing/file', 'file', 256, 0, '0'.repeat(64)], ['alias', 'link', '/etc/passwd']]) {
    const root = await temporary(t), receiver = new CandidateReceiver(root);
    await assert.rejects(receiver.accept(line({ entry: row })), { code: 'output-invalid' });
    assert.deepEqual(await readdir(root), []);
  }
  const root = await temporary(t), receiver = new CandidateReceiver(root);
  await assert.rejects(receiver.accept(Buffer.alloc(1024 * 1024 + 1)), { code: 'output-invalid' });
});
test('receiver refuses a changed file hash and incomplete output, retaining the partial for accounting', async t => {
  const root = await temporary(t), receiver = new CandidateReceiver(root);
  try {
    await receiver.accept(line({ entry: ['file', 'file', 256, 1, '0'.repeat(64)] }));
    await receiver.accept(line({ data: 'eA==' }));
    await assert.rejects(receiver.accept(line({ end: true })), { code: 'content-invalid' });
    await assert.rejects(receiver.finish(), { code: 'output-incomplete' });
    assert.deepEqual(await readdir(root), ['file']);
  } finally { await receiver.close(); }
});
test('retained safe bin links remain admissible while two partials consume full aggregate reservations', async t => {
  const root = await temporary(t);
  const candidate = path.join(root, 'c-' + 'a'.repeat(64));
  await mkdir(path.join(candidate, 'tree/node_modules/.bin'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(candidate, 'tree/node_modules/cli'), 'x', { mode: 0o400 });
  await symlink('../cli', path.join(candidate, 'tree/node_modules/.bin/x'));
  await admit(root, budget());
  await mkdir(path.join(root, 'c-' + 'b'.repeat(64)), { mode: 0o700 });
  await assert.rejects(admit(root, budget({ maxBytes: 2 * 1024 ** 3 })), { code: 'resource-limit' });
});

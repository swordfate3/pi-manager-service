import assert from 'node:assert/strict';
import { writeFile, chmod, chown } from 'node:fs/promises';
import { serve, rpc } from './rpc.mjs';
import { routeEntry } from './protocol.mjs';
import { probeBoundaries } from './access.mjs';

const [mode, arg, json] = process.argv.slice(2);
if (mode === 'init') {
  assert.equal(process.getuid(), 0);
  const domains = {
    private: [21001, 21001, 0o700], control: [21001, 21001, 0o700],
    exec: [21001, 21002, 0o750], admin: [21001, 21005, 0o750],
    public: [21002, 21006, 0o750], 'frontend-work': [21003, 21003, 0o700],
    'agent-work': [21004, 21004, 0o700],
  };
  // This helper receives ONLY the seven freshly-created, ownership-checked volumes.
  for (const [name, [uid, gid, mode]] of Object.entries(domains)) {
    await chown(`/init/${name}`, uid, gid);
    await chmod(`/init/${name}`, mode);
  }
  await writeFile('/init/private/admin-secret', 'SYNTHETIC-TEST-CREDENTIAL-NOT-A-REAL-SECRET', { mode: 0o600, flag: 'wx' });
  await chown('/init/private/admin-secret', 21001, 21001);
  console.log('INIT OK');
} else if (mode === 'hold') {
  assert.ok([21003, 21004, 21005].includes(process.getuid()));
  console.log('READY client');
  setTimeout(() => process.exit(1), 180_000);
  process.on('SIGTERM', () => process.exit(0));
} else if (mode === 'entry') {
  assert.equal(process.getuid(), 21002);
  const server = await serve('/public/entry.sock', 21006, message => routeEntry(message, async forwarded => {
    const result = await rpc('/exec/executor.sock', forwarded);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }));
  console.log('READY entry');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 180_000);
} else if (mode === 'rpc') {
  if (!['/public/entry.sock', '/admin/approval.sock', '/exec/executor.sock'].includes(arg)) throw new Error('Unexpected client channel');
  if (arg === '/exec/executor.sock') assert.equal(process.getuid(), 21002, 'Direct exec probe belongs to actual entry domain');
  console.log(JSON.stringify(await rpc(arg, JSON.parse(json))));
} else if (mode === 'boundaries') {
  console.log(JSON.stringify(await probeBoundaries(process.getuid())));
} else throw new Error('Unknown fixture mode');

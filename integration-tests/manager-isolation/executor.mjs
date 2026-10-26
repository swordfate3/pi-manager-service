// Only this container receives the actual TaskStore source and private volume.
import { TaskStore } from './task-store.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { ProbeExecutor, POLICY, exact, routeExecutor } from '/fixture/protocol.mjs';
import { serve } from '/fixture/rpc.mjs';

process.umask(0o077);
if (process.getuid() !== 21001) throw new Error('Wrong executor UID');
await writeFile('/private/policy.json', JSON.stringify(POLICY), { flag: 'wx', mode: 0o600 }).catch(error => {
  if (error.code !== 'EEXIST') throw error;
});
if (await readFile('/private/policy.json', 'utf8') !== JSON.stringify(POLICY)) throw new Error('Policy changed');
const store = await TaskStore.open('/private/store');
const executor = new ProbeExecutor(store, '/control/marker');
const servers = [
  await serve('/exec/executor.sock', 21002, message => routeExecutor(message, executor)),
  await serve('/admin/approval.sock', 21005, async message => {
    exact(message, ['op', 'body']);
    if (message.op === 'approve') return executor.approve(message.body);
    if (message.op === 'query') {
      exact(message.body, ['taskId']);
      return executor.get(message.body.taskId);
    }
    if (message.op === 'evidence') {
      exact(message.body, []);
      let marker = '';
      try { marker = await readFile('/control/marker', 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { marker };
    }
    throw new Error('Unknown administrator operation');
  }),
];
console.log('READY executor');
let closing = false;
process.on('SIGTERM', async () => {
  if (closing) return;
  closing = true;
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await executor.idle();
    await store.close();
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(1); }
});
setTimeout(() => { console.error('Fixture lifetime exceeded'); process.exit(1); }, 180_000);

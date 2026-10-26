import assert from 'node:assert/strict';
import test from 'node:test';

const load = async () => {
  const guards = await import('./guards.mjs').catch(() => null);
  assert.ok(guards, 'actual-service runner needs explicit target and ownership guards');
  return guards;
};
const image = 'sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6';
const daemon = 'bac0be49-8ddb-4387-83aa-362f70f3ae8d';
const run = 'a'.repeat(32), id = 'b'.repeat(64);

test('only the explicitly acknowledged pinned local target is accepted', async () => {
  const g = await load();
  const args = ['--run', '--allow-host-network', '--image', image, '--daemon-id', daemon];
  assert.deepEqual(g.parseArgs(args), { image, daemonId: daemon });
  for (const bad of [[], args.slice(1), args.filter(v => v !== '--allow-host-network'), [...args, '--run'],
    [...args, '--pull'], args.map(v => v === image ? 'node:latest' : v), args.map(v => v === daemon ? 'other-daemon' : v)]) {
    assert.throws(() => g.parseArgs(bad));
  }
});

test('role cleanup requires exact new ID and matching random ownership label', async () => {
  const g = await load();
  const record = { id, name: `msi-${run}-public`, role: 'public' };
  const info = { Id: id, Name: `/${record.name}`, Config: { Labels: { [g.LABEL]: run } } };
  g.assertRoleOwned(record, info, run, []);
  for (const [item, baseline] of [[{ ...info, Id: 'c'.repeat(64) }, []], [info, [id]],
    [{ ...info, Config: { Labels: { [g.LABEL]: 'd'.repeat(32) } } }, []], [{ ...info, Name: '/foreign' }, []]]) {
    assert.throws(() => g.assertRoleOwned(record, item, run, baseline));
  }
  assert.throws(() => g.assertRoleOwned({ ...record, id: 'short' }, info, run, []));
});

test('backend cleanup is bound to private journal nonce, owner, target and exact resource identity', async () => {
  const g = await load();
  const task = { id: '12345678-1234-4234-8234-123456789abc', requester: 'd'.repeat(64), target: `child-${run}`,
    action: 'docker.create', result: { containerId: id, homeVolume: 'pi-manager-home-12345678123442348234123456789abc' } };
  const labels = { 'cn.swordfate.pi-manager.owner': task.requester, 'cn.swordfate.pi-manager.nonce': task.id,
    'cn.swordfate.pi-manager.instance': task.target };
  const info = { Id: id, Image: image, Name: '/pi-manager-12345678123442348234123456789abc', Config: { Labels: labels } };
  g.assertBackendOwned('container', info, task, run, []);
  g.assertBackendOwned('volume', { Name: task.result.homeVolume, Labels: labels }, task, run, []);
  assert.throws(() => g.assertBackendOwned('container', info, task, run, [id]));
  assert.throws(() => g.assertBackendOwned('container', { ...info, Id: 'e'.repeat(64) }, task, run, []));
  assert.throws(() => g.assertBackendOwned('container', { ...info, Image: 'sha256:' + '0'.repeat(64) }, task, run, []));
  assert.throws(() => g.assertBackendOwned('container', info, { ...task, target: 'foreign' }, run, []));
  assert.throws(() => g.assertBackendOwned('volume', { Name: 'foreign', Labels: labels }, task, run, []));
  assert.throws(() => g.assertBackendOwned('volume', { Name: task.result.homeVolume, Labels: {} }, task, run, []));
});

test('errors, timeouts, signals and truncated output cannot be mistaken for successful probes', async () => {
  const g = await load();
  assert.equal(g.checkedResult({ status: 0, stdout: 'ok\n', stderr: '' }), 'ok');
  for (const bad of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('timeout') },
    { status: 0, stdout: 'x'.repeat(g.MAX_OUTPUT + 1) }]) assert.throws(() => g.checkedResult(bad));
});

test('temporary root guard refuses broad, noncanonical and mismatched ownership paths', async () => {
  const g = await load();
  g.assertTemporaryRoot(`/tmp/msi-${run}-abc123`, run);
  for (const root of ['/', '/tmp', '/home/fate', `/tmp/msi-${run}-abc123/..`, '/tmp/foreign', `/tmp/msi-${'b'.repeat(32)}-abc123`]) {
    assert.throws(() => g.assertTemporaryRoot(root, run));
  }
});

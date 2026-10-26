// Host-side safety checks only. Importing this module never contacts Docker.
import assert from 'node:assert/strict';
export const IMAGE = 'sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6';
export const DAEMON = 'bac0be49-8ddb-4387-83aa-362f70f3ae8d';
export const SOCKET = '/var/run/docker.sock';
export const LABEL = 'cn.swordfate.manager-service-isolation.run';
export const MAX_OUTPUT = 512 * 1024;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nonce = run => assert.match(run, /^[a-f0-9]{32}$/);

export function parseArgs(args) {
  const found = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert.ok(['--run', '--allow-host-network', '--image', '--daemon-id'].includes(key), 'Unknown option');
    assert.ok(!found.has(key), 'Duplicate option');
    found.set(key, ['--image', '--daemon-id'].includes(key) ? args[++i] : true);
  }
  assert.equal(found.get('--run'), true, 'Explicit --run required');
  assert.equal(found.get('--allow-host-network'), true, 'Explicit --allow-host-network required (not network isolation)');
  assert.equal(found.get('--image'), IMAGE, 'Only the approved local image is supported');
  assert.equal(found.get('--daemon-id'), DAEMON, 'Only the approved daemon is supported');
  return { image: IMAGE, daemonId: DAEMON };
}

export function assertTemporaryRoot(root, run) {
  nonce(run);
  assert.match(root, new RegExp(`^/tmp/msi-${run}-[A-Za-z0-9]{6}$`), 'Not this run\'s exact temporary root');
}

export function assertRoleOwned(record, info, run, baseline) {
  nonce(run); assert.match(record.id, hex);
  assert.equal(baseline.includes(record.id), false, 'Preexisting container cannot be mutated');
  assert.match(record.name, new RegExp(`^msi-${run}-[a-z-]+$`));
  assert.equal(info.Id, record.id); assert.equal(info.Name, `/${record.name}`);
  assert.equal(info.Config?.Labels?.[LABEL], run, 'Run label mismatch');
}

export function assertBackendOwned(kind, info, task, run, baseline) {
  nonce(run); assert.match(task.id, uuid); assert.match(task.requester, hex);
  assert.equal(task.action, 'docker.create'); assert.equal(task.target, `child-${run}`);
  const suffix = task.id.replaceAll('-', '');
  const labels = kind === 'container' ? info.Config?.Labels : info.Labels;
  for (const [key, value] of Object.entries({ owner: task.requester, nonce: task.id, instance: task.target })) {
    assert.equal(labels?.[`cn.swordfate.pi-manager.${key}`], value, 'Backend ownership label mismatch');
  }
  if (kind === 'container') {
    assert.match(info.Id, hex); assert.equal(baseline.includes(info.Id), false);
    assert.equal(info.Name, `/pi-manager-${suffix}`); assert.equal(info.Image, IMAGE);
    if (task.result?.containerId) assert.equal(info.Id, task.result.containerId);
  } else {
    assert.equal(kind, 'volume'); assert.equal(info.Name, `pi-manager-home-${suffix}`);
    if (task.result?.homeVolume) assert.equal(info.Name, task.result.homeVolume);
  }
}

export function checkedResult(result) {
  if (result.error || result.signal || result.status !== 0) throw new Error(`Command failed: status=${result.status}, signal=${result.signal ?? 'none'}, ${(result.error?.message ?? result.stderr ?? '').slice(0, 1024)}`);
  assert.ok(Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') <= MAX_OUTPUT, 'Command output exceeded limit');
  return (result.stdout ?? '').trim();
}

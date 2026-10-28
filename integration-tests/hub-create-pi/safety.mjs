import assert from 'node:assert/strict';

export const TEST_LABEL = 'cn.swordfate.pi-manager.acceptance';
export const OWNER = 'cn.swordfate.pi-manager.owner';
export const NONCE = 'cn.swordfate.pi-manager.nonce';
export const INSTANCE = 'cn.swordfate.pi-manager.instance';

export function gates(env) {
  if (env.PI_MANAGER_DOCKER_TEST !== '1') return null;
  assert.match(env.PI_MANAGER_DOCKER_TEST_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/, 'Explicit immutable test image required');
  assert.ok(env.PI_MANAGER_TEST_WEB_ROOT?.startsWith('/'), 'Explicit absolute clean Web v1 source required');
  return { image: env.PI_MANAGER_DOCKER_TEST_IMAGE, webRoot: env.PI_MANAGER_TEST_WEB_ROOT };
}

export function checkHelper(info, record, image, nonce, baseline) {
  assert.ok(info && record.id, 'Missing journaled helper identity');
  assert.equal(info.Id, record.id);
  assert.equal(info.Name, `/${record.name}`);
  assert.equal(info.Image, image);
  assert.equal(info.Config.Labels[TEST_LABEL], nonce);
  assert.equal(baseline.has(info.Id), false, 'Never touch a baseline container');
}

export function checkPi(info, record, image, target, baseline) {
  assert.equal(record.state, 'succeeded', 'Unknown backend outcome: preserve evidence and data');
  assert.match(record.id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(record.target, target);
  assert.equal(record.action, 'docker.create');
  assert.equal(record.result.homeVolume, `pi-manager-home-${record.id.replaceAll('-', '')}`);
  assert.equal(info.Id, record.result.containerId);
  assert.equal(info.Image, image);
  assert.equal(baseline.has(info.Id), false);
  checkHomeLabels(info.Config.Labels, record, target);
}

export function checkHomeLabels(labels, record, target) {
  assert.equal(record.target, target);
  assert.equal(labels[OWNER], record.requester);
  assert.equal(labels[NONCE], record.id);
  assert.equal(labels[INSTANCE], target);
}

export function snapshot(info) {
  return { id: info.Id, startedAt: info.State.StartedAt, running: info.State.Running, restartCount: info.RestartCount };
}

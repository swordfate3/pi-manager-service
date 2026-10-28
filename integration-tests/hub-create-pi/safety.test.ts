import assert from 'node:assert/strict';
import test from 'node:test';
import { gates, checkHelper, checkPi, checkHomeLabels, TEST_LABEL, OWNER, NONCE, INSTANCE } from './safety.mjs';

test('opt-in cannot use a mutable image or implicitly select Web sources', () => {
  assert.equal(gates({}), null);
  assert.equal(gates({ PI_MANAGER_DOCKER_TEST: '0' }), null);
  for (const image of ['', 'pi-sandbox:latest', 'sha256:123']) {
    assert.throws(() => gates({ PI_MANAGER_DOCKER_TEST: '1', PI_MANAGER_DOCKER_TEST_IMAGE: image, PI_MANAGER_TEST_WEB_ROOT: '/fixture' }));
  }
  const image = `sha256:${'a'.repeat(64)}`;
  assert.throws(() => gates({ PI_MANAGER_DOCKER_TEST: '1', PI_MANAGER_DOCKER_TEST_IMAGE: image }));
  assert.deepEqual(gates({ PI_MANAGER_DOCKER_TEST: '1', PI_MANAGER_DOCKER_TEST_IMAGE: image, PI_MANAGER_TEST_WEB_ROOT: '/fixture' }), { image, webRoot: '/fixture' });
});

test('helper cleanup rejects baseline IDs, changed label/image/name and unjournaled IDs', () => {
  const record = { id: 'a'.repeat(64), name: 'exact-helper' };
  const info = { Id: record.id, Name: '/exact-helper', Image: 'pinned', Config: { Labels: { [TEST_LABEL]: 'random-run' } } };
  checkHelper(info, record, 'pinned', 'random-run', new Map());
  for (const changed of [{ ...info, Image: 'other' }, { ...info, Name: '/other' }, { ...info, Config: { Labels: {} } }]) {
    assert.throws(() => checkHelper(changed, record, 'pinned', 'random-run', new Map()));
  }
  assert.throws(() => checkHelper(info, {}, 'pinned', 'random-run', new Map()));
  assert.throws(() => checkHelper(info, record, 'pinned', 'random-run', new Map([[info.Id, {}]])));
});

test('Pi/home cleanup needs exact durable backend nonce, owner, random target and nonbaseline identity', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const record = { id, target: 'random-target', action: 'docker.create', requester: 'policy-owner', state: 'succeeded', result: { containerId: 'a'.repeat(64), homeVolume: `pi-manager-home-${id.replaceAll('-', '')}` } };
  const labels = { [OWNER]: record.requester, [NONCE]: id, [INSTANCE]: record.target };
  const info = { Id: record.result.containerId, Image: 'pinned', Config: { Labels: labels } };
  checkPi(info, record, 'pinned', record.target, new Map());
  for (const state of ['unknown', 'running', 'failed']) assert.throws(() => checkPi(info, { ...record, state }, 'pinned', record.target, new Map()));
  for (const field of [OWNER, NONCE, INSTANCE]) assert.throws(() => checkHomeLabels({ ...labels, [field]: 'foreign' }, record, record.target));
  assert.throws(() => checkPi(info, record, 'pinned', 'foreign-target', new Map()));
  assert.throws(() => checkPi(info, record, 'pinned', record.target, new Map([[info.Id, {}]])));
  assert.throws(() => checkPi({ ...info, Image: 'foreign' }, record, 'pinned', record.target, new Map()));
});

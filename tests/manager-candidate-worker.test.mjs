import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('candidate worker real lock, content, link and hard resource-bound tests', () => {
  const result = spawnSync('python3', ['tests/manager-candidate-worker.test.py'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1000000,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

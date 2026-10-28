import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PI_LOGS_SOURCE } from './eval-source.mjs';

test('generated Pi log-reader module parses without executing Docker or reading Pi files', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: PI_LOGS_SOURCE, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

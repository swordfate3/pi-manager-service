import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('clean builds declare the browser test types included by tsconfig', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  // These tests are typechecked even when browser execution is opt-in.
  for (const file of ['tests/interaction-page.test.ts', 'tests/manager-service.test.ts']) {
    assert.match(await readFile(new URL(file, root), 'utf8'), /import\("@playwright\/test"\)/);
  }
  assert.ok(manifest.devDependencies['@playwright/test'], 'Playwright types must not depend on a shared node_modules');
  assert.equal(lock.packages[''].devDependencies['@playwright/test'], manifest.devDependencies['@playwright/test']);
  assert.ok(lock.packages['node_modules/@playwright/test']);
});

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gateTestGroups } from "../scripts/run-gate-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every migrated Gate test file has one explicit execution class", () => {
  const discovered = readdirSync(path.join(root, "gate", "tests"))
    .filter((name) => /^test_.*\.py$/.test(name))
    .sort();
  const classified = Object.values(gateTestGroups).flat();

  assert.equal(new Set(classified).size, classified.length, "Gate tests must not appear in multiple groups");
  assert.deepEqual([...classified].sort(), discovered);
});

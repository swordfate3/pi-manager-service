import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedHubCliEnvironment } from "./helpers/hub-cli.ts";

test("Hub CLI helper confines HOME and both fallback config variables to its temporary root", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-manager-helper-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = isolatedHubCliEnvironment(directory);

  assert.equal(env.HOME, path.join(directory, "home"));
  assert.equal(env.PI_MANAGER_CONFIG, path.join(directory, "fallback", "manager.json"));
  assert.equal(env.PI_WEB_UI_HUB_CONFIG, path.join(directory, "fallback", "legacy-hub.json"));
  for (const value of [env.HOME, env.PI_MANAGER_CONFIG, env.PI_WEB_UI_HUB_CONFIG]) {
    assert.equal(path.relative(directory, value).startsWith(".."), false);
  }
});

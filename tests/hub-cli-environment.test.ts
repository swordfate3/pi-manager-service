import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedHubCliEnvironment } from "./helpers/hub-cli.ts";

test("isolated Hub CLI environment redirects HOME and both config fallbacks below the fixture root", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-cli-environment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const env = isolatedHubCliEnvironment(directory);
  for (const name of ["HOME", "PI_MANAGER_CONFIG", "PI_WEB_UI_HUB_CONFIG"] as const) {
    const value = env[name];
    assert.ok(value, `${name} must be set`);
    const relative = path.relative(directory, value);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${name} must stay in the fixture`);
  }
});

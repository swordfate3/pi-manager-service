import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { interactionSigning } from "../hub/interaction-signing.ts";
import { storageDiagnostics } from "../hub/state-budget.ts";
import { validateInteractionPin } from "../extensions/interactions/enrollment.ts";
import { createSessionRegistration } from "../extensions/session-registration.ts";

test("host enrollment pins only Hub public authority and charges its private key to bounded state", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "interaction-enrollment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "hub.json");
  initializeHub(configFile, { port: 0, management: { port: 0 } });
  const config = readHubConfig(configFile);
  const first = issueSession(config, path.join(dir, "one.json"), { label: "one" });
  const second = issueSession(config, path.join(dir, "two.json"), { label: "two" });
  const pin = validateInteractionPin(first.interactions);
  assert.ok(pin);
  assert.deepEqual(second.interactions, first.interactions);
  assert.ok(!JSON.stringify(first).includes("PRIVATE KEY"));
  assert.ok(readFileSync(path.join(config.stateDir, "interaction-signing.json"), "utf8").includes("PRIVATE KEY"));
  const signing = interactionSigning(config);
  assert.equal(signing.pin.issuer, pin.issuer);
  assert.ok(storageDiagnostics(config).logicalBytes < 8192);
  const registration = createSessionRegistration({ credentialFile: path.join(dir, "one.json"), socketPath: config.socketPath });
  assert.deepEqual(registration.interactionPin, pin);
});

test("old credential enrollment remains compatible and cannot fabricate a trusted approval key", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "interaction-old-enrollment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "hub.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  const credential = issueSession(config, path.join(dir, "old.json"), { label: "old" });
  assert.equal(credential.interactions, undefined);
  const registration = createSessionRegistration({ credentialFile: path.join(dir, "old.json"), socketPath: config.socketPath });
  assert.equal(registration.interactionPin, undefined);
  assert.equal(registration.interactionIdentity("runtime", "session"), null);
  assert.throws(() => validateInteractionPin({ protocol: "pi-web-interactions-v1", issuer: "token-key", publicKey: credential.token }));
});

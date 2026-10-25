import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const managerRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = process.env.PI_CONTRACT_WEB_DIR;
const modules = ["hub-generation.ts", "runtime-metadata.ts", "software-metadata.ts", "interactions/protocol.ts", "interactions/proof.ts"];

test("independent protocol copies accept explicit fixtures and cross-verify signed evidence", {
  skip: webRoot ? false : "Set PI_CONTRACT_WEB_DIR to a Web v1 source/package root; no sibling fallback is used",
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-protocol-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trees = [];
  for (const [label, source] of [["manager", path.join(managerRoot, "protocol")], ["web", path.join(path.resolve(webRoot), "extensions")]]) {
    const target = path.join(root, label);
    await mkdir(path.join(target, "interactions"), { recursive: true });
    await writeFile(path.join(target, "package.json"), '{"type":"module"}\n');
    for (const module of modules) await cp(path.join(source, module), path.join(target, module));
    const load = (module) => import(pathToFileURL(path.join(target, module)).href);
    trees.push({ label, generation: await load("hub-generation.ts"), runtime: await load("runtime-metadata.ts"), software: await load("software-metadata.ts"), protocol: await load("interactions/protocol.ts"), proof: await load("interactions/proof.ts") });
  }

  const legacy = "a".repeat(32);
  const bounded = `b2-${"a".repeat(32)}-${"b".repeat(16)}-${"c".repeat(32)}`;
  for (const tree of trees) {
    await t.test(`${tree.label}: generation and canonical serialization fixtures`, () => {
      assert.equal(tree.generation.BOUNDED_PROTOCOL, "bounded-v2");
      assert.equal(tree.protocol.INTERACTION_PROTOCOL, "pi-web-interactions-v1");
      for (const valid of [legacy, bounded]) {
        assert.equal(tree.generation.isHubGeneration(valid), true);
        assert.equal(tree.generation.isHubSessionPath(`/s/${valid}/`), true);
      }
      for (const invalid of [legacy.toUpperCase(), "../outside", "a".repeat(33), "", null]) {
        assert.equal(tree.generation.isHubGeneration(invalid), false);
      }
      assert.equal(tree.protocol.canonicalJson({ z: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"z":1}');
      assert.throws(() => tree.protocol.canonicalJson({ a: undefined }));
      assert.throws(() => tree.protocol.canonicalJson(JSON.parse('{"__proto__":{}}')));
    });
    await t.test(`${tree.label}: strict runtime/software registration fields`, () => {
      const runtime = { runtimeId: "fixture-runtime", sessionId: "fixture-session", leafId: null, version: "1.4.0", managed: true };
      assert.deepEqual(tree.runtime.readRuntimeMetadata(runtime), runtime);
      assert.throws(() => tree.runtime.readRuntimeMetadata({ ...runtime, managed: false }));
      assert.throws(() => tree.runtime.readRuntimeMetadata({ ...runtime, admin: true }));
      const software = { piVersion: "1.4.0", webUi: { version: "1.0.1", build: "d".repeat(64) } };
      assert.deepEqual(tree.software.readSoftwareMetadata(software), software);
      assert.throws(() => tree.software.readSoftwareMetadata({ ...software, admin: true }));
    });
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = { runId: "1".repeat(32), generation: bounded, runtimeId: "fixture-runtime", sessionId: "fixture-session" };
  const claim = { protocol: "pi-web-interactions-v1", audience: "pi-interaction-broker", kind: "control", identity, issuer: "contract-fixture", epoch: "2".repeat(32), challenge: "3".repeat(64), issuedAt: 1000, expiresAt: 2000, payload: { action: "read" } };
  const expected = { publicKey, issuer: claim.issuer, identity, challenge: claim.challenge, epoch: claim.epoch, kind: claim.kind, now: 1500 };
  for (const [sender, receiver] of [[trees[0], trees[1]], [trees[1], trees[0]]]) {
    await t.test(`${sender.label} to ${receiver.label}: real signatures, tampering, expiry and stale identity`, () => {
      const evidence = sender.proof.signInteractionEvidence(privateKey, claim);
      assert.deepEqual(receiver.proof.verifyInteractionEvidence(evidence, expected), claim);
      assert.throws(() => receiver.proof.verifyInteractionEvidence({ ...evidence, claim: { ...claim, payload: { action: "stop" } } }, expected));
      assert.throws(() => receiver.proof.verifyInteractionEvidence(evidence, { ...expected, now: 2000 }));
      assert.throws(() => receiver.proof.verifyInteractionEvidence(evidence, { ...expected, identity: { ...identity, sessionId: "stale-session" } }));
    });
  }
});

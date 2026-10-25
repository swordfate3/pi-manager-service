import assert from "node:assert/strict";
import test from "node:test";
import { GateLifecycle } from "../hub/lifecycle.ts";

test("lifecycle target projects only the bounded missing-evidence reason", async () => {
  const provider = new GateLifecycle({ endpoint: "http://127.0.0.1:16182", credentialFile: "/unused" });
  // Substitute HTTP only; exercise the actual public response projection.
  Object.defineProperty(provider, "request", {
    configurable: true,
    value: async () => ({ managed: false, reason: "source_evidence_unavailable", path: "/private" }),
  });
  assert.deepEqual(await provider.target("a".repeat(32)), {
    managed: false,
    reason: "source_evidence_unavailable",
  });
  Object.defineProperty(provider, "request", {
    value: async () => ({ managed: false, reason: "/private/arbitrary-upstream-detail" }),
  });
  assert.deepEqual(await provider.target("a".repeat(32)), { managed: false });
});

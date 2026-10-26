# Task4 native compatibility — implementation and verified acceptance

2026-10-26. Status: bounded source-side verifier implemented and actual authorized candidate acceptance/refusal verified. **Not whole-product completion or activation authorization. Public updates remains false.**

## Scoped commits / ownership

- `2f8f19cad89dcd3c4a93a542e6525b4d5ace9ab4`: native verifier, three small shipped resources, focused tests and opt-in actual test (six new files only).
- `6fa6484ce793af490c020b0d48ae7d07b0369fbd`: controller-prioritized, separate roundtrip cleanup P2 fix. Details and RED/GREEN are in sibling `task-4-native-version-roundtrip-report.md`.
- This report is a separate documentation handoff commit, so it can name the exact implementation commit above.

No edits to NativeBackend, runtime client, Web, engine, TaskStore, journal, existing Docker probe/provider/inputs, shared dependencies or existing dist. Controller's disjoint journal commit `4864a2b` and coordinator work are not claimed as this worker's work. Existing dirty changes preserved. No subagents, Docker calls, network egress, pushes, merges, publishing, deployment or production restarts.

## Fixed coordinator API (announced before implementation completion)

```ts
import {
  NativeCandidateCompatibility,
  type NativeCompatibilityOptions,
  type NativeCompatibilityRequest,
  type NativeCompatibilityProof,
} from './native-compatibility.ts';

const verifier = await NativeCandidateCompatibility.create({
  installer,                   // fixed CandidateInstaller; verify is local-FS-only
  root,                        // NEW nonexistent private evidence directory
  web: { root: webRoot, sha256: independentlyPinnedInventoryHash },
  captures: { root: fixedExistingPrivateCapturesRoot },
  trustedLocal: true,
});

const proof = await verifier.verify({
  candidateId, receiptHash,
  session: { reference, sha256, sessionId, leafId },
});
await verifier.revalidate(proof); // Promise<void>; mismatch/unknown throws
```

The request and nested session are copied/validated before the first await. Exact primitive identities and closed schemas are required; no live path, executable, argv, environment or snapshot-file injection. `session.reference` names one file under the fixed captures root.

`NativeCompatibilityProof` is a frozen object with an unexported TypeScript brand and runtime per-issuer WeakMap binding. Fabricated JSON, structured clones, cross-instance proofs and reconstruction/adoption are rejected. Immutable `proof.result` fields:

```ts
{
  candidateId, receiptHash,
  session: { reference, sha256, sessionId, leafId, dialogueSha256 },
  bindingSha256, evidenceKey, evidenceSha256,
  updates: false,
  activation: 'not-attempted',
}
```

`revalidate` checks issuer, current fixed source/host/Web identities, candidate receipt/tree/CLI/version/engine, capture bytes/session/leaf/dialogue and inode, private evidence/run-root identities, durable intent, output evidence, exact-child terminal record, SDK copy/output and copied execution resources. No approval, selection, live-lease renewal or stop authority is exposed. TaskStore remains the sole queue/approval authority; coordinator must separately retain and check all live leases/captures before stopping originals or selecting a candidate.

Unknown spawn/exit/cleanup/persistence outcomes retain admission and throw `native-outcome-unknown`; subsequent verification refuses with `reconciliation-required`. Known failure can release admission only after exact owned cleanup. Revocation failure remains unknown even after the owned map is empty; failed stop is not retried. No automatic pruning, replay, reopening/adoption or signaling of unknown PIDs.

## Host / behavior / restore boundary

- Construction fixes actual `process.execPath`, `/proc/self/exe` agreement, executable SHA-256/inode/device, Node version/ABI/platform/architecture and fixed shipped source identities. Only Linux x64 is supported. Receipt installation Node is **not** treated as host execution evidence.
- Selected Pi catalog version is not restricted to a 1.1/1.4 allowlist. The verified receipt, actual package manifest/version/engine, fixed CLI relative path and bin hash must agree; the declared Node engine must support the actual host.
- First child executes the actual selected candidate CLI through NativeBackend's shipped guard. It proves readiness, settled synthetic generation, busy refusal, private prepare/input fence, wrong-cancel refusal, exact cancel and generation after release.
- Important actual finding: official 1.4 CLI `--session` uses the saved header's cwd. Using that path in a private preflight would cross the workspace boundary; changing the header would invalidate the evidence. Therefore saved-data restore uses the brief-authorized **26-line fixed SDK/RPC host**, the selected candidate's supported `SessionManager.open(file, sessions, privateCwd)` override and actual `createAgentSessionRuntime`/`runRpcMode`, through NativeBackend's same private guard and successor-admission protocol. The captured header/model metadata/leaf/raw bytes remain unchanged. No candidate imports execute in the parent verifier.
- The fixed provider registers the validated saved provider/model namespace with synthetic responses; no credentials or live model calls are used. Multiple model namespaces/unsupported profiles refuse conservatively.
- Actual restored Web full history and independent candidate SDK read must match the executor's independently parsed ordered Unicode user/assistant dialogue exactly. Session/leaf and raw-copy hashes must match. No partial/truncated history or silently migrated data can produce proof. Restored Web prompt and model mutation are actually refused under the private gate; generation works after admission/cancel/release.
- Same-UID execution is explicitly **trusted-local**, not hostile-agent, OS or network isolation. `--offline` is not claimed to be a network jail. Administrator checkout sources can be group-writable (existing checkout is 0664); bytes are pinned without changing shared file permissions.

## Deep evidence roots and bounded private execution

Evidence remains beneath the caller's requested root, including deep operation-ID nesting. Each admitted attempt allocates a new canonical 0700 `/tmp/ncv-run-*` directory. Its path and inode/device identity are durably recorded in intent **before spawn** and bound into proof evidence. All workspace/state/agent/registrar/socket paths live there; SDK HOME/config/cache/tmp are new private directories as well.

Final actual control socket was `/tmp/ncv-run-z47eX0/state/probe-a21tWU/run/control.sock` (55 bytes) in the preceding green run. The final run below independently asserts ≤100 bytes. No Unix socket/RuntimeClient limits were weakened. This replaces the earlier checkpoint's short evidence-root restriction: deeply nested evidence roots are supported.

Per-verifier exclusive writer, at most eight retained attempts, no identical-attempt replay, bounded session/profile inventories, SDK output, HTTP/WebSocket payloads, history entries/pages and timeouts. These are logical verifier bounds, not an OS quota against malicious same-UID candidate code. Evidence and run roots are intentionally retained, including failure/unknown cases; trusted explicit cleanup/reconciliation is outside this task.

## TDD and verification

All commands below run from `/home/fate/gitproject/codex_project_v2/pi-manager-service`.

RED evidence:

- Initial focused tests: 5 failed on missing verifier assertion; initial opt-in actual test: 1 failed on missing verifier assertion.
- Actual Web-fence observation and raw SDK-output tamper regressions: both failed before the corresponding evidence binding was added (`undefined` observation and missing expected rejection), then both passed.
- Deep coordinator evidence-root regression failed with `root-too-long`, then passed after separate durable-bound short run roots were implemented.
- Roundtrip P2 actual-child revocation failure: separate report documents 2 failed / 1 passed → 3 passed.

Final scoped regression command:

```sh
node --import ./tests/register-ts.mjs --test tests/manager-native-compatibility.test.ts tests/native-stop-evidence.test.ts tests/native-backend.test.ts tests/native-runtime.test.ts tests/manager-compatibility-inputs.test.ts tests/manager-session-capture.test.ts
```

**87 passed, 0 failed, 0 skipped** (8.3 s). Includes 12 focused verifier tests: closed requests/profiles, nonprimitive identities, long roots, unsupported host, receipt/Web/capture/engine rejection, pre-await request copying, unsafe captures, owned-child behavior/refusal, revoke/persistence unknown retention, version/tree mutation, copied-distribution shipped-source tamper, writer exclusion/quota/no replay.

Final actual command:

```sh
PI_MANAGER_TEST_WEB_ROOT=/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals PI_MANAGER_TEST_CANDIDATE_ROOT=/tmp/manager-candidate-official-SPwX0o/candidates PI_MANAGER_TEST_RECEIPT_SHA256=f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3 node --import ./tests/register-ts.mjs integration-tests/native-candidate-compatibility.test.ts
```

**4 passed, 0 failed, 0 skipped** (89.95 s): main actual test plus Web-fence, raw SDK-evidence tamper, and deliberately truncated received-history refusal subtests. The truncation fault is test-only interception of a real Web reply, never a fabricated positive acceptance. Original synthetic 1.1 consumer stayed alive throughout verification/refusal and could generate afterward; original/captured bytes were unchanged. Only its test after-hook eventually stopped it.

The execution sandbox suppressed child stdout even for a trivial spawned `console.log`; existing native tests showed the same effect. Narrow temporary-local-test escalations were used for real child/IPC runs, as authorized. No network egress or Docker was needed. `npm pack --ignore-scripts --offline` uses only a new private HOME/cache/destination and selected input checkout; peer links exist only in new test/execution profiles. Original Web/candidate trees were never written.

Additional checks:

- `npm run typecheck`: final exit 0 (earlier controller/verifier WIP failures were not counted as passing).
- Scoped TSC: exit 0 using `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --skipLibCheck --strict --ignoreDeprecations 6.0 tests/manager-native-compatibility.test.ts integration-tests/native-candidate-compatibility.test.ts`.
- `git diff --check` and staged diff check: passed.
- Read-only `createSourceInventory()` verification includes all four new shipped source/resource files automatically. No build wiring edits needed; no rebuilding or rewriting pre-existing dirty dist.

## Exact actual inputs and final retained evidence

- Candidate: `c-e302720684b002296b28295be46b483bf2ec8a1fa9e0d08850056e66e92abe2e`, receipt `f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3`, version **1.4.0**.
- Receipt installation Node: **v24.21.0**; actual proof host: **v22.19.0 / ABI127 / Linux x64**.
- Host executable: `/home/fate/.nvm/versions/node/v22.19.0/bin/node`, SHA-256 `596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9`.
- Selected Web checkout HEAD verified `3db16cdc1b557513b8837ac8a8f0196830ffb6a8`.
- Independent unpacked Web inventory `adf9d0203a16bc9fb61b273036d3b4c5147d1203186ea0d18bb093b4d0c24a01`; build-source inventory `2533ce8c95565919478abaeccfefb6998a3c0f59554c928c1a623b0be60fc40c`; outputs inventory `24bd40a14f625cfdaa75eeffbb8358ef7681b90c687678b55cedb84d9378a214`.
- Final test resource root: `/tmp/ncv-real-7ujM17`.
- Final evidence directory: `/tmp/ncv-real-7ujM17/ledger/operations/9999999999999999999999999999999999999999999999999999999999999999/native-preflight/proof/v-a3736ee6a9c3a50a607742747b1c47ffe03654ac05fa92fbb7e25e33051b6eb5`.
- Binding SHA-256: `a3736ee6a9c3a50a607742747b1c47ffe03654ac05fa92fbb7e25e33051b6eb5`.
- Evidence SHA-256: `6097b4226123801c361f49f5d694c994f403d8dded44153a91162a77a416d64d`.
- Capture SHA-256: `b33682842bc7c6fa2a75982982da4f8f1b303e07267ce3d8a0e4c7f131fb3455`; session `01a17878-f418-73f4-a9c5-0d75dbf3bc18`; leaf `178e16d7`.
- Independently expected and restored SDK/Web dialogue SHA-256: `722bba3f4ce8be7d450a3b223aa15cd3b0e33feecb77c7a692f54709646611b7`.

Final test restores deliberately tampered evidence/capture bytes and calls `revalidate` again before completion. Persisted files are audit material only: **do not adopt them as an activation proof in a new verifier process**.

## Remaining integration concerns

1. Coordinator must use the same verifier instance for proof revalidation and retain separate approval, lease/deadline, capture and original-generation checks. Expensive receipt/tree rechecks consume real lease time; the verifier never renews a live lease.
2. Saved-data proof uses supported SDK private-cwd restore plus actual CLI behavior, not CLI restoration inside a live/original workspace. Production activation still needs its own exact NativeBackend successor and admission checks.
3. Conservative support: Linux x64, linear v3 text session profile, one validated provider/model namespace; unsupported engine grammar, migrations/tools/branches/multiple namespaces refuse rather than being normalized.
4. No distributed hostile-UID/network security claims; retained temporary/evidence resources need explicit trusted lifecycle management. Unknown outcomes block further admission without replay or cleanup guesses.
5. No full-product build/release or controller coordinator acceptance is claimed by this report. Source inventory includes resources; dirty distribution rebuild and independent review/integration remain controller-owned.

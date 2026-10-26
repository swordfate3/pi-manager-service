# Task4 native version roundtrip — bounded P2 cleanup fix

2026-10-26. Scope: test-only follow-up to `2a9a347`; no NativeBackend, journal, engine, production or shared dependency changes. Native compatibility verifier work was checkpointed and paused first.

## Finding and fix

Confirmed `NativeBackend.#finish` can remove the child from its owned map after grant revocation fails; the awaiting `stop` then throws `ExecutionOutcomeUnknownError`. The old after-hook-local failure variable could not remember a cutover stop failure and would delete the root when `list()` was empty.

Introduced test-only `NativeStopEvidence`, shared by every explicit cutover and teardown stop boundary. It retains the first failure/cause for the test lifetime, remembers uncertain backend/instance stops to prohibit automatic retry, still attempts cleanup of other owned children, and never deletes the private root after any uncertain stop. The cleanup error reports the retained path and original cause. Production code is unchanged.

Regression uses real disposable RPC child processes and a genuine private Hub `.writer.lock` revocation failure, not a mocked stop result. It proves stop rejection, actual child exit, empty owned map, root/audit preservation, original uncertainty reporting, and one stop call despite repeated cleanup/stop requests. Explicit fixture disposal happens only after these assertions; this is not recovery/adoption of an unknown child.

## RED / GREEN and commands

All commands run from `/home/fate/gitproject/codex_project_v2/pi-manager-service`.

1. `node --import ./tests/register-ts.mjs tests/native-stop-evidence.test.ts`
   - Sandbox run could not deliver spawned-child stdout; the same issue reproduced in existing native-backend tests and a trivial spawned `console.log`.
   - Narrow local-test escalation used (no network egress/Docker/production).
   - RED against extracted old cleanup behavior: 2 failed, 1 passed. Cutover cleanup incorrectly resolved; repeated teardown cleanup also lost uncertainty.
   - GREEN after sentinel: 3 passed, 0 failed, 0 skipped. Actual child exits + revocation failures covered at both boundaries.
2. `PI_MANAGER_TEST_WEB_ROOT=/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals PI_MANAGER_TEST_CANDIDATE_ROOT=/tmp/manager-candidate-official-SPwX0o/candidates PI_MANAGER_TEST_RECEIPT_SHA256=f961b8976fc3d5316d3c8f65fdfb895260a0a34fea387c2d64088d9aade777e3 node --import ./tests/register-ts.mjs integration-tests/native-version-roundtrip.test.ts`
   - Actual authorized roundtrip rerun passed: 1 passed, 0 failed, 0 skipped; 23.7 s.
   - Host Node v22.19.0 / ABI127 / Linux x64; actual versions 1.1.0 → official 1.4.0 → 1.1.0. Public updates false.
   - Candidate read-only; independently packed Web `--ignore-scripts --offline`; only new private /tmp resources, loopback IPC, and exact owned children used.
3. `git diff --check`: passed.
4. Full `npm run typecheck` was attempted but is not claimed passing: paused uncommitted verifier draft has ES2022 `findLast` and callback return-type errors. These are outside this independent test-fix commit and will be corrected when verifier work resumes.
5. Targeted fix-scope typecheck passed: `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --skipLibCheck --strict --ignoreDeprecations 6.0 tests/native-stop-evidence.test.ts integration-tests/native-version-roundtrip.test.ts`.

Commit scope: this report, `integration-tests/native-version-roundtrip.test.ts`, new `integration-tests/fixtures/native-stop-evidence.ts`, and new `tests/native-stop-evidence.test.ts`. No pushes/merge/deployment. Whole product is not complete.

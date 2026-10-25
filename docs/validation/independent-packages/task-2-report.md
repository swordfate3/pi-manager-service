# Task 2 report: clean Web v1 package extraction

Date: 2026-10-26

Status: Complete. Web implementation, local verification, and the controller-owned bounded cross-project acceptance are recorded below. Web commit: `eef18b555dbe99f31de9408299751af221daab7b` (`refactor: extract manager from web package`).

## Manager companion corrections

The authoritative migration inventory now contains 255 source-to-target entries plus 4 explicit dispositions. No Manager product implementation was changed.

### Omitted interaction-page coverage

- Immutable source: `27326a8cbea8331cac29e6b6b41f98f2b69fa05b:tests/interaction-page.test.ts`
- Source SHA-256: `6c4fe1a80f097803a7240211032ff2fb2e0dbbd830eff477f82354b8b98483c8`
- Target: `pi-manager/tests/interaction-page.test.ts`
- Target SHA-256: `b65f206f5f2b0c15a150af7ca744b3bd52bb6461f830b2fa8fccb0a243fcd295`
- Adaptation: only the Web protocol import was changed from `../extensions/interactions/protocol.ts` to the package-owned `../protocol/interactions/protocol.ts`; assertions and real module import were retained.
- Commit: `d9f98ec test: migrate manager interaction page coverage`
- Manager typecheck: pass.
- Focused test: 41 tests, 40 passed, 0 failed, 1 original opt-in Chromium skip. The initial restricted run produced 40 `listen EPERM 127.0.0.1` failures and the same one skip; the approved isolated loopback run was green.

### Migrated Gate fixture roots

Controller RED evidence in `.tmp/validation/socket-files/` showed:

- `hub-gate-live.test.ts`: 1 failed because `tests/fixtures/hub-gate-management.py` still selected `integrations/runtime-updater/gate`, causing `ModuleNotFoundError: test_hub_management`.
- `hub-launch-live.test.ts`: 1 failed because `tests/fixtures/hub-gate-launches.py` still selected `integrations/runtime-updater/gate`, causing `ModuleNotFoundError: gate`.

The only fixture edits changed `parents[2] / 'integrations/runtime-updater/gate'` to `parents[2] / 'gate'`. Inventory source hashes remain immutable; target hashes are now:

- `tests/fixtures/hub-gate-launches.py`: `7589910541485df732659e1b0db9fc4aacec9008538f2e0925edb939c67d5554`
- `tests/fixtures/hub-gate-management.py`: `5d809569bb08b4ad40e5ebd4fce6612b2205d94ef623ee872225cf70228cb053`

Focused isolated socket verification used fresh temporary `HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG` paths and disposable loopback listeners. No Docker CLI was invoked:

- `tests/socket/hub-gate-live.test.ts`: 1 test, 1 passed, 0 failed, 0 skipped.
- `tests/socket/hub-launch-live.test.ts`: 1 test, 1 passed, 0 failed, 0 skipped.

Commit: `45b139c test: fix migrated gate fixture roots`.

The controller separately confirmed the 2,000-rotation stress case also cancels at 60 seconds on immutable source snapshot `27326a8`; it is baseline behavior, was not rerun here, and is outside this bounded correction.

## Primary Web cleanup

### Outcome

The literal Web branch `v1` was cleaned from baseline `74021fc9ffbb35ee631f99ae09ef7adcf23748b7` into a session-only Web distribution:

- The package retains `extensions/mirror-server.ts`, the `./interactions/v1` export, optional registration/control adapters, remote-access helpers, session interaction security checks, and the existing frontend/session logic.
- The package no longer declares a bin, builds a Hub bundle, or ships `bin/`, `hub/`, `dist/hub/`, or `integrations/runtime-updater/`.
- `PI_E2E_RUNTIME_DIR` continues to select the Web runtime. Manager-backed integration accepts only an explicit `PI_E2E_MANAGER_DIR` pointing to a separately built Manager root. There is no sibling checkout or Web-root fallback and no Manager source import.
- Both the Manager CLI harness and Pi child harness redirect `HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG` under their own temporary roots.
- Manager-only Node and browser cases expose actionable skips when no Manager is configured; direct single-session rows remain selected.
- Package scripts, lock metadata, build/dist verification, install lifecycle, type coverage, CI messaging, README, unit-test documentation, development log, and the approved split-design status were updated.

The Web cleanup was committed on branch `v1` as `eef18b555dbe99f31de9408299751af221daab7b` (`refactor: extract manager from web package`): 194 changed paths, comprising 25 modified files and 169 tracked deletions. After the commit, the only Web status entry is the preserved user-owned untracked `.learnings/` directory.

No Web frontend/session implementation was rewritten. No production service, Docker resource, real credential, actual Pi setting, main branch, remote branch, or deployment was changed. The user-owned untracked `.learnings/` directory was preserved.

### Distribution TDD

Exact required regression RED before implementation:

```text
node tests/web-dist.test.mjs
Web-only source and package verify without Manager sources or executable
error: Required directory is missing: hub
```

Focused GREEN after changing the fixed Web source/output policy:

```text
node --test-name-pattern='Web-only source and package' tests/web-dist.test.mjs
# tests 1
# pass 1
# fail 0
```

Final full distribution file:

```text
node tests/web-dist.test.mjs
# tests 49
# pass 49
# fail 0
# skipped 0
```

The final regression uses real offline `npm pack --dry-run --json`, requires the Web extension, and rejects the Manager executable/source/build paths.

### Tracked removal accounting

The corrected Manager inventory contains 255 entries and 4 dispositions. A final read-only ledger check compared every staged Web deletion to that inventory and compared every original `HEAD` blob SHA-256 to the inventory source hash:

```json
{
  "deleted": 168,
  "byTop": {
    "bin": 1,
    "e2e": 14,
    "hub": 24,
    "integrations": 94,
    "tests": 34,
    "vite.hub.config.ts": 1
  },
  "missing": [],
  "hashMismatches": []
}
```

The Manager-owned `tests/interaction-page.test.ts` omission was corrected through companion commit `d9f98ec` before its Web copy was removed. Mixed tests and legacy integration fixtures remain represented by their Manager inventory targets/archive; no default Web test dynamically imports Manager sources.

The ledger above accounts for 168 Manager-inventory-owned source/build/test removals. The Web rebuild also removed the previously tracked generated bundle `dist/hub/pi-web-hub.mjs`, which is output rather than an inventory source entry. The final Web commit therefore contains 169 tracked deletions in total: 168 inventory-accounted files plus 1 generated distribution artifact.

Exact tracked deletion list:

- `bin/pi-web-hub.mjs`
- `e2e/fixtures/runtime-update-provider.ts`
- `e2e/fixtures/stdin-guard-probe.ts`
- `e2e/harness/Dockerfile.managed-runtime`
- `e2e/harness/browser-managed-restart.ts`
- `e2e/harness/browser-runtime-version-picker.ts`
- `e2e/harness/hostile-management.ts`
- `e2e/harness/test-managed-gate.py`
- `e2e/harness/test-managed-runtime.py`
- `e2e/harness/test-stdin-guard-tui.py`
- `e2e/harness/visual-bounded-hub-state.ts`
- `e2e/harness/visual-managed-restart.ts`
- `e2e/hub-approvals.visual.ts`
- `e2e/hub-launches.visual.ts`
- `e2e/web-interactions.browser.ts`
- `hub/approvals-portal.ts`
- `hub/asset-transfer.ts`
- `hub/bounded-registry.ts`
- `hub/config.ts`
- `hub/forward-queue.ts`
- `hub/gate-management.ts`
- `hub/gateway-auth.ts`
- `hub/interaction-control.ts`
- `hub/interaction-page.ts`
- `hub/interaction-signing.ts`
- `hub/interactions.ts`
- `hub/launch-portal.ts`
- `hub/lifecycle.ts`
- `hub/limits.ts`
- `hub/management.ts`
- `hub/package.json`
- `hub/pi-launches.ts`
- `hub/portal.ts`
- `hub/restart-api.ts`
- `hub/runtime-portal.ts`
- `hub/runtime-updates.ts`
- `hub/server.ts`
- `hub/state-budget.ts`
- `hub/version-status.ts`
- `integrations/runtime-updater/README.md`
- `integrations/runtime-updater/gate/gate/__init__.py`
- `integrations/runtime-updater/gate/gate/admin.py`
- `integrations/runtime-updater/gate/gate/artifacts.py`
- `integrations/runtime-updater/gate/gate/client.py`
- `integrations/runtime-updater/gate/gate/deploy.py`
- `integrations/runtime-updater/gate/gate/engine.py`
- `integrations/runtime-updater/gate/gate/errors.py`
- `integrations/runtime-updater/gate/gate/hostseal.py`
- `integrations/runtime-updater/gate/gate/hub_management.py`
- `integrations/runtime-updater/gate/gate/image_deploy.py`
- `integrations/runtime-updater/gate/gate/lifecycle.py`
- `integrations/runtime-updater/gate/gate/lifecycle_contract.py`
- `integrations/runtime-updater/gate/gate/pi_launch_engine.py`
- `integrations/runtime-updater/gate/gate/pi_launches.py`
- `integrations/runtime-updater/gate/gate/registry.py`
- `integrations/runtime-updater/gate/gate/router.py`
- `integrations/runtime-updater/gate/gate/runtime_catalog.py`
- `integrations/runtime-updater/gate/gate/runtime_engine.py`
- `integrations/runtime-updater/gate/gate/runtime_install.py`
- `integrations/runtime-updater/gate/gate/runtime_restore.py`
- `integrations/runtime-updater/gate/gate/runtime_updates.py`
- `integrations/runtime-updater/gate/gate/service.py`
- `integrations/runtime-updater/gate/gate/sources.py`
- `integrations/runtime-updater/gate/gate/store.py`
- `integrations/runtime-updater/gate/gate/terminal_contract.py`
- `integrations/runtime-updater/gate/gate/terminal_provider.py`
- `integrations/runtime-updater/gate/gatectl`
- `integrations/runtime-updater/gate/tests/test_gate.py`
- `integrations/runtime-updater/gate/tests/test_hub_management.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle_round1.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle_round2.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle_round3.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle_source_evidence.py`
- `integrations/runtime-updater/gate/tests/test_multiservice.py`
- `integrations/runtime-updater/gate/tests/test_pi_launch_engine.py`
- `integrations/runtime-updater/gate/tests/test_pi_launches.py`
- `integrations/runtime-updater/gate/tests/test_registry.py`
- `integrations/runtime-updater/gate/tests/test_runtime_catalog.py`
- `integrations/runtime-updater/gate/tests/test_runtime_clients.py`
- `integrations/runtime-updater/gate/tests/test_runtime_discovery_http.py`
- `integrations/runtime-updater/gate/tests/test_runtime_engine.py`
- `integrations/runtime-updater/gate/tests/test_runtime_exit_confirmation.py`
- `integrations/runtime-updater/gate/tests/test_runtime_http.py`
- `integrations/runtime-updater/gate/tests/test_runtime_inspect_transport.py`
- `integrations/runtime-updater/gate/tests/test_runtime_install.py`
- `integrations/runtime-updater/gate/tests/test_runtime_installed_version.py`
- `integrations/runtime-updater/gate/tests/test_runtime_inventory_obligations.py`
- `integrations/runtime-updater/gate/tests/test_runtime_inventory_retry.py`
- `integrations/runtime-updater/gate/tests/test_runtime_namespace.py`
- `integrations/runtime-updater/gate/tests/test_runtime_npm_origin.py`
- `integrations/runtime-updater/gate/tests/test_runtime_npm_transport.py`
- `integrations/runtime-updater/gate/tests/test_runtime_poll_reconciliation.py`
- `integrations/runtime-updater/gate/tests/test_runtime_probe_launcher.py`
- `integrations/runtime-updater/gate/tests/test_runtime_regressions.py`
- `integrations/runtime-updater/gate/tests/test_runtime_restore_contract.py`
- `integrations/runtime-updater/gate/tests/test_runtime_restore_control.py`
- `integrations/runtime-updater/gate/tests/test_runtime_restore_recovery.py`
- `integrations/runtime-updater/gate/tests/test_runtime_restore_upload.py`
- `integrations/runtime-updater/gate/tests/test_runtime_restore_validation.py`
- `integrations/runtime-updater/gate/tests/test_runtime_security.py`
- `integrations/runtime-updater/gate/tests/test_runtime_session_capture.py`
- `integrations/runtime-updater/gate/tests/test_runtime_source_identity.py`
- `integrations/runtime-updater/gate/tests/test_runtime_source_validation.py`
- `integrations/runtime-updater/gate/tests/test_runtime_supervisor_fences.py`
- `integrations/runtime-updater/gate/tests/test_runtime_updates.py`
- `integrations/runtime-updater/gate/tests/test_runtime_validation_flow.py`
- `integrations/runtime-updater/gate/tests/test_runtime_versions.py`
- `integrations/runtime-updater/pi-runtime/pi-session-control`
- `integrations/runtime-updater/pi-runtime/pi_launch_policy.py`
- `integrations/runtime-updater/pi-runtime/pi_model_sync.py`
- `integrations/runtime-updater/pi-runtime/pi_stdin_guard.mjs`
- `integrations/runtime-updater/pi-runtime/pi_supervisor.py`
- `integrations/runtime-updater/pi-runtime/runtime_identity.py`
- `integrations/runtime-updater/pi-runtime/runtime_probe.py`
- `integrations/runtime-updater/pi-runtime/runtime_probe_provider.ts`
- `integrations/runtime-updater/pi-runtime/runtime_probe_ws.mjs`
- `integrations/runtime-updater/pi-runtime/runtime_session.py`
- `integrations/runtime-updater/pi-runtime/tests/test_runtime_probe.py`
- `integrations/runtime-updater/pi-runtime/tests/test_runtime_probe_driver.py`
- `integrations/runtime-updater/pi-runtime/tests/test_runtime_probe_real.py`
- `integrations/runtime-updater/pi-runtime/tests/test_runtime_probe_regressions.py`
- `integrations/runtime-updater/provenance.json`
- `integrations/runtime-updater/tests/Dockerfile.acceptance`
- `integrations/runtime-updater/tests/Dockerfile.acceptance.dockerignore`
- `integrations/runtime-updater/tests/candidate_acceptance.py`
- `integrations/runtime-updater/tests/probe_acceptance.py`
- `integrations/runtime-updater/tests/real_launch_acceptance.py`
- `integrations/runtime-updater/tests/real_version_acceptance.py`
- `integrations/runtime-updater/tests/runtime_test_bootstrap.py`
- `integrations/runtime-updater/tests/test_real_launch_acceptance.py`
- `integrations/runtime-updater/tests/test_real_version_acceptance_contract.py`
- `integrations/runtime-updater/tests/test_runtime_test_bootstrap.py`
- `tests/fixtures/hub-gate-launches.py`
- `tests/fixtures/hub-gate-management.py`
- `tests/hub-approvals-portal.test.ts`
- `tests/hub-bounded-registry.test.ts`
- `tests/hub-cli.test.ts`
- `tests/hub-forward-queue.test.ts`
- `tests/hub-gate-live.test.ts`
- `tests/hub-gate-management.test.ts`
- `tests/hub-gateway-login.test.ts`
- `tests/hub-interactions.test.ts`
- `tests/hub-launch-live.test.ts`
- `tests/hub-launch-portal.test.ts`
- `tests/hub-launches.test.ts`
- `tests/hub-lifecycle-evidence.test.ts`
- `tests/hub-lifecycle.test.ts`
- `tests/hub-management-origin.test.ts`
- `tests/hub-management.test.ts`
- `tests/hub-portal-management.test.ts`
- `tests/hub-restart-api.test.ts`
- `tests/hub-runtime-api.test.ts`
- `tests/hub-runtime-portal.test.ts`
- `tests/hub-state-budget.test.ts`
- `tests/hub-transfer.test.ts`
- `tests/hub-versions-portal.test.ts`
- `tests/interaction-control.test.ts`
- `tests/interaction-enrollment.test.ts`
- `tests/interaction-page.test.ts`
- `tests/pi-client-managed-restart.test.ts`
- `tests/runtime-control.test.ts`
- `tests/runtime-guard-process.test.ts`
- `tests/session-hub.test.ts`
- `tests/version-status.test.ts`
- `tests/web-interactions-integration.test.ts`
- `tests/web-interactions-lifecycle.test.ts`
- `vite.hub.config.ts`

### Web build, type, unit, install, and package evidence

- Lock metadata was regenerated offline with `npm install --package-lock-only --ignore-scripts --offline --legacy-peer-deps`; the root lock entry has no `bin`.
- `npm run build:web && npm run verify:dist`: pass. Vite transformed 5,698 modules; `dist/build-manifest.json` was rewritten with the Web-only policy; `dist/hub/` is absent; final verification reports source/output hash consistency.
- `npx tsc --noEmit`: pass.
- `npx tsc --noEmit -p tsconfig.connection.json`: pass.
- Immediately before the Web commit, fresh bounded completion checks passed again: `npm run verify:dist` exit 0, both TypeScript checks exit 0, `git diff --cached --check` clean, package and lock root `bin` absent, `./interactions/v1` and `extensions/mirror-server.ts` retained, and the staged index contained no tracked `bin/`, `hub/`, `integrations/runtime-updater/`, `dist/hub/`, `vite.hub.config.ts`, or `tests/interaction-page.test.ts` paths.
- Scoped Biome check of changed code/config files: 14 files checked, no fixes or diagnostics.
- Focused Git-install/package regression initially failed 2/2 against the intentionally stale pre-split manifest (`bin/pi-web-hub.mjs` outside the new fixed policy). After the required Web rebuild, `node tests/git-install-lifecycle.test.mjs`: 2 tests, 2 passed, 0 failed, 0 skipped.
- One broad Web unit run, with isolated state and listener permission: 54 files, 444 tests, 443 passed, 0 failed, 0 cancelled, 1 skipped. The only skip is the existing opt-in physical 1 GiB filesystem test.
- Manager-absent focused integration reporting, run directly so the inner result is visible: 1 test, 0 passed, 0 failed, 1 skipped with the actionable `PI_E2E_MANAGER_DIR` reason.
- Isolated production-only Git install was first attempted offline. It stopped before assertions because the existing npm cache lacked the lockfile-declared `ws@8.22.0` tarball (`ENOTCACHED`). A narrowly approved declared-dependency retry then passed: Git install, Git update, dist integrity, stale-file removal, eight source-mutation installation rejections, tarball install, Manager-artifact absence, one production dependency (`ws`), two tarball-consumer packages (root package plus `ws`), and no lock rewrite.
- Standalone pack probe first encountered an inherited read-only npm cache path (`EROFS`), not a package failure. With a fresh temporary cache, `npm pack --dry-run --ignore-scripts --json` passed: 781 files, package size 5,810,179 bytes, unpacked size 26,797,987 bytes; required Web extension/protocol/dist files present; forbidden Manager paths empty.

### Unrun or externally owned checks

- No full real-Pi backend aggregate, complete Playwright browser suite, real phone, production Manager, Docker, Gate, runtime updater, deployment, or production service validation was run in this task.
- Controller-owned isolated cross-project acceptance completed with exit 0; this task did not rerun it:
  - Explicit independent Manager, `session-hub.integration.ts`: 1 test, 1 passed, 0 failed, 0 skipped. Two real Pi processes registered; one exit left the other reachable; Manager restart fenced old links; renewal and revoke passed; Manager and Web identities matched their independent manifests. Log: `.tmp/validation/cross-project/independent-manager-session.log`.
  - No Manager, `file-download.integration.ts`: 2 tests, 1 direct test passed, 0 failed, 1 Hub row visibly skipped with the actionable `PI_E2E_MANAGER_DIR` reason. Log: `.tmp/validation/cross-project/web-alone-download.log`.
- The Manager 2,000-rotation stress test was not rerun. Controller established the same 60-second cancellation on immutable source `27326a8` (7 passed, 1 cancelled, 62.73 seconds), so it is recorded as baseline rather than an extraction regression.
- Manager build/dist was not rerun after the companion commits. A controller check found current Manager `verify:dist` drift only because the two focused Python fixture runs emitted 18 ignored `gate/gate/__pycache__/*.pyc` files that the source walker sees. No shipped Manager source/runtime changed; this task did not delete those untracked caches, rebuild Manager to include them, or claim a hidden pass.
- Historical validation documents and `docs/hub.md` remain as provenance/history and were not treated as current Web package contents.


# Task 1 final report — independent Manager distribution extraction

Date: 2026-10-26

Branch: `codex/bootstrap`
Status: **DONE_WITH_CONCERNS — bounded extraction and final package checks completed; explicit acceptance limits remain below**

## Scope and source boundary

- Target repository: `/home/fate/gitproject/codex_project_v2/pi-manager`
- Immutable read-only source checkout: `/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals`
- Source commit: `27326a8cbea8331cac29e6b6b41f98f2b69fa05b`
- Tracked source archive used for migration: `/tmp/pi-manager-source.CvRy2I`
- No source Web working-tree files were modified.
- No production Docker, service, credential contents, or application service was used. One test-safety defect caused the initial RED command to create a 16-byte host config sentinel; the exact incident and evidence are recorded below. The file was not read, modified, or removed afterward.
- No native lifecycle or MCP feature was added.
- No push or publish was performed.
- The local task commit is created after the final staged review; its hash is reported in the controller handoff rather than embedded into the commit that determines that hash.

Controller-owned files intentionally excluded from this task and from any future task commit:

- `docs/research/`
- `docs/validation/2026-10-26-independent-packages.md`
- `docs/superpowers/plans/2026-10-26-independent-packages.md`
- `docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md`

## Current implementation

The working tree contains the extracted independently buildable package structure:

- package/build: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`
- Manager CLI and Hub: `bin/`, `hub/`
- Manager-owned protocol closure: `protocol/`
- Gate and runtime sources/tests: `gate/`, `runtime/`
- distribution tooling: `scripts/manager-dist.mjs`
- explicit Gate test classification: `scripts/run-gate-tests.mjs`
- Manager tests: `tests/`
- preserved mixed/hybrid coverage: `integration-tests/legacy-web/`
- preserved runtime-updater acceptance fixtures: `integration-tests/runtime-updater/`
- package docs/provenance: `README.md`, `docs/source-provenance.md`
- migration inventory: `docs/migration-inventory.json`
- built output from the last successful build: `dist/`

Package metadata currently declares:

- name `@swordfate/pi-manager`
- version `0.1.0`
- `private: true`
- bin `pi-manager -> dist/hub/pi-web-hub.mjs`
- production dependency only `ws`
- Node `>=22.19.0`
- no `pi.extensions`

The development-only `node_modules` symlink points to the source checkout's installed dependencies. `.gitignore` contains both `node_modules/` and bare `node_modules`; it is not intended for the index or package.

## Functional extraction adaptations

1. Protocol imports were redirected from Web-owned `extensions/...` paths to Manager-owned `protocol/...` paths.
2. Manager package/version identity is separate from `@kkkiio/pi-web-ui`.
3. Default version status performs no network request and reports the Manager release source unavailable until explicitly injected/configured. The old `swordfate3/pi-web-ui` release source is not presented as a Manager release source.
4. Portal version text uses Manager identity and does not compare Manager builds to Web extension releases.
5. CLI default configuration is now `~/.config/pi-manager/config.json` and environment selection is `PI_MANAGER_CONFIG`.
6. `PI_WEB_UI_HUB_CONFIG` and `~/.pi/web-hub/config.json` are ignored by default. Intentional transition remains possible only through explicit `--config`.
7. Gate runtime source paths were adapted from the old monorepo `pi-runtime/` path to package-owned `runtime/`.
8. Legacy Gate/Web source identity is deliberately unconfigured by default. `RuntimeEngine.profile()` requires explicit `PI_MANAGER_LEGACY_WEB_SOURCE`; tests use a test-only fixture. This preserves fail-closed origin behavior and does not claim Manager self-update works.
9. Gate launch tests use the extracted repository root rather than the old monorepo directory depth.

The old Gate source/repository and entrypoint pins in `sources.py`, `registry.py`, and `deploy.py` remain legacy integration boundaries. They were not weakened or relabeled as Manager-native update support.

## Migration inventory

The final generated `docs/migration-inventory.json` records:

- 254 migrated source-to-target entries
- 38 adapted targets
- 89 entries sourced from the original `e2e/` tree
- four explicit replaced/documentary dispositions
- source commit and per-file source/target SHA-256 values

The complete original `e2e/` tree is preserved verbatim under `integration-tests/legacy-web/e2e/`, including:

- `e2e/web-interactions.browser.ts`
- `e2e/hub-approvals.visual.ts`
- `e2e/hub-launches.visual.ts`
- `e2e/harness/visual-managed-restart.ts`
- `e2e/harness/hostile-management.ts`
- `e2e/harness/test-managed-gate.py`
- `e2e/harness/test-managed-runtime.py`
- `e2e/harness/test-stdin-guard-tui.py`

These archived integration/e2e files were **not run and are not claimed as passing**. Their README requires a future installed-package cross-project adapter and temporary isolated state.

Final inventory verification recomputed every immutable source hash and current target hash:

```text
{"schemaVersion":2,"count":254,"adapted":38,"e2e":89,"dispositions":4,"mismatches":0,"dispositionMismatches":0}
```

## Test classification

### Manager Node tests

- default TypeScript units: 13 files in `tests/*.test.ts` after adding the focused helper-environment regression
- package/distribution regressions: 3 files in `tests/*.test.mjs`
- temporary socket tests: 11 files in `tests/socket/*.test.ts`
- mixed Web/Hub tests: 11 files in `integration-tests/legacy-web/tests/`, excluded from defaults
- historical e2e archive: 89 files under `integration-tests/legacy-web/e2e/`, excluded from defaults

### Gate tests

All 41 migrated `gate/tests/test_*.py` files are explicitly classified exactly once:

- offline: 32 files
- temporary socket: 9 files
- no file is selected through a negative glob

The socket class contains:

- `test_gate.py`
- `test_hub_management.py`
- `test_lifecycle.py`
- `test_lifecycle_round1.py`
- `test_multiservice.py`
- `test_pi_launch_engine.py`
- `test_pi_launches.py`
- `test_runtime_http.py`
- `test_runtime_restore_upload.py`

`test_runtime_npm_transport.py` remains in offline classification; its live listener class is guarded by the original `PI_RUNTIME_NPM_TRANSPORT=1`, while ordinary fixture tests run and the opt-in class skips.

## TDD evidence

### Initial package extraction RED

Command:

```text
node --test tests/manager-package.test.mjs
```

Observed before migration:

```text
# pass 0
# fail 1
```

Direct-file diagnostics produced four failures, including:

```text
Error: Cannot find module '/home/fate/gitproject/codex_project_v2/pi-manager/dist/hub/pi-web-hub.mjs'
```

and missing `package.json`.

### Manager release-source RED/GREEN

Command:

```text
node --import ./tests/register-ts.mjs tests/version-status.test.ts
```

RED before separation: 13 passed, 3 failed; Manager metadata was not recognized and the default status attempted three network calls.

GREEN after separation: 16 passed, 0 failed.

Command:

```text
node --import ./tests/register-ts.mjs tests/hub-versions-portal.test.ts
```

RED before separation: 7 passed, 1 failed; the portal compared Manager/Hub identity to the Web release.

GREEN after separation: 8 passed, 0 failed.

### Independent configuration RED/GREEN

Command, run with permission for child Node processes using isolated temporary HOME/config only:

```text
node tests/manager-package.test.mjs
```

RED against the copied CLI:

```text
# tests 6
# pass 4
# fail 2
```

Failures proved that the CLI selected legacy state and ignored `PI_MANAGER_CONFIG`:

```text
default initialization ignores legacy Hub state and environment: status 1
PI_MANAGER_CONFIG selects an explicit independent configuration:
actual '/home/fate/.pi/web-hub/config.json'
```

GREEN after the CLI source change and rebuild:

```text
# tests 6
# pass 6
# fail 0
```

The regression uses an isolated temporary HOME, creates an old `~/.pi/web-hub/config.json`, sets `PI_WEB_UI_HUB_CONFIG`, proves neither is selected or overwritten, and proves `PI_MANAGER_CONFIG` and explicit `--config` work. It does not read the actual host HOME configuration.

After review found that two earlier `init` child paths did not isolate `HOME` against a regressed legacy CLI, every `init` child test was changed to use a newly created temporary HOME and to clear both config environment variables before applying test-specific overrides. The corrected package regression was rerun with the following permission boundary:

```text
node tests/manager-package.test.mjs
# tests 6
# pass 6
# fail 0
```

Permission justification: the corrected regression launches only the built Manager CLI with every init child confined to isolated temporary HOME/config directories; it does not read or modify host `.pi` state, credentials, Docker, or services.

### Test-safety incident: host config sentinel created by the original RED

The original RED command was:

```text
node tests/manager-package.test.mjs
```

It was run with escalated child-process permission and this exact justification:

```text
Allow this package regression to launch only the built Manager CLI in isolated temporary HOME/config directories; it uses no production state, credentials, Docker, or external services.
```

That justification was inaccurate for the third subtest at that revision. The test set `PI_MANAGER_CONFIG` but did not isolate `HOME`; the old copied CLI ignored `PI_MANAGER_CONFIG` and resolved `/home/fate/.pi/web-hub/config.json`.

Evidence that this command created the file rather than opening a pre-existing file:

- The RED output showed subtest 3 completed `init` with status 0 and returned the actual path `/home/fate/.pi/web-hub/config.json` before failing the expected-path assertion.
- `initializeHub()` writes the config using `writeFileSync(..., { flag: "wx", mode: 0o600 })`; success is possible only when the target does not already exist at the exclusive create point.
- Controller metadata found birth and modification time `2026-10-26 00:57:44.120090672 +0800`, size 16, and mode 0600.
- The deterministic bytes that this exact command would generate are `JSON.stringify({port: 0}, null, 2) + "\n"`: 16 bytes, expected SHA-256 `4f52f2c12102a1a7ee628a1c571d542080f9042ad41fe10a15073b4c67c9f6af`.

The host file itself was never read or hashed, so the expected hash is not represented as a measured host-file hash. No contents, secrets, or sibling files under host `.pi` were inspected. The file was not changed or removed; remediation ownership remains with the controller/user.

### Distribution and classification RED/GREEN

- `node tests/manager-dist.test.mjs` initially failed because `dist/` did not exist; after build and fixture correction it passed 2/2, proving source-drift and source-symlink rejection.
- `node tests/gate-test-classification.test.mjs` initially failed because `scripts/run-gate-tests.mjs` did not exist; after explicit classification it passed 1/1.
- Gate offline initially ran 359 tests and failed with 10 failures/90 errors due stale extracted `pi-runtime/` and monorepo-depth paths.
- Focused migrated runtime-path tests then passed 43/43.
- A later Gate run exposed two listener-bearing tests inside nominal offline files; those complete files were moved to the explicit socket class.

## Completed checks

### Build and static checks

Final successful build command:

```text
npm run build
```

Output:

```text
@swordfate/pi-manager@0.1.0 typecheck
tsc --noEmit
vite v8.0.14
33 modules transformed
dist/hub/pi-web-hub.mjs 278.28 kB | gzip 73.99 kB
```

`npm run verify:dist` passed immediately after that final build. The build manifest now covers the final Gate production source.

### Package regressions

```text
node tests/manager-package.test.mjs
6 passed, 0 failed

node tests/manager-dist.test.mjs
2 passed, 0 failed

node tests/gate-test-classification.test.mjs
1 passed, 0 failed
```

### Manager offline units

Initial broad run before the focused review regression was added:

```text
npm run test:unit
12 files passed, 0 failed
```

The thirteenth file, `tests/helper-environment.test.ts`, was run directly in the review fix round and passed 1/1; the broad unit command was intentionally not rerun.

### Gate offline

Final bounded run:

```text
npm run test:gate:offline
Ran 320 tests in 20.225s
OK (skipped=8)
```

The eight skips are original environment/opt-in skips; they are not counted as passes.

### Runtime offline

```text
npm run test:runtime:offline
Ran 49 tests in 1.088s
OK (skipped=4)
```

The four skips are original opt-in skips; they are not counted as passes.

### Socket attempt

Command was run with permission for temporary loopback/Unix listeners and isolated temporary state:

```text
npm run test:socket
```

The command completed with exit status 0, but the complete captured test output after the script preamble was only:

```text
TAP version 13
# Subtest: bounded negotiation authenticates before naming unsupported and cannot enroll legacy by accident
ok 1 - bounded negotiation authenticates before naming unsupported and cannot enroll legacy by accident
  ---
  duration_ms: 184.546631
  type: 'test'
  ...
```

There was no complete 11-file enumeration or final TAP aggregate in the captured output. Because 11 socket files were supplied, this is **not accepted as a passing socket suite**. The controller requested pausing before targeted individual-file diagnostics; the later resume instruction explicitly left this anomaly for controller investigation.

Controller-provided targeted follow-up evidence, not rerun by this task agent:

```text
node --import ./tests/register-ts.mjs tests/socket/hub-cli.test.ts
11 passed, 0 failed
```

The controller also reported an isolated zero-Pi API/browser render on desktop and mobile with no JavaScript errors or overflow. That browser evidence used old build `b5d34855`, so it is retained as supporting baseline evidence rather than represented as final-build browser validation.

No Gate socket-group run was started.

## Package and detached-distribution verification

The first dry-run pack attempt failed before packaging because npm's inherited cache path was read-only:

```text
npm pack --dry-run --ignore-scripts --json
EROFS: read-only file system, open '/home/fate/tmp-npm-cache/_cacache/tmp/...'
```

The same command was rerun with an isolated writable cache:

```text
env NPM_CONFIG_CACHE=/tmp/pi-manager-npm-cache npm pack --dry-run --ignore-scripts --json
```

Result:

```text
id: @swordfate/pi-manager@0.1.0
entryCount: 78
packed size: 346361 bytes
unpacked size: 1355178 bytes
shasum: 721305dd0af899cd508b7cb345402c3a122e5c2e
```

An actual local tarball was then created with `--ignore-scripts` under `/tmp` for detached inspection only. Findings:

- all 78 tar entries are regular files; no symlink entry is present;
- no `node_modules/`, `tests/`, `integration-tests/`, `.env`, controller research/validation docs, or development toolchain files are packed;
- package metadata declares only `ws` under production dependencies, with no optional or peer dependencies;
- package bin is only `pi-manager -> dist/hub/pi-web-hub.mjs`;
- filesystem inspection of the extracted package found no symlink before the test-only `ws` dependency was copied in;
- credential signature scan found no private-key header, AWS access key, OpenAI-style secret key, GitHub token, Slack token, or Google API key pattern;
- the only sibling-checkout reference in packed files is documentary provenance text; no source import resolves into a sibling checkout;
- no old `PI_WEB_UI_HUB_CONFIG` or `~/.pi/web-hub/config.json` fallback appears in packed executable/source code.

The detached tarball was tested with only a copied `ws` package under its own `node_modules`, an isolated `/tmp` HOME, an isolated legacy config sentinel, `PI_OFFLINE=1`, and no Pi process.

The first smoke attempt reached the zero-Pi API but asserted the asynchronous version state before it settled:

```text
actual: checking
expected: unavailable
```

The temporary smoke probe was corrected to poll the same local endpoint, matching existing behavior; no package source was changed. Final output:

```text
{"init":true,"portal":200,"sessions":0,"versions":"unavailable"}
```

The smoke proved:

- default init selected isolated `~/.config/pi-manager/config.json`;
- isolated `PI_WEB_UI_HUB_CONFIG` and old config were ignored and unchanged;
- the packed CLI served `/sessions/` with HTTP 200;
- `/api/sessions` returned an empty session array with zero Pi processes;
- default Manager release status settled to `unavailable` without requiring a network release source;
- only the smoke's own child was terminated.

## Final repository and staging boundary

- No active test command/session remains.
- Process inspection found no temporary Manager CLI, Node test runner, Python unittest runner, Gate server, or Hub server left by this task.
- No unrelated process was touched or killed.
- `node_modules` is ignored by the bare `.gitignore` rule and is not tracked.
- Controller-owned plan/spec/research/validation changes are excluded from staging.
- Task staging is limited to `.gitignore`, `README.md`, `LICENSE`, package/build files, `bin/`, `dist/`, `hub/`, `protocol/`, `gate/`, `runtime/`, `scripts/`, `tests/`, `integration-tests/`, `docs/migration-inventory.json`, `docs/source-provenance.md`, and this report.

## Known product limitations preserved honestly

- No native Pi backend was implemented or validated.
- No Docker backend feature was implemented or validated.
- No MCP service/interface was implemented.
- No unified supervisor or Manager-native self-update was implemented.
- Default Manager release lookup is intentionally unavailable until a reviewed Manager release source is configured.
- Legacy Gate update/deploy source pins remain old-Hub integration and are explicitly unconfigured by default.
- Mixed Web/Hub tests and archived e2e fixtures were preserved but not executed.
- Manager socket coverage is not established because the aggregate Node command reported only one subtest; the exact command/output boundary is preserved for controller investigation and is not called a pass.
- The nine-file Gate socket class was intentionally not run at the extraction boundary.
- Gate offline retained eight original environment/opt-in skips; runtime offline retained four original opt-in skips. Skips are not counted as passes.
- The original RED test safety incident created `/home/fate/.pi/web-hub/config.json`; it remains untouched pending controller/user remediation.

## Review fix round 1

Review input: `.superpowers/sdd/2026-10-26-independent-packages/task-1-review.md`.

All four findings were addressed without rerunning the broad Gate/runtime/unit suites.

### Packed runtime probe closure and extracted verifier

Focused regressions were written before implementation. Initial command:

```text
node tests/manager-dist.test.mjs
```

It was run with permission limited to local scripts-disabled/offline `npm pack`, temporary tar extraction, and the extracted verifier. RED output retained both blocking findings:

```text
contains all three fixed runtime probe files as regular non-symlink files
ENOENT: .../runtime/runtime_probe_provider.ts

runs the shipped distribution verifier from the extracted tarball
Manager distribution verification failed: ENOENT: .../package/package-lock.json

# tests 5
# pass 2
# fail 3
```

Correction:

- `package.json` explicitly includes `runtime/runtime_probe_provider.ts`.
- `scripts/manager-dist.mjs` now inventories only executable/source inputs intentionally present in the packed distribution: `bin/`, `hub/`, `protocol/`, `gate/gate/`, `gate/gatectl`, the explicit production runtime file set, `package.json`, and the shipped verifier itself.
- Checkout-only tests, `package-lock.json`, `tsconfig.json`, and `vite.config.ts` are deliberately excluded from the build manifest. They are development/test inputs, not files an installed tarball can verify.
- Mutation detection and no-symlink traversal rules are unchanged.

Final focused command:

```text
node tests/manager-dist.test.mjs
```

GREEN output:

```text
distribution verification rejects source drift after the bundle manifest is written: ok
distribution inventory refuses source symlinks: ok
actual packed artifact contains runtime_probe.py, runtime_probe_provider.ts and runtime_probe_ws.mjs: ok
shipped verifier runs from the extracted tarball: ok

# tests 5
# pass 5
# fail 0
```

The tarball regression invokes:

```text
npm pack --ignore-scripts --offline --json --pack-destination <temporary-directory>
```

It performs no lifecycle scripts or network access, extracts into its own temporary directory, requires all three probe files to be regular non-symlink files, and invokes only the verifier shipped in that extracted artifact.

### Hub CLI helper fallback isolation

RED command:

```text
node --import ./tests/register-ts.mjs --test tests/helper-environment.test.ts
```

RED output:

```text
SyntaxError: The requested module './helpers/hub-cli.ts' does not provide an export named 'isolatedHubCliEnvironment'
# pass 0
# fail 1
```

Correction: `tests/helpers/hub-cli.ts` now creates a private temporary HOME and separate fallback paths below the helper root, removes inherited `HOME`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG` values before constructing the child environment, and still passes explicit `--config` to every state-initializing CLI command.

Focused environment GREEN:

```text
node --import ./tests/register-ts.mjs --test tests/helper-environment.test.ts
# tests 1
# pass 1
# fail 0
```

Focused real helper lifecycle GREEN, using only temporary loopback/Unix listeners and isolated temporary state:

```text
node --import ./tests/register-ts.mjs tests/socket/hub-cli.test.ts
# tests 11
# pass 11
# fail 0
```

No host configuration path or contents were accessed by this fix round.

### README capability correction

The README now separates current extraction capabilities from future architecture. Current claims are limited to zero-Pi Hub initialization/serving, existing registration/session routing/portal behavior, and distribution of unconnected Gate/runtime sources. Pi lifecycle management, extension tasks, MCP, native/Docker backends, and a unified Manager remain explicitly future and unimplemented.

The README also documents the packed-source manifest policy and states that `verify:dist` is designed to run after extracting the real tarball.

### Configuration/document disposition accounting for Task 2

`docs/migration-inventory.json` is now schema version 2 and contains a separate four-entry `dispositions` section, without copying or enabling additional runtime behavior:

- `hub/package.json`, source SHA-256 `3ca9d4afd21425087cf31893b8f9f63c81b0b8408db5e343ca76e5f8aa26ab9a`: old embedded-Hub package boundary replaced by root `package.json`.
- `vite.hub.config.ts`, source SHA-256 `3a3cc7544f33de42889bc6bfd03e02b68b76bdca8b67c56a7bc05d1c67b20acd`: old Web-repository Hub build entry replaced by root `vite.config.ts`.
- `integrations/runtime-updater/README.md`, source SHA-256 `799632fe04ce5562bcc156544b4df7c1002dd757f298eb78cdcd2feebcd8d282`: documentary migration to `runtime/README.md`; no runtime wiring claim.
- `integrations/runtime-updater/provenance.json`, source SHA-256 `76d9c08a321d526248c8bf6aab810d48613d6cb3d9a970751da4dd9773914e82`: documentary migration to `runtime/source-provenance.json`; legacy deployment remains unconfigured.

Final inventory verification:

```text
{"schemaVersion":2,"count":254,"adapted":38,"e2e":89,"dispositions":4,"mismatches":0,"dispositionMismatches":0}
```

### Final focused build verification

```text
npm run build
tsc --noEmit
vite v8.0.14
33 modules transformed
dist/hub/pi-web-hub.mjs 278.28 kB | gzip 73.99 kB

npm run verify:dist
exit 0
```

Broad Gate/runtime/default-unit suites were not rerun because the fix touched only package inclusion, the shipped inventory policy, a test helper environment, focused tests, README wording, and migration accounting. Gate socket tests and the unresolved aggregate socket-runner evidence boundary remain unchanged. Controller-owned documentation and `integration-tests/protocol-compatibility.test.mjs` are excluded from this fix commit.

## Review fix round 2: direct socket CLI child isolation

The fix-round-1 review passed all four original findings. A remaining Global Constraint audit found that four direct test roots in `tests/socket/hub-cli.test.ts` bypassed the isolated shared helper environment:

- the basic CLI lifecycle root;
- the standalone serve root;
- the detached-bundle root;
- each synthetic unknown-command root.

The first two inherited the complete parent environment because their child options omitted `env`. The detached path copied `process.env` and changed only `PI_OFFLINE`. The unknown-command path copied `process.env` and changed only the legacy config variable. Consequently, those direct init children and their matching serve/unknown-command children could inherit the real `HOME` and unrelated Manager/legacy config paths.

### Focused RED

A launch-boundary test guard was first applied to the existing direct child calls. It required explicit `HOME`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG` values below each scenario's temporary root and stopped the direct children before execution.

Command:

```text
node --import ./tests/register-ts.mjs tests/socket/hub-cli.test.ts
```

Relevant RED output:

```text
CLI initializes once ...: direct Hub CLI children require an explicit isolated environment
standalone hub serves ...: direct Hub CLI children require an explicit isolated environment
detached Hub bundle ...: HOME must stay below the test root
unknown command subtests: direct Hub CLI children require an explicit isolated environment

# tests 11
# pass 1
# fail 10
```

This RED run was unprivileged. The direct unsafe children failed at the guard before launch. The already-isolated shared-helper lifecycle later failed to start because that RED run had no listener permission; it did not access host configuration.

### Minimal correction and per-scenario guard

Each of the four actual test roots now constructs one environment with `isolatedHubCliEnvironment(dir)`, asserts that all three safety paths remain below that root, and passes the same environment to every matching direct child. The detached scenario adds only `PI_OFFLINE=1` after isolation. The unknown-command scenario points both `PI_MANAGER_CONFIG` and `PI_WEB_UI_HUB_CONFIG` at its synthetic initialized config, preserving the inherited-property regression semantics without exposing any host fallback.

No production source, built artifact, package manifest, or shared helper behavior changed. The temporary launch-wrapper experiment used for the RED was removed; the final test retains the original direct `spawn`/`spawnSync` structure plus per-root environment isolation and assertions.

### Focused GREEN

Command, run once after isolation with permission limited to temporary loopback/Unix listeners and isolated temporary state:

```text
node --import ./tests/register-ts.mjs tests/socket/hub-cli.test.ts
```

Exact summary:

```text
# tests 11
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2749.489193
```

Permission justification:

```text
Allow this one focused socket CLI test to create only temporary loopback and Unix listeners with isolated temporary HOME/config paths; it uses no production state, credentials, Docker, services, or network.
```

The updated mapped target SHA-256 for `tests/socket/hub-cli.test.ts` is `c423390ffbf49f952d8737f983a5899cd897775778ff236b9c24d76b357458d0`. No broad suite, Gate test, build, or distribution rebuild was run because no shipped or production file changed. Controller-owned documentation and `integration-tests/protocol-compatibility.test.mjs` remain excluded.


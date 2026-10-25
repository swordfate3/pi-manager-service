# Task 1 review — independently buildable Manager distribution

Date: 2026-10-26

Reviewed range: `f8a6b64..4040b04`

Inputs:

- `.superpowers/sdd/2026-10-26-independent-packages/task-1-brief.md`
- `docs/superpowers/plans/2026-10-26-independent-packages.md`, especially Global Constraints
- `.superpowers/sdd/2026-10-26-independent-packages/task-1-report.md`
- `.superpowers/sdd/2026-10-26-independent-packages/review-task-1.diff`

## Verdicts

- **Spec compliance: FAIL — blocking changes required.** The extracted package does not contain the complete Gate/runtime probe closure, and one state-initializing socket-test helper still violates the explicit fallback-isolation constraint.
- **Implementation quality: CHANGES REQUIRED.** The packed artifact ships a distribution verifier that cannot verify the packed artifact, and the README contains a current-capability statement that contradicts the extraction boundary.

The extraction is otherwise well bounded: the immutable migration inventory is internally and externally consistent, the 37 adaptations are distinguishable from 217 byte-identical migrations, Manager configuration/release lookup is fail-safe by default, and the report is appropriately conservative about incomplete socket/browser evidence.

## Findings

### [P1] The published package omits a runtime probe file required by the shipped Gate/runtime code

`package.json:38-52` publishes `runtime/*.py`, `runtime/*.mjs`, and `runtime/pi-session-control`, but does not publish `runtime/runtime_probe_provider.ts`.

That file is not optional documentation or a test fixture:

- `runtime/runtime_probe.py:40` includes it in the fixed `PROBE_FILES` identity.
- `runtime/runtime_probe.py:301` copies it into the probe workspace.
- `runtime/runtime_probe.py:411` passes it as the runtime extension.
- `runtime/runtime_probe.py:915` requires its digest to match the profile.
- `gate/gate/runtime_engine.py:79-82` hashes the same three-file probe set while building the Gate-owned profile.
- `gate/gate/runtime_install.py:103-120` refuses a probe installation unless all three files exist and match the profile.

A focused, isolated `npm pack --ignore-scripts` inspection of commit `4040b04` confirmed that the 78-entry tarball contains `runtime_probe.py` and `runtime_probe_ws.mjs` but not `runtime_probe_provider.ts`.

Impact: the tarball is not a complete independently distributable copy of the extracted Gate/runtime implementation. Any packaged flow that builds or verifies the runtime probe profile fails on the missing provider before the probe can run.

Required correction: include the provider explicitly (or broaden the intentional runtime file set safely) and add a packed-artifact closure test that exercises the three-file profile from the extracted tarball, rather than only smoke-testing the bundled Hub CLI.

### [P1] The shipped `verify:dist` command cannot verify the shipped package

`scripts/manager-dist.mjs:9-17` defines its source inventory as all files under `bin/`, `hub/`, `protocol/`, `gate/gate/`, and `runtime/`, plus:

- `gate/gatectl`
- `package.json`
- `package-lock.json`
- `scripts/manager-dist.mjs`
- `tsconfig.json`
- `vite.config.ts`

The package allow-list at `package.json:38-52` excludes at least `package-lock.json`, `tsconfig.json`, `vite.config.ts`, runtime tests, and other runtime files that were hashed into `dist/build-manifest.json`. Nevertheless, `package.json:14` exposes `verify:dist` as `node scripts/manager-dist.mjs`, and `README.md:20-29` documents it as a normal verification command.

The focused packed-artifact check confirmed the failure:

```text
Manager distribution verification failed: ENOENT: no such file or directory, lstat '.../package/package-lock.json'
verify_status=1
```

`tests/manager-dist.test.mjs:10-27` does not catch this because its fixture copies the complete source layout, including all files omitted by the tarball. Its drift and symlink assertions are useful, but they validate a source checkout rather than the distributable package.

Impact: the package's advertised integrity check is not independently usable after packing/installing, and the build manifest cannot be revalidated from the artifact it accompanies.

Required correction: either publish the exact source inventory required by the verifier, or define a separate packed-distribution inventory containing only intentionally shipped files and verify that inventory after extracting a real tarball. The latter should also enforce the runtime closure from the previous finding.

### [P1] `tests/helpers/hub-cli.ts` still allows a regressed CLI to fall back to real user state

The Global Constraints require every state-initializing test subprocess to isolate `HOME` and both old/new configuration environment paths under its own temporary root, even when `--config` is supplied. This was added specifically to prevent a deliberately regressed CLI from reproducing the earlier host-config incident.

`tests/helpers/hub-cli.ts:44-46` creates a temporary test directory, but constructs the child environment as:

```ts
const env = { ...process.env, PI_WEB_UI_HUB_CONFIG: config };
```

It therefore:

- inherits the real `HOME`;
- inherits any host `PI_MANAGER_CONFIG`;
- points only the legacy variable at the temporary config;
- does not place both old and new configuration paths under the temporary root.

The helper then initializes real CLI state at `tests/helpers/hub-cli.ts:52-60` and `tests/helpers/hub-cli.ts:124-126`. The current CLI receives an explicit `--config` and is safe in the passing implementation, but the constraint deliberately requires the test to remain safe when the CLI is regressed and ignores or mishandles that option. This helper is used by `tests/socket/hub-cli.test.ts:194` and `tests/socket/hub-cli.test.ts:215`.

Impact: a future RED/regression run can again resolve a host configuration path or write beneath the real home directory. This is the same class of safety failure documented in the task report, so it is not merely test hygiene.

Required correction: construct a fresh temporary home, set `HOME` to it, and place both `PI_MANAGER_CONFIG` and `PI_WEB_UI_HUB_CONFIG` at explicit paths below the helper's temporary root. Do not inherit either variable from `process.env`; keep `--config` as an additional explicit boundary.

### [P2] README states unimplemented unified-manager capabilities as current product behavior

`README.md:3-5` correctly says this task is only the phase-2 extraction and explicitly says extension-management tasks and a unified Manager are not implemented. However, `README.md:40-46`, especially line 43, states without a future/design qualifier that the product manages session creation/stopping, Pi update/rollback, and extension installation/update tasks.

That statement contradicts both the preceding status section and the task boundary excluding a native backend, MCP, extension management, and a unified supervisor.

Impact: users can reasonably read the README as claiming capabilities that this package does not expose or validate.

Required correction: label that list as future architecture/design intent, or replace it with the capabilities actually available in this extraction and move the remaining items to an explicit outstanding-work list.

## Spec-compliance assessment

### Migration and provenance

- `docs/migration-inventory.json:1-12` records the immutable source repository/commit and separate source/target SHA-256 values.
- Independent read-only verification against source commit `27326a8cbea8331cac29e6b6b41f98f2b69fa05b` and target commit `4040b04` found: `total=254 adapted=37 unchanged=217 mismatches=0`.
- The 37 adapted entries were reviewed separately from the 217 byte-identical migrations. The adaptations are limited to Manager configuration identity, Manager-owned protocol import paths, package/release identity, Gate/runtime path relocation, explicit legacy-Web-source injection, and corresponding test relocations/expectations.
- The preserved legacy Web integration archive is clearly excluded from default tests and not represented as passing. `integration-tests/legacy-web/README.md:3-15` gives an explicit installed-package setup model and evidence boundary.

Result: **pass** for migration accounting and preservation. The packaging findings above concern newly introduced distribution metadata and tests, not silent mutation of the unchanged legacy sources.

### Independent configuration and release lookup

- `bin/pi-web-hub.mjs:48-50` selects explicit `--config`, then `PI_MANAGER_CONFIG`, then `~/.config/pi-manager/config.json`; it does not consult the old variable or path.
- `tests/manager-package.test.mjs:18-23` provides a correct isolated environment helper, and every `init` subprocess in that file uses it.
- `hub/version-status.ts:429-440` defaults to a local unavailable source and performs no release-network lookup unless a reviewed source is explicitly injected.
- `hub/version-status.ts:385-425` recognizes only `@swordfate/pi-manager` as local Manager package metadata.

Result: **pass** for production defaults and the package regression itself, with the separate socket-helper isolation failure above.

### Package/import closure

- No active `bin/`, `hub/`, or `protocol/` import resolves into the sibling Web checkout; the Manager-owned protocol moves are direct path substitutions with the copied checks preserved.
- The Hub bundle externalizes only Node built-ins and declared dependency `ws` (`vite.config.ts:14-29`).
- The detached Hub CLI smoke is meaningful for the bundled Hub entry point, but `tests/manager-package.test.mjs:86-109` copies only the bundle, package metadata, and `ws`, then runs `--help`. It does not validate the packaged Gate/runtime file closure or packed manifest verification.

Result: **fail** because the complete published Manager package closure is missing `runtime_probe_provider.ts`, and the packed integrity verifier is not self-contained.

### Test enumeration and evidence honesty

Static default enumeration is honest:

- `package.json:17` expands to 12 top-level TypeScript unit files.
- `package.json:18` expands to the 3 package `.test.mjs` files.
- `package.json:20` expands to 11 socket `.test.ts` files.
- `scripts/run-gate-tests.mjs:7-53` explicitly lists 32 offline and 9 socket Gate files.
- `tests/gate-test-classification.test.mjs:10-17` checks that every migrated Gate test is classified exactly once.

The runtime evidence must remain bounded:

- The report records a complete `npm run test:unit` result of 12 files passing (`task-1-report.md:290-295`). There is no observed aggregate anomaly for this command.
- Package evidence is direct-file evidence: 6/6, 2/2, and 1/1 (`task-1-report.md:277-288`). The report does not separately show an aggregate `npm run test:package` transcript. The script statically selects all three files, but aggregate execution is therefore an evidence gap rather than an independently demonstrated pass.
- `npm run test:socket` returned exit 0 while showing only one subtest and no 11-file enumeration/final aggregate (`task-1-report.md:319-339`). The report correctly does **not** call that suite passing.
- Controller evidence establishes only direct `tests/socket/hub-cli.test.ts` success, 11/11 (`task-1-report.md:341-346`).
- The isolated desktop/mobile zero-Pi browser pass used build `b5d34855`, not the final reviewed build (`task-1-report.md:348`).
- No Gate socket-group run was performed (`task-1-report.md:350`).

There is no source-level proof that the socket aggregate anomaly also affects `test:unit` or the three package files. No socket test contains a top-level `process.exit`, and child-process restrictions are independently known to be real in this environment. Therefore the one-subtest output is an unresolved runner/environment evidence problem, not by itself a product-code failure. It still prevents a socket-suite pass claim.

## Review evidence and limits

- The supplied 63,894-line diff was read once through a bounded, single-pass file/hunk index. Review then focused on the 37 hash-marked adaptations and newly introduced package/build/test files; unchanged legacy Gate/runtime content was not broadly re-audited.
- No existing test suite was rerun.
- One focused non-suite check exported commit `4040b04`, packed it with isolated npm configuration and scripts disabled, inspected the runtime file set, and invoked the shipped verifier in the extracted tarball. It confirmed both packaging findings without Docker, services, network access, or host configuration access.
- The controller's `spawnSync git EPERM` observation is treated as an environment permission fact, not as a product failure. The independent hash verification in this review was performed by direct read-only Git commands and completed with zero mismatches.
- No host configuration, credentials, Docker data, services, or network resources were read or modified.

## Final decision

Task 1 should not be accepted as an independently distributable Manager package until the two packed-artifact closure defects and the remaining fallback-test isolation defect are fixed and reviewed. After those fixes, a focused re-review should verify an extracted tarball, including the runtime probe trio and `verify:dist`, plus the corrected helper environment. The unresolved aggregate socket runner should remain an explicit evidence limitation unless a complete 11-file aggregate is later captured; it should not be converted into a code-failure claim without proof.

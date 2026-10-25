# Final extraction fix wave — requirements

Status: ready for dispatch. Combined final review is ready (0 Critical,2 Important,2 Minor); Task2 specification/quality PASS with the same README source ambiguity plus phone-topology minor. ONE implementer owns this full fix wave.

Repositories: Manager `/home/fate/gitproject/codex_project_v2/pi-manager` (`codex/bootstrap`), Web `/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals` (`v1`). No main/push/deployment/real state/Docker operations. Preserve unrelated/untracked files and controller-owned research/validation docs.

Read the final reviewer findings verbatim in `final-review.md`; requirements derive from the approved independent-packages plan and spec. No subagents. Use TDD and apply_patch, commit scoped files, append complete command/output evidence to `final-fix-report.md`, return only status/commits/summary.

## I1 — generated-cache stability and package closure

Fix both source identity and actual npm archive contents for `gate/gate/__pycache__` / Python bytecode. Do not delete current caches to hide the issue or bless them into a rebuilt identity. Keep real-source drift detectable and preserve fail-closed source/output symlink checks, including explicit cache-named-link policy. Tests must create synthetic caches and show unchanged source identity, unchanged clean manifest verification, actual archive cache exclusion, extracted verifier success, genuine source mutation rejection and symlink rejection. Prefer explicit package selection over relying on npm's implicit gitignore behavior. Update package-lock metadata only if applicable. Rebuild and verify distribution after actual source changes; report final fingerprint.

## I2 — remaining state-capable CLI children

`tests/socket/hub-state-budget.test.ts` currently has three direct CLI calls at lines220,273,316; `tests/socket/hub-bounded-registry.test.ts` has one at279. Reuse `isolatedHubCliEnvironment` per fixture temporary root for HOME/new+legacy configs; audit remaining state-capable entrypoints against the same rule. Add focused guard coverage before executing any unsafe RED subprocess; no deliberately regressed command may touch actual HOME. Preserve quota/race/lock/proof tests. Use named subset selection for bounded-registry so the unchanged2000-rotation60s stress is NOT rerun/weakened merely for environment validation. Run the state-budget file plus only affected bounded subset and direct static/behavioral guard tests, all inside an outer temporary fallback environment. Update corresponding migration target hashes for changed copied tests/sources; immutable source hashes stay fixed.

## M1 — accurate installed CLI help

Help must advertise `pi-manager` and a document actually shipped by this package, not missing `docs/hub.md`. Preserve bundle filename and wire-protocol field compatibility; don't change legacy command semantics. Add a focused help assertion (no listener required) and refresh target hash for the adapted CLI.

## M2 — Web v1 is local, not publicly installable yet

Web README install/update examples currently omit the new local/unpublished `v1` boundary. Clearly label public main commands as legacy/current published-branch behavior and document an actual local evaluation path for this existing `v1` checkout (e.g. explicit extension loading or a locally created tarball). Do not claim remote `@v1` exists or push/publish to make it true. Preserve existing-user source continuity and do not install into actual Pi config. Correct the nearby phone-access diagram to show alternative proxy→single Pi Web and proxy→Manager→Pi Web paths, not Pi Web forwarding to Manager. This is documentation only; don't rebuild Web assets if its source manifest intentionally excludes README. Verify referenced commands against actual package scripts/exports.

## Verification bounds

Use only temporary test HOME/config/state, random loopback listeners if required, no real credentials, model service, Docker or production resources. Existing full Gate/runtime suites and already-completed broad Web unit/install suites are not to be rerun. Cover changed code with focused tests, both relevant typechecks/build/dist, and actual pack/extract regression. The original stress timeout and unexecuted optional suites remain clearly recorded, not silently converted into green evidence.

Full reviewer list: final-review.md I1,I2,M1,M2 and task-2-review.md two README minor corrections (both covered by M2 above). No additional Web runtime/distribution Important defect found. Manager fix BASE is current HEAD7ef3490; Web fix BASEeef18b5. Controller-owned docs/validation/independent-packages/* EOF normalization is unstaged; leave it out of your commits. Controller-owned other research/validation documents must remain untouched.

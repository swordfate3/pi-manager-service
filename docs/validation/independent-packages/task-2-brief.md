## Task 2: Clean Web v1 product and retain integrations

**Files:** Web package/lock, build scripts, `scripts/web-dist.mjs`, installation tests, `tests/web-dist.test.mjs`, type coverage, Web README/docs, manager-only directories/tests, tracked dist. Manager extraction inventory is consumed read-only.

**Interfaces:** Keep Pi extension entry `extensions/mirror-server.ts` and `./interactions/v1`. Keep optional registration/control adapters and their current wire protocol. Produce Web package with no Hub executable or Gate/runtime implementation.

- [ ] Add/run a real distribution regression before changes: Web source/asset verification succeeds when there is no manager source/build output, and a packed Web package contains its extension but no manager executable.

```js
const manifest = await createManifest(webOnlyFixture);
assert.ok(manifest.outputs.files.some(file => file.path === 'index.html'));
await writeManifest(webOnlyFixture);
await verifyManifest(webOnlyFixture);
```

- [ ] First ensure Task 1's exact inventory accounts for every manager-only file being removed and every mixed integration test. Use tracked-file deletions only, preserving user untracked content and historic branches.
- [ ] Remove Hub bin/files/build config and runtime-updater implementation from Web. Update source manifest and lock metadata. Retain optional Pi adapters, remote-access helper behavior and all session interaction security checks; no blanket search-and-delete of `hub` strings.
- [ ] Move manager-owned tests according to inventory. Keep mixed Web behavior coverage either adapted to an explicit installed-manager integration harness or in the preserved cross-project integration suite, not dangling in default Web tests. Record exact test movements.
- [ ] The Web E2E Hub harness accepts explicit `PI_E2E_MANAGER_DIR` pointing to an independently installed/built manager root; it never imports manager sources. When absent, manager-only integration cases must either be outside default Web selection or visibly marked skipped with an actionable reason; direct single-session cases must still run. CI documents/runs the optional integration separately rather than assuming Web ships a Hub. Do not silently omit cases by filtering an array without a skip result.
- [ ] Update Git-install/pack tests for Web-only installation, source mutation rejection and integrity verification. Do not replace security assertions with superficial package-text matching.
- [ ] Build Web, verify dist, run both type checks and Web unit tests; validate production-only package preparation in an isolated temporary copy. Update only changed formatting; report original unrelated lint failures separately.
- [ ] Document independent Web installation and optional Manager connection. Update development log with actual status and commit the clean v1 task.

## Controller integration context

- Web root `/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals`, literal branch `v1`, baseline74021fc. Preserve existing untracked `.learnings/`; controller has a pending approved-design header/boundary correction in `docs/superpowers/specs/2026-10-26-clean-web-v1-design.md`, which may be included with this task.
- Manager root `/home/fate/gitproject/codex_project_v2/pi-manager`; immutable extraction source27326a8cbea8331cac29e6b6b41f98f2b69fa05b. Read `docs/migration-inventory.json`: schema2,254 mappings plus4 explicit dispositions. Manager owns the byte-preserved original e2e archive and mixed-unit archive. Do not edit Manager source/inventory during Task2.
- Manager installed CLI remains `dist/hub/pi-web-hub.mjs`, package name `@swordfate/pi-manager`. For Web E2E, only explicit `PI_E2E_MANAGER_DIR` may select that independent built/installed Manager root. `PI_E2E_RUNTIME_DIR` still selects the Web extension runtime; do not repurpose it or fall back to a sibling checkout.
- `e2e/session-hub.integration.ts` currently wrongly assumes the Hub and Web build hashes are identical. Adapt configured integration to assert Manager identity against the selected independent Manager manifest and Web identity against the selected Web manifest, not by removing the identity assertion. With no Manager selection, show a real skip result. Preserve direct single-session cases in mixed route suites.
- Root type check and `tsconfig.connection.json` both need updating where manager-only tests were listed. Keep Web source/extension logic byte-identical unless a concrete split dependency requires a small justified change; preserve latestCtx and all security guards.
- Current Web baseline subset passed69/69 before extraction; not post-change evidence. `just check` has two original Biome errors in unchanged `e2e/web-interactions.browser.ts`,36 warnings,7 infos. Do not silently fix unrelated formatting or claim a green global lint baseline.
- Default Node child/listener tests can fail EPERM in this environment; scoped permission for temporary state/listeners has worked. Do not mislabel incomplete aggregate output as passing. Capture final test-file counts and aggregate summaries. Run focused tests while iterating, one broad Web unit run before commit; avoid rerunning unrelated Gate suites.
- All test/init subprocesses must use temporary HOME plus new/legacy config-variable paths, even when --config is explicit. No host .pi/credentials, production services, Docker API, network installs or extension installations into actual Pi settings.
- In particular, both `e2e/harness/hub-cli.ts` and the Pi child in `e2e/harness/pi-process.ts` must use their own temporary HOME/config fallback paths; `PI_CODING_AGENT_DIR` alone is not HOME isolation. Do not invoke these legacy helpers before fixing the environment boundary.
- Controller owns Manager validation/research docs and cross-project protocol test. Add your report at this SDD directory's `task-2-report.md`; commit only scoped Web changes. Report exact test movements/deletions, build/install/pack evidence and unrun real-Pi/E2E checks. No subagents, push, main merge or service restart.

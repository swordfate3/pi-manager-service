# Independent packages — scoped final re-review

Date: 2026-10-26

**Combined verdict: PASS for the scoped fix wave. I1, I2, M1, M2 and the Task 2 phone-diagram minor are ADDRESSED. No new actionable Critical, Important or Minor issue was found in the fix diffs.** This closes the findings under review; it does not convert documented acceptance gaps into passing results or authorize a merge, push, production switch or deployment.

## Scope and method

- Manager fix range: `7ef3490..8dc43d3`, supplied `review-final-fix-manager.diff`.
- Web fix range: `eef18b5..2838497`, supplied `review-final-fix-web.diff` (README only).
- Reviewed the fixes against the findings in `final-review.md`, `final-fix-report.md`, and the previously reviewed extraction plan/spec. Inspected the changed implementation, tests, package selection, generated distribution/manifest and migration-inventory updates; checked the current controller validation additions and supplied cross-project TAP logs.
- This was a bounded follow-up, not a historical source re-audit or a repeat of the whole-branch review. No tests, suites, listeners or services were run. No subagents, network, Docker, host configuration/credentials, Git mutations or cache changes were used. The only write is this report.
- File references below identify the current Manager or Web checkout through their absolute paths. Controller-owned validation additions remain unstaged and are evidence, not part of either committed fix range.

## Strengths

- Cache exclusion is implemented at the source-identity and package-selection boundaries together, rather than by deleting existing caches or incorporating their machine-specific contents into the manifest. Real archive extraction is covered, not merely an npm file-list preview.
- The four omitted state-capable CLI children reuse the existing fixture-owned environment. The added behavioral and AST guards check both the helper's redirected fallback paths and its use at the reviewed call sites, without weakening the original state/race assertions.
- User-facing corrections accurately distinguish the installed Manager command from its bundle filename and the unpublished local Web checkout from the existing public Git source. The fix wave preserves the independent package and protocol boundaries.

## Finding dispositions

### I1 — Generated-cache identity and package leak: ADDRESSED

Evidence: [manager-dist.mjs:31](/home/fate/gitproject/codex_project_v2/pi-manager/scripts/manager-dist.mjs:31), [manager-dist.mjs:95](/home/fate/gitproject/codex_project_v2/pi-manager/scripts/manager-dist.mjs:95), [package.json:42](/home/fate/gitproject/codex_project_v2/pi-manager/package.json:42).

The source walker rejects encountered symlinks before excluding regular `__pycache__` directories and regular `.pyc`/`.pyo` files. Ordinary source drift and output-symlink refusal remain enforced. Package selection now ships `gate/gate/*.py` instead of the entire cache-bearing directory. Excluded regular cache subtrees are deliberately outside source identity; the implementation does not follow cache-named links at the traversal boundary.

Regressions at [manager-dist.test.mjs:93](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-dist.test.mjs:93), [:132](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-dist.test.mjs:132), [:142](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-dist.test.mjs:142), [:152](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-dist.test.mjs:152) and [:164](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-dist.test.mjs:164) cover stable identity, cache-named/bytecode/output symlinks, actual offline pack/extract, cache absence, the three-file runtime-probe closure and the extracted verifier. Synthetic caches are created in temporary copies; repository caches are not repaired or blessed. Reported result: 10 passed. Controller separately records all 18 existing cache hashes byte-unchanged.

### I2 — Four direct CLI child environments: ADDRESSED

The three state-budget children now use `env: f.cliEnvironment` at [hub-state-budget.test.ts:221](/home/fate/gitproject/codex_project_v2/pi-manager/tests/socket/hub-state-budget.test.ts:221), [:274](/home/fate/gitproject/codex_project_v2/pi-manager/tests/socket/hub-state-budget.test.ts:274) and [:317](/home/fate/gitproject/codex_project_v2/pi-manager/tests/socket/hub-state-budget.test.ts:317). The bounded-registry revoke child does likewise at [hub-bounded-registry.test.ts:281](/home/fate/gitproject/codex_project_v2/pi-manager/tests/socket/hub-bounded-registry.test.ts:281). Both fixtures provide the existing isolated environment helper's result.

[hub-cli-environment.test.ts:8](/home/fate/gitproject/codex_project_v2/pi-manager/tests/hub-cli-environment.test.ts:8) characterizes fixture-local HOME and both configuration fallbacks. [hub-cli-isolation-guard.test.mjs:24](/home/fate/gitproject/codex_project_v2/pi-manager/tests/hub-cli-isolation-guard.test.mjs:24) requires exactly the four reviewed direct children and the actual `f.cliEnvironment` expression, not merely an `env` property or `process.env`. Existing quota, race, lock, proof and stress assertions were not relaxed. Reported results: 12 state-budget passes, 1 named revoke-case pass, and 2 environment-guard passes. This is scoped isolation evidence, not a new guarantee about every subprocess in the repository.

### M1 — Installed help command and shipped documentation: ADDRESSED

[bin/pi-web-hub.mjs:10](/home/fate/gitproject/codex_project_v2/pi-manager/bin/pi-web-hub.mjs:10) now advertises `pi-manager` commands; [:19](/home/fate/gitproject/codex_project_v2/pi-manager/bin/pi-web-hub.mjs:19) points to shipped `README.md`. The rebuilt bundle contains the corresponding correction. The retained Hub banner/bundle filename does not invalidate the actual package command. [manager-package.test.mjs:111](/home/fate/gitproject/codex_project_v2/pi-manager/tests/manager-package.test.mjs:111) rejects the obsolete command/document references. Reported package/help result: 7 passed.

### M2 — Local unpublished Web installation/update instructions: ADDRESSED

[Web README.md:6](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:6) identifies local `v1` as unpublished; [:33](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:33) labels the public Git command as a different source. The local recipe at [:41](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:41) builds/verifies the checkout and loads its actual extension file by absolute path. It warns about duplicate installations and persistent package-configuration changes. Update instructions at [:130](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:130) and [:138](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:138) no longer imply a remotely installable `@v1`. No Web implementation or generated asset changed in this fix range.

### Task 2 phone topology diagram minor: ADDRESSED

[Web README.md:151](/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md:151) now branches at the trusted tunnel/reverse proxy: either direct single-session Pi Web or independent Manager forwarding to registered sessions. It no longer depicts Pi Web as the upstream hop to Manager.

## Issues introduced by the fix diffs

### Critical (Must Fix)

None found within the scoped review.

### Important (Should Fix)

None found within the scoped review. I1 and I2 are closed.

### Minor (Nice to Have)

None newly identified within the scoped review. M1, M2 and the phone-diagram correction are closed.

## Plan compliance and evidence limitations

The fixes close the prior review's cache/package stability and direct-child isolation objections without expanding the extraction phase. The manifest continues to bind shipped executable/source inputs and outputs, intentionally not checkout-only toolchain/configuration; this is source/distribution consistency, not a reproducible-build attestation. Only the three adapted migration target hashes were refreshed; immutable source provenance remains unchanged.

The implementer's `final-fix-report.md` supplies the focused RED/GREEN results described above and fresh Manager typecheck/build/verifier evidence. The controller's current [validation record:112](/home/fate/gitproject/codex_project_v2/pi-manager/docs/validation/2026-10-26-independent-packages.md:112) additionally records:

- Both final distribution verifiers passing, 255 migration target hashes matching with zero mismatches, and all 18 existing cache hashes unchanged.
- Post-fix two-real-Pi registration/exit/Manager restart/re-registration/revoke: 1/1 passed. Manager-unset direct download: 1 passed and 1 visible, actionable Manager-route skip. The supplied refreshed cross-project TAP logs agree with these counts.
- Matching-final-build zero-Pi API and actual desktop/mobile-browser checks: no page JavaScript errors or horizontal overflow, screenshots inspected by the controller; protocol contract 7/7 passed; test-owned processes cleaned up.
- Final Manager fingerprint `f2de543148aae1627dfb104aa7e2f33ec24aa6b8e1fd65b90a2fc231632a4ceb`, source count 73. Web remains on its existing build fingerprint because its fixes are documentation-only.

These executions and browser observations are attributed to the implementer/controller, not independently rerun by this reviewer. Log-to-build association follows the controller's validation record; the TAP files alone are not an immutable build attestation.

The worker's unisolated Pi `--help` near-miss is explicitly retained: an attempted host trust-lock creation was stopped by `EROFS`, with no created/modified host file reported; the corrected isolated invocation passed. This is not evidence that arbitrary help commands are state-free. No extra actual-state operation is inferred, and this review did not inspect host configuration. The earlier documented 16-byte Hub test configuration incident is unchanged.

The original 2,000-rotation registry case still has its documented 60-second timeout, reproduced on exact original `27326a8` (7 passes / 1 timeout). It was not selected in this fix wave and remains a baseline acceptance gap, not green evidence or a demonstrated extraction regression. Broad/full Gate, browser and real-backend aggregates, Docker/native lifecycle, real-phone/public migration, complete new MCP and unified-service acceptance are not established by these focused results. No deployment or production migration is claimed.

## Recommendations

No additional code fix is requested by this scoped re-review. Retain the validation record, near-miss disclosure, and baseline/unrun limitations in the handoff; do not relabel the extraction review pass as completion of later service/backend/MCP phases. Any integration, publication or deployment remains a separate authorized action.

## Assessment

**Combined review outcome: PASS — all five requested finding dispositions are ADDRESSED; no remaining scoped blocker.** The reviewed fixes and supplied focused evidence resolve the prior whole-branch findings while preserving the intended independent-package boundary. Ready for the extraction-phase local handoff, subject to the explicitly retained evidence limitations; this report does not authorize or perform merge/push/production actions.

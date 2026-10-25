# SDD ledger — plan: docs/superpowers/plans/2026-10-26-independent-packages.md

User approved the written architectural design on 2026-10-26. Plan implements the independently testable extraction phase; later native/MCP/control features are not claimed by this phase.

## Preflight

| Tasks | Producer / consumer | Result |
| --- | --- | --- |
| 1 | Package isolation tests / copied sources and CLI | Coherent: fail before implementation, assert detached CLI execution and private state. |
| 2 | Web-only fixture / actual manifest and package | Coherent: preserve security verification while removing manager build ownership. |
| 3 | Actual distributions / review and acceptance | Coherent: test outcomes distinguished from copied historical results. |
| 1, 2 | Migration inventory / tracked source removals | Task 1 must land first; source snapshot is immutable, no loss of manager/hybrid tests. |
| 1, 3 | Manager build and metadata / standalone validation | Detached CLI must not require Web source or personal configuration. |
| 2, 3 | Clean Web package / compatibility check | Retain optional registration adapters and protocol version; no production install. |

Baseline Manager f8a6b64; Web v1 74021fc. Existing unrelated Web .learnings and original main host-review note remain untouched. Original just check has two known e2e formatting/import errors, 36 warnings, 7 infos; no green baseline claim.

## Task 1

BASE: f8a6b64. Awaiting implementer.

Implementer: 01a173e3-65f7-7ed0-b969-6f3214417252 (gpt-5.6-sol/high), report task-1-report.md.

Controller validation: ordinary listener tests fail EPERM. A narrowly approved elevated temporary loopback test passed. Fresh baseline elevated Web subset (history/revision/versions/metadata/path) passed 69/69; this is pre-extraction evidence, not final acceptance. Agent notified to request similarly scoped ephemeral listener tests rather than automatically skip.

Controller sidecar: official MCP SDK research saved separately in docs/research/2026-10-26-mcp-interface.md; no runtime dependency installed. Only controller edits that path and ledger during Task 1.

Controller additional sidecar: native Pi RPC notes saved to docs/research/2026-10-26-native-pi-lifecycle.md (installed dev Pi 1.1.0). A read-only Node script exercised explicit generation IDs and canonical interaction serialization against each tree: 16 assertions passed, with original Web module-type warning. This is protocol fixture compatibility only, not real Pi registration or E2E. Written-spec headers now record user's approval; source/protocol extraction remains worker-owned.

Controller requested bounded partial report after extended validation. Implementer reported no current process/session and no task commit. Resume requested only inventory refresh, final build/dist, package inspection, detached smoke and commit; no broad reruns. Existing report says Gate offline 320 tests (8 skips), runtime49 (4 skips), socket runner anomaly not accepted as pass.

Safety finding before finalization: env-selection package test did not isolate HOME against regressed old CLI. RED report mentioned actual /home/fate/.pi/web-hub/config.json. Metadata-only stat found a size16 mode600 file born/modified 2026-10-26 00:57:44.120090672+08:00. Contents not read; no cleanup authorized/performed. Worker asked to identify its own command evidence and isolate all fallback paths before further package runs. User informed; do not claim no host files touched until reconciled.

Task1 implementation commit 4040b04. Final report reconciles incident: initial RED init used exclusive wx create and succeeded at real fallback path; expected deterministic config is16 bytes, expected hash documented but real file not read/hashed. Corrected init tests use temporary HOME. Host file remains untouched; user informed of creation/no overwrite.

Controller independent hash check:254 source/target entries,37 adapted,0 mismatches against immutable27326a8. Default restricted Node child failed spawnSync git EPERM; narrow read-only escalation passed. No host-state reads/writes in that check.

Controller zero-Pi evidence: own random-loopback CLI+temporary config, empty API, real Chromium desktop1440x1000/mobile390x844, no JS errors or overflow; inspected screenshots build b5d34855. Own process/profile stopped. Direct CLI socket test file11/11; no whole socket-suite claim.

Task1 reviewer:01a17419-4b5b-7fe2-8e7e-7c38103ca751 (gpt-5.6-sol/high), review-task-1.diff f8a6b64..4040b04. Named additional risks sent: aggregated runner reporting and packed manifest/runtime provider closure. No Task2 source removal until Task1 reviewed.

Controller drafted next service-phase plan independently; it remains explicitly unimplemented and does not authorize production switching.

Task1 initial review: spec FAIL/quality changes required. Four findings: packed probe provider omitted; packed verifier depends on absent checkout files; socket helper fallback HOME/config isolation; README future capability ambiguity. Fix round1 dispatched to original implementer with focused tarball/helper tests and rebuilt manifest/inventory; no broad reruns. Socket aggregate remains unproven environment/runner limitation, not asserted product failure.

Task1 fix round1 implementation44abb46: actual tarball verifier/probe closure5/5, helper-env1/1, direct CLI socket11/11, fresh build/dist passed. Inventory schema2:254 mappings/38 adapted/4 dispositions,0 mismatches. Controller independently reran final manifest verifier exit0. Scoped reviewer01a1742f-7580-7fe3-a2b2-8331b965edd1 (gpt-5.6-sol/medium), review-task-1-fix-1.diff4040b04..44abb46. No broad suite reruns; controller docs/test remain unstaged.

Task1: fix round1/5 (4 original findings addressed,0 open in fix diff;4040b04..44abb46). Scoped review PASS; installed-source manifest explicitly does not attest checkout toolchain/lock reproducibility.

Controller confirmed remaining Global Constraint gap outside prior fix: direct init spawns in tests/socket/hub-cli.test.ts still inherit real HOME. Narrow fix round2 dispatched to original implementer, only per-test child env isolation+focused guard/CLI test+inventory/report. No need rebuild shipped code or rerun broad suites. Task1 not yet marked complete.

Task1: fix round2/5 (remaining direct-child isolation addressed,0 open;44abb46..1a8b9fb). Reviewer01a17438-e167-72b0-bb87-63b1a7ca045d (gpt-5.6-sol/medium) PASS: actual scoped envs, meaningful unknown-command fallback regression, exact inventory hash.

Task 1: complete (commits f8a6b64..1a8b9fb, review clean). Socket aggregate/full Gate-socket gaps remain explicitly unclaimed; not requirements to deploy because this phase does not deploy.

## Task 2

BASE74021fc on Web v1. Brief includes migration dispositions, independent Manager env, preservation of build identity assertions, and temporary HOME requirements for all harnesses. Manager source/inventory read-only. No production mutation.

Implementer01a1743b-5161-7713-8897-6f8aecc44896 (gpt-5.6-sol/high), task-2-report.md. Controller owns Manager repo.

Controller commit1277601: approved boundary/docs research, explicit next-phase plan (not implemented), protocol contract test, actual final-build browser evidence. Fresh contract7/7 and Manager dist verifier exit0. Final browser build67ef73c7, desktop1440x1000/mobile390x844 both inspected, no overflow/JS errors, own processes cleaned. No production resource touched. Task2 source cleanup still implementer-owned/in progress.

Controller Task3 sidecar: running previously unexecuted10 Manager socket files individually (CLI file excluded because already fresh11/11). Explicit temporary HOME/both vars/offline, only own loopback/services; no Docker. Diagnostic driver/logs under .tmp/validation/socket-files. Two concrete fixture relocation bugs: tests/fixtures/hub-gate-management.py and hub-gate-launches.py still use integrations/runtime-updater/gate, causing ModuleNotFoundError before real Gate fixture startup. Record for final review/fix wave; do not silently accept. Bounded-registry2000-rotation stress case hit original60000ms timeout (7 pass/1 cancelled); unchanged source/performance cause not yet established, not a pass and not automatically blamed on code. Other results pending. Web worker notified not to duplicate or change Manager.

Ruling: allow Task2 implementer a minimal Manager companion change for the newly discovered manager-owned tests/interaction-page.test.ts plus migration inventory — the approved ownership boundary outweighs the plan's read-only inventory convenience; preserve the immutable original test, adapt only its protocol import, run it in Manager and typecheck there, then remove the original from Web. Cost if wrong: test-ownership rework, no runtime/deployment change. Do not leave Web default tests importing Manager source or adding blanket skips. Other Manager code remains read-only; two fixture-path bugs stay reserved for final fix wave.

Same ownership ruling scope narrowed/updated for efficiency: Task2 Manager companion also fixes exactly the2 confirmed stale Python fixture roots and mapped target hashes, then runs only their2 socket files. No production Manager source changes, no full suite/stress rerun. This replaces reserving those fixture fixes for a separate final implementation worker; all remaining final-review findings still follow the review loop.

Task2 companion commits d9f98ec and45b139c: interaction-page40 passed/1 original Chromium opt-in skip; both relocated Gate socket files passed1/1 each. Interim reviewer01a17451-d672-7482-9c41-4ea0380ce9c3 PASS for Manager companion specification/quality,255 mappings/4 dispositions checked; overall Task2 verdict deferred until full Web diff/report. Reviewer seat retained for that follow-up.

Controller reran protocol contract against the cleaned Web source tree:7/7 passed, no network/listener or real configuration use. Current Web tracked frontend/extension diff is empty; distribution and E2E harness edits remain task-owned. Prepared isolated cross-project driver for final two-real-Pi registration/restart plus no-Manager direct download, waiting for stable Web build before executing.

Final-check finding: Manager verify:dist now rejects18 new ignored gate/gate/__pycache__/*.pyc generated during focused socket tests. Independent source-inventory diff shows only those bytecode additions, no changed runtime source. Walker currently includes arbitrary cache files under gate/gate. Do not rebuild to bless caches or delete user files; hand this concrete package/cache-stability defect to final review and one bounded fix wave. Task2 implementer notified, no overlapping production edit authorized.

Final reviewer01a1745a-e641-7a41-bdbb-fc252f5eff72 (gpt-6-astra/high) started read-only Manager architectural/package half using review-final-manager.diff f8a6b64..45b139c. Full verdict waits for final Web diff/Task2 report. No duplicate suites or services requested; final review receives documented ownership ruling, cache failure and original stress-baseline gap.

Controller final real-Pi cross-project driver completed exit0: session-hub integration1/1 using explicit Manager CLI; validates2real Pi,independent metadata,exit/restart/re-registration/revoke. No-Manager direct file-download1pass/1visible Manager skip with actionable reason. Temporary HOME/both vars,synthetic provider,no Docker/production; own state/processes cleaned. Logs .tmp/validation/cross-project/. Web worker told rebuild read window finished. Cache-stability package issue remains pending final fix, not hidden by E2E success.

Task2 implementation eef18b555dbe99f31de9408299751af221daab7b on Web v1 complete. Report ready:49dist,2install lifecycle,443/444unit(1originalopt-in skip),types/build/dist,productiononlyinstall/update/tarball pass.169deletions168inventory+1generatedbundle. Controller independently verified final Web dist exit0 and no tracked worktree changes. Implementer closed after report, can resume for task-review fixes. Task2 reviewer same seat now reviewing review-task-2-web.diff74021fc..eef18b5 plus full report; final reviewer same seat completing combined review.

Final Manager provisional findings in final-review.md: I1 cache identity+package leak; I2 four state-capable CLI child envs in state-budget/bounded-registry; M1 installed help command/doc mismatch. Prepared final-fix-brief.md but not dispatched until combined Web findings. No self-fixes by controller; controller docs/source-provenance updated only to actual committed Web state.

Controller archived completed Task1 reports/reviews and Task2 implementation report as exact new copies under docs/validation/independent-packages/. Original tracked/ignored SDD evidence preserved; no destructive cleanup. Final task reviews/fix evidence/ledger will be archived after completion so handoff does not depend on ignored scratch paths.

Final combined review complete:0Critical,2Important(I1caches,I2fourCLIenv),2Minor(M1help,M2WebREADMElocalv1install). No additional Important Web runtime/distribution finding. Final reviewer independently confirmed168mappeddeletions+1generated,164source/731outputhashes,781filepackage without Manager/caches/symlinks. Final-fix-brief updated with all findings; Task2 review pending before dispatch. Controller evidence commit7ef3490; archive helper's extra EOF newline subsequently removed,5report archives now byte-identical and diffcheck clean; those tiny controller formatting corrections remain for final docs commit.

Task 2: complete (Web74021fc..eef18b5; Manager1277601..45b139c companion; spec/quality PASS with2minorREADME corrections). Both minors folded into final fix wave (local unpublishedv1 install/update clarity and phone topology). No open task-level Important/Critical. Final fix BASEManager7ef3490/Webeef18b5, full brief prepared. No branch publishing implied by README fix.

Final fix implementer01a17469-bc9b-7162-9d9a-8ac65ebc343f (gpt-5.6-sol/high), brief final-fix-brief.md/report final-fix-report.md. ONE combined fix dispatch, no additional features/broad reruns. Controller retains post-build zeroPi visual+realPi contract smoke. Final reviewer can resume01a1745a-e641-7a41-bdbb-fc252f5eff72 for exactly one scoped fix re-review.

Final fix wave complete Manager8dc43d3/ Web2838497. Report10cachepack+7packagehelp+12statebudget+1namedboundedrevoke+2envguards passed;type/build/distpass;18originalcaches untouched. Near-miss unisolatedPihelp hitEROFS at trust.json.lock, nofilecreated; corrected isolatedhelp passed and incident documented. Controller freshbothverifierspass,255targethashesmatch,18cachehashesunchanged;finalrealPi integration1pass and noManagerdownload1pass/1skip; actualzeroPi desktop/mobile on matchingf2de5431 build passed and bothscreenshots inspected; finalprotocol7/7. Own processes/state cleaned, no production/Docker.

Scoped final re-review resumed same reviewer01a1745a-e641-7a41-bdbb-fc252f5eff72; packages review-final-fix-manager.diff7ef3490..8dc43d3 and review-final-fix-web.diffeef18b5..2838497; report final-re-review.md pending. This is the one final fix re-review, not a second whole-branch review.

Final scoped re-review PASS: I1,I2,M1,M2 and phone topology ADDRESSED;0newCritical/Important/Minor. No residual parked finding. Originalstress60s timeout and unrunoptional/fullGate socket/Docker/native/MCP acceptance remain explicit limits, not newgreen claims.

Task 3: complete (Managercode8dc43d3/Web2838497; finalreview+scopedfixreview clean; finalmatchingbuildf2de5431 verified). Permanent evidence under docs/validation/independent-packages/. Archive this ledger and every Markdown report/brief byte-for-byte before removing this plan's generated scratch directory; source review diffs are reproducible from the recorded Git ranges. Both local branches/worktrees and all unrelated user content preserved. No push/mainmerge/production deployment. The initial16byte hosttestconfig remains untouched, not silently cleaned.

Ruling: retain this plan's original SDD workspace and permanent archives after safety review rejected recursive cleanup — no workaround deletion or expanded authorization; restore the two individually moved scratch reports from byte-identical archives so all records remain available. Cost if wrong: duplicate local review records/disk usage only, no runtime/deployment impact. Earlier cleanup intention is superseded;14Markdown copies were verified byte-identical before cleanup, no user data removed.

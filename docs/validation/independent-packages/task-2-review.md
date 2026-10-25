# Task 2 combined specification and quality review

Date: 2026-10-26  
Web range: `74021fc9ffbb35ee631f99ae09ef7adcf23748b7..eef18b555dbe99f31de9408299751af221daab7b`  
Manager companion range: `1277601..45b139c`  
Reviewed inputs: `task-2-brief.md`, the approved independent-packages plan and ledger, `task-2-report.md`, `review-task-2-web.diff`, and the previously reviewed Manager companion diff/report

## Verdicts

- **Specification verdict: PASS with two minor README corrections requested.** The implementation satisfies the bounded Task 2 package-separation, integration-retention, accounting, and validation requirements. No Important Web specification defect was found.
- **Quality verdict: PASS with two minor README corrections requested.** The source, tests, distribution guards, and integration harness changes are coherent and narrowly scoped. No Important Web code-quality defect was found.
- **Overall Task 2 status:** the bounded implementation is acceptable for the planned single documentation/finalization fix wave. This verdict does not absorb or resolve the separately reserved whole-branch Manager cache-stability, direct-environment, or help findings.

## Findings

### [Minor] README installation commands do not select the reviewed unpublished `v1` product

References: Web `README.md:36` and `README.md:119`.

The reviewed Web commit is on the literal `v1` branch, and the README states that this fork is not published as the upstream npm package. The public command `pi install git:github.com/swordfate3/pi-web-ui` selects the repository's default Git revision rather than explicitly selecting the reviewed `v1` branch or commit. A user following the README can therefore install a different product state from the one documented and validated here; the update example has the same ambiguity.

The final documentation wave should use an explicit source for the actually available reviewed product, such as the intended `@v1` branch or an exact commit while it remains unpublished, and keep the install/update source strings consistent.

### [Minor] Phone-access diagram depicts Manager as downstream of a single Pi Web instead of an alternate proxy target

Reference: Web `README.md:135-136`.

The surrounding prose correctly distinguishes single-session Web from the independent multi-session Manager, but the diagram visually reads as:

`phone -> gateway/proxy -> single Pi Web -> optional Manager -> Pis`

That is not the deployment relationship exercised by the explicit Manager integration. The proxy should branch to either a single Pi Web endpoint or the independent Manager, with Manager then routing to registered Pi Web sessions. The current drawing can lead an operator to put Manager behind one Pi Web process or misunderstand which endpoint the gateway exposes.

The final documentation wave should draw the two alternatives explicitly, for example `proxy -> single Pi Web` and `proxy -> Manager -> registered Pi Web sessions`.

No other Task 2 Web findings were identified.

## Specification assessment

### Web-only package boundary

- Web `package.json:20-27` retains the Pi extension entry `./extensions/mirror-server.ts` and `./interactions/v1` export.
- Web `package.json` and the root `package-lock.json` no longer declare a `bin`; the package file list retains the extension, adapters, remote-access material, Web dist, and documentation without Manager source/runtime paths.
- The committed tree contains no tracked `bin/`, `hub/`, `integrations/runtime-updater/`, `dist/hub/`, `vite.hub.config.ts`, or Web copy of `tests/interaction-page.test.ts`.
- The current build manifest contains 164 source records and 731 output records, with matching declared counts, `dist/index.html` present, and no Manager executable/source/runtime path in either inventory.
- The source/output policy in `scripts/web-dist.mjs:10-47` now requires Web output and the retained Web/extension inputs without requiring Hub source or a Hub bundle. Its existing path normalization, symlink rejection, fixed-policy validation, hash verification, source-mutation rejection, and HTML asset-reference checks remain in force.

### Preserved Web implementation and interfaces

- The Web range contains no modifications under `extensions/`, `src/`, `public/`, `integrations/adapters/`, or `integrations/check-adapter.mjs`; those retained frontend, transport, interaction-security, registration/control, and remote-access implementations are byte-unchanged in this task.
- `tsconfig.connection.json` removes deleted Manager-owned tests and Hub source while retaining the Web interaction, registration, transport, file, history, remote-access, and security coverage.
- The split does not repurpose `PI_E2E_RUNTIME_DIR`; `e2e/harness/pi-process.ts:39-41` continues to select only the Web runtime root.

### Explicit independent Manager integration

- `e2e/harness/hub-cli.ts:40-48` accepts only an explicit option or `PI_E2E_MANAGER_DIR`, errors when absent, resolves that root, and invokes only `dist/hub/pi-web-hub.mjs`. It does not import Manager source or fall back to the Web checkout or a sibling repository.
- `e2e/harness/hub-cli.ts:49-63` and `e2e/harness/pi-process.ts:42-55,103-120` isolate `HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG` beneath per-harness temporary roots.
- `e2e/session-hub.integration.ts:62-83` checks Web identity against the selected Web runtime manifest and Manager identity against the explicitly selected Manager manifest; the former shared-build assumption was not removed or weakened.
- Manager-only Node and browser cases use visible, actionable skip reasons when `PI_E2E_MANAGER_DIR` is absent. Mixed download/upload and browser routes preserve direct rows instead of filtering them away; Web `e2e/file-download.integration.ts:15-23` is a representative direct/Manager split.
- Web `package.json:34-39` and `.github/workflows/ci.yml:61-76` keep standalone Web integration as the default and document Manager-backed integration as an explicit separately configured invocation.

### Removal and test-ownership accounting

- The Web diff contains 194 changed paths: 25 modifications and 169 tracked deletions.
- Independent static accounting found 168 source/build/test deletions owned by the Manager migration ledger. Of those, 166 are ordinary inventory entries and two (`hub/package.json` and `vite.hub.config.ts`) are explicit replacement dispositions. All immutable baseline blob SHA-256 values checked against those records without mismatch.
- The remaining deletion is the generated output `dist/hub/pi-web-hub.mjs`, matching the report's 168 inventory-owned removals plus one rebuilt-output removal.
- The previously omitted `tests/interaction-page.test.ts` was migrated into Manager before its Web copy was removed. Its Manager target is the immutable 707-line original with only the protocol import adapted and exact source/target hashes recorded.
- Manager-only and mixed legacy coverage remains represented by Manager inventory targets/archive or explicit cross-project harnesses; no default Web test imports Manager source.

### Distribution, installation, and integrity guards

- `tests/web-dist.test.mjs` adds the required Web-only fixture regression, performs a real offline pack dry run, requires the extension, and rejects Manager executable/source/build paths.
- Existing output tamper, source tamper, fixed-policy, symlink, traversal, manifest-shape, hash, install-mode, and HTML asset-reference assertions remain present; the Hub requirement was removed rather than replacing these checks with package-text matching.
- `tests/git-install-lifecycle.test.mjs:10-55` preserves source-mutation rejection and package-content assertions while changing the expected product from Web-plus-Hub to Web-only.
- `scripts/test-git-install.mjs:39-67` isolates real Pi install/update state and both legacy/new configuration fallbacks. Its production assertions require only `ws`, reject Manager artifacts and stale dist files, exercise eight source-mutation installation failures, and validate the packed consumer.

### Documentation and status boundaries

- Apart from the two minor findings above, the README clearly distinguishes Pi, the Web extension, and the independent Manager; states that local single-session use needs no Manager; documents optional registration variables; separates Web and Manager update lifecycles; and warns that this extraction did not modify production services.
- `docs/unit-tests.md` records the Manager ownership transfer and explicit cross-project CLI boundary without claiming migrated Manager tests as Web defaults.
- `docs/development-log.md` records the exact 168-plus-one deletion accounting, retained adapters, explicit Manager environment, verification summaries, and unrun production scope.
- Historical `docs/hub.md` and validation records are explicitly treated as provenance rather than current Web package instructions.

## Evidence assessment

The reviewer did not rerun suites, listeners, Docker, network operations, or production processes. The following execution evidence is accepted from the completed Task 2 report and controller records and is consistent with the reviewed source and harnesses.

### Manager companion evidence

- Manager typecheck: reported pass.
- Migrated interaction-page test: 41 total, 40 passed, 0 failed, 1 existing opt-in Chromium skip.
- Corrected Gate management fixture socket test: 1/1 passed.
- Corrected Gate launches fixture socket test: 1/1 passed.
- The prior Manager companion specification and quality review found no scoped defect; its verdict is incorporated here without rerunning it.

### Web evidence

- Distribution regression: 49/49 passed after the recorded pre-change RED.
- TypeScript root check and `tsconfig.connection.json` check: reported pass.
- Broad Web unit run: 54 files, 444 tests, 443 passed, 0 failed/cancelled, 1 existing physical-1-GiB opt-in skip.
- Git-install lifecycle: 2/2 passed after the required rebuilt manifest.
- Production-only Git install/update and tarball consumer lifecycle: reported pass, including stale-file removal, eight source-mutation installation rejections, one production dependency, Manager-artifact absence, and no lock rewrite.
- Standalone pack inspection: reported pass with 781 files and no forbidden Manager paths.
- Manager-absent focused integration: one visible actionable skip rather than silent omission.

### Controller-owned cross-project evidence

- Explicit independent Manager `session-hub.integration.ts`: 1/1 passed with two real Pi processes, independent Web/Manager identities, exit/restart fencing, renewal, and revoke behavior.
- No-Manager direct download: one direct row passed and one Manager row visibly skipped with the actionable `PI_E2E_MANAGER_DIR` reason.
- The cleaned-tree protocol contract check: 7/7 passed.

### Lint and unrun boundaries

- The report records a scoped Biome check over 14 changed code/configuration files with no diagnostics.
- This review does **not** claim a fresh green global lint run. The pre-Task-2 baseline's two errors were in the now-migrated/removed Manager-owned `e2e/web-interactions.browser.ts`; the report correctly avoids converting that historical baseline into a global-clean claim.
- Full browser aggregation, real phone, production Manager, Docker/Gate/runtime updater, deployment, and production service validation remain unrun or externally owned as stated in the report.

## Explicit exclusions and reserved findings

- The Manager whole-branch cache inclusion, four direct environment-isolation findings, and help behavior are separately reserved for the final Manager fix/review wave. They are not duplicated as Task 2 Web findings because no new Web interaction with them was found.
- The immutable-source 2,000-rotation timeout is recorded as baseline behavior, not accepted as a passing stress result and not attributed to this extraction.
- No general historical-document audit, Task 1 production/manifest redesign, production switch, deployment review, or unrelated repository cleanup was performed.

## Review method and repository state

- The supplied Web diff was consumed once; generated dist/lock churn and byte-preserved deletions were then checked through the resulting tree, manifest, migration records, and targeted baseline hashes.
- No subagents were used. No suites, listeners, Docker, network access, host configuration changes, or Git mutations were performed by this reviewer.
- Web HEAD was `eef18b555dbe99f31de9408299751af221daab7b` on branch `v1`; the only Web status entry observed was the preserved user-owned untracked `.learnings/` directory.

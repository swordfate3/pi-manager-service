# Independent Web and Manager Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete phase 2 of the approved design: independently buildable/distributable Pi Manager sources and a session-only Web v1 package, without switching production.

**Architecture:** Preserve the existing Hub and Gate behavior while moving their ownership into an independent manager repository. Keep versioned Pi-side transport adapters in the Web extension; copied protocol definitions carry provenance and compatibility coverage. Preserve mixed integration tests outside the normal Web package rather than losing their coverage.

**Tech Stack:** Node >=22.19.0, existing TypeScript/Vite toolchain, ws, Python standard-library Gate/runtime implementation. No new protocol SDK is required for this extraction phase.

**Spec:** `docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md`, especially sections 3, 4, 7 and phase 2 of section 8.

**Execution outcome (2026-10-26):** Tasks 1–3 completed for the independent-package phase. Final Manager code `8dc43d3`, Web `2838497`; final scoped review passed. Validation and all task reports are archived under `docs/validation/independent-packages/`. The baseline-reproduced stress timeout and unexecuted optional/backend suites remain explicit limitations; no production switch, main merge, push, MCP or complete unified-manager implementation is implied.

## Global Constraints

- 管理器先启动，随后才启动 Pi；零个 Pi 运行时也能打开管理页面。
- 本轮不更改旧部署和历史分支。
- 管理器不通过导入相邻 Web 源码目录获取类型。
- 不复制原仓库 `.git`、`node_modules`、构建缓存、生产配置、SSH 私钥、Token、环境变量文件、用户会话或 Docker 数据卷。
- 后端不支持的功能显示为不可用，不能用 Docker 后端的验收替代原生后端。
- 本计划仅完成拆包，不声称已经实现新的原生后端、MCP 服务或扩展管理任务；后续阶段按各自计划实现并验收。
- New code and tests use apply_patch. Exact tracked-file copying and mechanical path rewrites may use a bounded bulk migration. No deletion of untracked/user files.
- Every test subprocess that may initialize state must isolate HOME and both old/new configuration environment paths under its own temporary root, even when an explicit --config is also supplied. A deliberately regressed CLI must never be able to fall back to real user state.
- Web root: `/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals`, branch `v1`; extraction source is immutable `27326a8cbea8331cac29e6b6b41f98f2b69fa05b`.
- Manager root: `/home/fate/gitproject/codex_project_v2/pi-manager`, branch `codex/bootstrap`. No push, publishing, production restart or production Docker access.

## Task 1: Independently buildable Manager distribution

**Files:** Create manager-owned `hub/`, `bin/`, `protocol/`, `gate/`, `runtime/`, `scripts/`, `tests/`, package metadata/lock, TypeScript/build configuration, LICENSE, and migration inventory. Read only the Web snapshot; do not alter Web files in this task.

**Interfaces:** Preserve `startHub(config, options)`, private registration protocol and existing task/API contracts. Produce `dist/hub/pi-web-hub.mjs` for transition tests and a `pi-manager` package bin pointing to the bundled CLI. Existing Hub CLI commands remain usable; a CLI alias is not a new process supervisor.

- [x] Write package isolation tests first. The real CLI must initialize private state without Pi; detached bundle must execute with only declared runtime dependencies; invalid arguments must fail without printing secret input.

```js
const result = spawnSync(process.execPath,
  [cli, 'init', '--config', path.join(temp, 'config.json'), '--port', '0'],
  {encoding: 'utf8'});
assert.equal(result.status, 0, result.stderr);
assert.equal(statSync(path.join(temp, 'config.json')).mode & 0o077, 0);
```

- [x] Run `node --test tests/manager-package.test.mjs` and observe failure from the missing distributable. Record RED output.
- [x] Copy exact tracked sources and LICENSE from the immutable snapshot; include Gate and runtime tests. Compute a source inventory with original path, target path and SHA-256. Preserve hybrid Web/Hub integration fixtures under `integration-tests/legacy-web/` outside default tests, with an explicit dependency/setup guide; do not silently drop them or label them passed.
- [x] Move required protocol helpers out of extension ownership into `protocol/`; update internal imports. Copy only the dependency closure needed by the manager and its tests; no imports into a sibling checkout. Keep the old protocol fields and security checks unchanged.
- [x] Add `package.json` with local project name `@swordfate/pi-manager`, `private: true`, `bin.pi-manager`, production dependency ws, and build/check/test scripts. Do not declare `pi.extensions`. Use the installed toolchain for development only; a local node_modules link must not become a shipped dependency.
- [x] Build the Hub bundle with independent source/output consistency checks and strict private-file behavior. Preserve embedded version/build metadata using manager metadata; preserve old API field names for protocol compatibility. A build must not depend on Web frontend files.
- [x] Migrate applicable tests, fixing real paths rather than weakening assertions. Default test enumeration includes all migrated manager unit tests; socket tests remain runnable separately if this environment disallows binding.
- [x] Run build, types, distribution verification, package tests, offline manager tests, Gate offline tests and `npm pack --dry-run --ignore-scripts --json`. Test a detached temporary copy with only declared dependencies; classify any socket/permission/network blockage explicitly.
- [x] Update README with actual working CLI usage and outstanding capabilities; commit only manager task files. Write report with RED/GREEN commands, migrated test inventory, skipped/blocked checks and changed paths.

## Task 2: Clean Web v1 product and retain integrations

**Files:** Web package/lock, build scripts, `scripts/web-dist.mjs`, installation tests, `tests/web-dist.test.mjs`, type coverage, Web README/docs, manager-only directories/tests, tracked dist. Manager extraction inventory is consumed read-only.

**Interfaces:** Keep Pi extension entry `extensions/mirror-server.ts` and `./interactions/v1`. Keep optional registration/control adapters and their current wire protocol. Produce Web package with no Hub executable or Gate/runtime implementation.

- [x] Add/run a real distribution regression before changes: Web source/asset verification succeeds when there is no manager source/build output, and a packed Web package contains its extension but no manager executable.

```js
const manifest = await createManifest(webOnlyFixture);
assert.ok(manifest.outputs.files.some(file => file.path === 'index.html'));
await writeManifest(webOnlyFixture);
await verifyManifest(webOnlyFixture);
```

- [x] First ensure Task 1's exact inventory accounts for every manager-only file being removed and every mixed integration test. Use tracked-file deletions only, preserving user untracked content and historic branches.
- [x] Remove Hub bin/files/build config and runtime-updater implementation from Web. Update source manifest and lock metadata. Retain optional Pi adapters, remote-access helper behavior and all session interaction security checks; no blanket search-and-delete of `hub` strings.
- [x] Move manager-owned tests according to inventory. Keep mixed Web behavior coverage either adapted to an explicit installed-manager integration harness or in the preserved cross-project integration suite, not dangling in default Web tests. Record exact test movements.
- [x] The Web E2E Hub harness accepts explicit `PI_E2E_MANAGER_DIR` pointing to an independently installed/built manager root; it never imports manager sources. When absent, manager-only integration cases must either be outside default Web selection or visibly marked skipped with an actionable reason; direct single-session cases must still run. CI documents/runs the optional integration separately rather than assuming Web ships a Hub. Do not silently omit cases by filtering an array without a skip result.
- [x] Update Git-install/pack tests for Web-only installation, source mutation rejection and integrity verification. Do not replace security assertions with superficial package-text matching.
- [x] Build Web, verify dist, run both type checks and Web unit tests; validate production-only package preparation in an isolated temporary copy. Update only changed formatting; report original unrelated lint failures separately.
- [x] Document independent Web installation and optional Manager connection. Update development log with actual status and commit the clean v1 task.

## Task 3: Independent review and phase handoff

**Files:** `docs/validation/2026-10-26-independent-packages.md`, source provenance, README status and ledger. Read both project diffs and test outputs.

**Interfaces:** Builds work independently without sibling sources; no production migration is implied. A working Hub alias and copied Gate are not counted as a completed unified manager/MCP implementation.

- [x] Obtain task reviews for Tasks 1 and 2 and scoped re-review any fixes. Run cross-project protocol compatibility tests against isolated copies; do not hardcode this user's source path in a distributable.
- [x] Verify zero-Pi startup using temporary config and an empty state directory, HTTP `/sessions/` and an empty sessions response if socket permission allows. Stop only the process created by this test.
- [x] Review both distributions for accidental credentials, symlinks to sibling sources, undeclared imports, wrong metadata and silently removed test coverage. Record findings and resolve correctness issues before a completion claim.
- [x] Record exactly which parts of approved design phases 3–5 remain. Prepare their next implementation plan after inspecting official MCP SDK/authentication docs; do not substitute stubs for missing backends or approval behavior.
- [x] Commit validation records, leave new branches local and old services unchanged. Report completed package separation and any blocked runtime acceptance without claiming all Manager features complete.

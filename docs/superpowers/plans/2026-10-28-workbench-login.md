# Workbench login implementation plan

> **For agentic workers:** Use executing-plans with disjoint sidecar implementation and final independent security review. User authorizes continuous design/development, no review pauses. No commits/push; preserve existing dirty worktree.

**Goal:** One login gate covering the complete workbench and chat chain with small durable storage.
**Architecture:** LocalStore owns SQLite and one-time migration, LocalAuth owns sessions, local-security owns cryptographic primitives, service owns boundaries/proxy, auth UI is separate from original workbench.
**Tech Stack:** Node22.19+, node:sqlite, crypto.scrypt, existing HTTP/ws, Chromium tests.
**Spec:** docs/superpowers/specs/2026-10-28-workbench-login-design.md

## Global constraints

- No extra DB/cache containers; do not touch production Aliyun/tunnel/Caddy or active Pi.
- Keep original five-volume pirun/workspace/screenshots/credentials behavior.
- No approval workflow, management code, or additional business restriction after login.
- Main owns store/service/launcher; sidecars own only security module/tests and auth UI/tests.

## Task 1: Store and migration

- [x] Add tests/local-store.test.ts: `LocalStore.open(root)`, migrate validated runs.json once with byte-identical backup, persist account/sessions/preferences/runs across close, reject corrupt migration, schema permissions, expired session cleanup.
- [x] Run RED: `node --import ./tests/register-ts.mjs --test tests/local-store.test.ts`.
- [x] Implement manager/local-store.ts, adapt launcher `open(config,policy,ready,store)` and `#save` using `store.saveRuns(records)`; sole SQLite writer.
- [x] Run GREEN and review no startup replay/dualwrite.

## Task 2: Authentication and boundaries

- [x] Sidecar TDD security primitives manager/local-security.ts/tests/local-security.test.ts (scrypt, strict cookies, throttle).
- [x] Main TDD manager/local-auth.ts with LocalStore; one-time setup CAS, session generation, current-password change/revocation.
- [x] Integration tests in tests/local-auth-service.test.ts for anonymous API/session/file/WS denial, CSRF and logout closure, HTTPS setup disabled, proxy credential stripping.
- [x] Integrate local-service and publicOrigin validation, preserve external top-level navigation exception for entry/login only.

## Task 3: UI and bounded caching

- [x] Sidecar TDD manager/local-auth-ui.ts/tests/local-auth-ui.test.ts for setup/login/account, fixed redirects, no browser token storage.
- [x] Main adds account link, 401 redirect, saved last workspace, directory TTL cache with fresh launch validation, static JS ETag and request timing.
- [x] Adapt existing service/browser fixtures to real account/session; no production auth bypass.

## Task 4: Recovery, verification and local deployment

- [x] Implement hidden terminal account reset/initialize in local CLI, document DB backups and single-gate behavior.
- [x] Run build/typecheck/dist/unit/package and focused serial Chromium tests with explicit browser executable.
- [x] Independent security review, fix confirmed findings; record evidence and residual boundaries in validation ledger.
- [x] Back up live files and DB; check active runs, deploy/restart only if idle; real local browser/anonymous HTTP smoke. Never change public chain this turn.

## Progress ledger

- Baseline: 35/35 original local service/UI tests PASS, real Chromium included (2026-10-28).
- Scope: existing feature worktree retained; no commits/rebase/clean, and no external deployment authorization inferred.
- Next: store RED/GREEN; security/UI sidecars running with disjoint files.
- Store: 3 RED→GREEN tests; validated byte-identical migration backup and no dualwrite; launcher now persists SQLite.
- Auth/UI: primitives, hidden-terminal recovery, local setup, secure HTTPS mode and all HTTP/WS gates implemented. Original desktop/mobile workbench regression preserved.
- Review: two confirmed P2 issues (shared-proxy password lockout and close-before101 WS orphan). Both received failing regression cases and fixes; narrow independent re-review requested. No findings parked.
- Latest integration checkpoint: 67/68 focused cases pass; transport sidecar refining late-handshake regression, which originally asserted no upstream connection ever rather than no leaked live connection. No deployment until this is resolved.
- Global first regression: 605 tests, 599 PASS/6 opt-in skips/0 FAIL. Package26/26 PASS. Build/typecheck PASS. Further final rerun follows remaining transport fix.
- FINAL: 69/69 focused including Chromium/real Hub fake-Pi transport; 614 global tests608PASS/6skip/0fail; package27PASS; build/distcheckPASS. Both security findings independently CLOSED, no parked findings.
- Delivered local-only idle upgrade with backup; live anonymous gate/mobile and desktop smoke PASS, original4containers unchanged. No default account created, no public changes, no commit/push. Full evidence: docs/validation/2026-10-28-workbench-login.md.

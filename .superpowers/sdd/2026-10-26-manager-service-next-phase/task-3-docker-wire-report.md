# Task 3 — bounded Docker executor wiring

Date: 2026-10-26. Base: `44fc687`, existing `codex/manager-service` worktree.

## Delivered scope

Only these implementation/test files are owned by this slice:

- `manager/config.ts` — executor configuration/types/imports only; no service configuration changes.
- `manager/api.ts`.
- `manager/executor/adapter.ts`.
- `manager/executor/engine.ts`.
- `manager/executor/main.ts`.
- `manager/executor/docker-adapter.ts` (new).
- `tests/manager-docker.test.ts` (new).
- This report.

No subagents, production mutations, real Docker operations, builds, push, merge, deployment, or edits to native adapter/backend, Docker backend/transport, MCP, public service, UI, package, or generated distribution files. Existing controller changes remain outside this commit. The scoped commit intentionally depends on the controller-owned Docker backend/transport, mock-daemon helper, `manager/errors.ts`, and native Web configuration type; those files are not staged by this slice.

## Behavior and interfaces

1. `ExecutorConfig.docker?: DockerBackendConfig | null` explicitly selects Docker; native and Docker are mutually exclusive. Existing profiles omitting Docker remain valid. Administrator configuration has exact-key, pinned-image/daemon, bounded-argument/timeout and path validation. Workspaces must reference the selected backend's named roots.
2. Allowed Docker roots cannot overlap authoritative task state, either IPC socket directory, the private Docker journal, daemon socket, package source, or configured protected roots. Journal/task directories cannot overlap. The adapter resolves the daemon socket before opening its backend and repeats policy validation, preventing a socket alias from hiding authority inside a workspace. The journal must have a canonical private directory, including canonical ancestors. Docker startup therefore requires the configured socket path to resolve; it does not connect to a real daemon during these tests.
3. `DockerTaskAdapter.open(config)` asynchronously opens its own backend ownership journal. It exports actions `create`, `stop`, and `start`; requests never accept image, mounts, paths, argv or caller-supplied requester identity. `start` is explicit restoration of the exact previously owned container, not replacement or adoption.
4. `TaskBackendAdapter.restore?(records: readonly TaskRecord[]): void | Promise<void>` is awaited by `TaskEngine.open` after stranded running tasks become unknown, before requests are served. Docker requester ownership comes from succeeded/unknown authoritative creates. Unknown records reserve names even when their backend identity is unusable. Native's controller-owned restore hook is called through the same interface without adopting PIDs.
5. Create reserves a name before its first asynchronous operation. A previously owned backend identity without a corresponding authoritative requester cannot be adopted by another create. Stop retains the reservation and home. Restart retains the original requester's stop/start authorization. Exact container IDs, labels, image and safety/mount checks remain the Docker backend's responsibility; the adapter does not infer requester ownership from labels.
6. `TaskBackendAdapter.resources` accepts synchronous arrays or promises. Optional `capabilities` describes only `native`, `docker`, and `isolation`; legacy fixture adapters default to unavailable. Real native construction reports `trusted-local-development`; Docker reports `fixed-container`. Enrollment and updates remain false. This is a fixed container profile, **not** proof of hardened host/process isolation.
7. `TaskSubmission` permits narrowly shaped `{ key, action: "stop" | "start", target }` alongside create. The controller must update the MCP action schema separately. Exact request/policy hashes, independent approval, CAS and fresh approval after reopen remain enforced.
8. Both `DockerOutcomeUnknownError` and controller-owned `ExecutionOutcomeUnknownError` persist terminal `unknown` with only `{ status: "execution-outcome-unknown" }`. Ordinary Docker operation errors persist generic `failed`. A lost create response returns the same unknown task on idempotent retry, sends no second mutation, and is not replayed after reopen. No exception messages, daemon payloads, container IDs, volume names or private paths are exposed in results.
9. Per controller follow-up, trusted administrator `native.web` accepts only absolute `extensionPath` / `hubConfigFile` and integer `port` from 1 through 65535. Existing provider handling is preserved. This config acceptance does not claim Web enrollment acceptance.

## Verification

TDD evidence:

- Explicit Docker config initially failed as an unknown config key; after implementation the config cases passed.
- Lifecycle/capability/ownership tests initially failed with unavailable Docker or incorrect fixture capabilities.
- Injected `ExecutionOutcomeUnknownError` initially persisted `failed`; after engine classification it persists `unknown`.
- Journal-ancestor and daemon-socket alias tests each initially admitted the unsafe path; after canonical-path protections both reject it.
- Valid `native.web` initially failed the native config allowlist; strict validation now accepts it and rejects malformed fields.

Commands run from this worktree:

```text
node --import ./tests/register-ts.mjs --test tests/manager-docker.test.ts
node --import ./tests/register-ts.mjs --test tests/*.test.ts
npm run typecheck
git diff --check
```

The final focused suite passed **19/19, zero failures and zero skips**, covering configuration, capabilities, real executor IPC, owner-scoped resources, create/stop/start across restart, cross-principal rejection, unknown create idempotency, ordinary Docker failures, approval/CAS, duplicate targets, policy/hash drift, path aliases, stranded recovery, identity tampering and writer-lock cleanup. The shared native-uncertainty test injects only the adapter execution fault; the engine/store are real. It checks persisted unknown state, reopens the store and engine, reopens the engine twice, rejects fresh approval/execution each time, and asserts that execution occurred exactly once.

The full source unit suite passed: **239 passed, 2 browser tests skipped, 0 failed (241 total)**. The shared-error reopen assertions were strengthened afterward and the focused suite rerun. No package/build/browser/real-daemon acceptance is claimed.

`git diff --check` passed. At the latest typecheck attempt, the sole failure was controller-owned `tests/manager-native-authority.test.ts:9` (`TS2352`): `createdAt` and `updatedAt` are numbers instead of the strings required by `TaskRecord`. This file was left untouched; the controller must fix the fixture and rerun typechecking before integration acceptance.

Tests required permission to listen on temporary Unix sockets because the default environment returned `EPERM`. Permission was used only for local temporary test fixtures, not a host Docker socket or production resources.

## Remaining acceptance / operational boundaries

- Controller retains MCP schema, public/admin/UI, packaging/distribution, and native real-Pi/Web/registration acceptance.
- No real Docker daemon, real Pi chat, registration, container image acceptance, host hardening, browser screenshots, or deployment acceptance was performed here.
- Unknown resources without a confirmed private journal identity remain unusable and reserved. There is no automatic reconciliation, replacement, name reuse, home deletion, enrollment, update or rollback implementation in this slice.
- Clean reopen and persisted stranded-task recovery are exercised. A real crash with a stale backend journal writer lock is not a tested recovery path here; backend journal recovery remains fail-closed under its existing contract, without adding an automatic stale-lock override.
- Workspace/path safety checks are not a claim that malicious host-side filesystem replacement races or host-level authority separation have been comprehensively hardened.
- The narrow commit includes this report; its exact hash is supplied in the handoff response. All unrelated worktree changes are preserved and unstaged by this slice.

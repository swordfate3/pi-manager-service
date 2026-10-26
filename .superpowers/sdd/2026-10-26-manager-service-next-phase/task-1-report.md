# Task 1 Report — Persistent Task Store

Date: 2026-10-26
Branch: `codex/manager-service`
Baseline: `f4b8163c22c73cbc2372664ee27af67d854fff3b`

## Result

Implemented the private filesystem `TaskStore` required by Task 1. The store persists exact immutable task requests, requester-scoped idempotency bindings, revisions, the eight approved states, timestamps, and optional JSON results. It exposes only the private TypeScript interfaces requested for this task; no HTTP, CLI, backend, Docker, production-state, credential, or public service integration was added.

## Implementation

- `TaskStore.open(root, { recoverStaleLock? })` prepares an explicit state root, rejects symlink/non-directory roots, enforces directory mode `0700`, acquires exclusive cross-process writer ownership, reads and strictly validates bounded persisted JSON, and creates an empty schema when state is absent.
- `submit({ key, requester, target, action, payload })` validates a strict five-field request, accepts JSON values only, caps each exact request at 64 KiB, clones caller data before queueing, serializes concurrent writes, and persists a new `pending_approval` task at revision 1.
- Idempotency is scoped by requester and key. Repeating semantically identical JSON returns the original task; changed action/target/payload content is rejected. Index access uses own-property operations, so values such as `__proto__` and `constructor` remain ordinary data rather than affecting object prototypes.
- `get(id)` returns a detached clone, so caller mutation cannot change stored request/result content.
- `transition(id, expectedState, nextState, { expectedRevision?, result? })` snapshots mutable options before enqueueing, enforces the approved state graph, optional revision compare-and-set, immutable request fields, monotonic revision increments, bounded JSON results, and atomic persistence. Terminal states do not transition further.
- The state file is capped at 1 MiB, read through a bounded regular-file handle, parsed without exposing raw parser diagnostics, schema-validated, written to a private `0600` temporary file, fsynced, atomically renamed, chmodded to `0600`, and followed by a directory fsync.
- Same-instance writes are serialized so concurrent submissions cannot overwrite one another. `close()` waits for queued writes, verifies its lock token, atomically renames only its owned lock directory, removes that unique renamed directory, and supports concurrent callers through one close promise.
- Any persistence I/O failure poisons that store instance. The failing operation, already queued later operations, subsequent writes, and reads all fail with one sanitized durability error; only `close()` remains available. A new `open()` must reread and validate disk before work can continue, so an operation that may have renamed successfully before chmod/fsync failed cannot be overwritten from stale memory or reuse an idempotency key blindly.

## Exclusive ownership and recovery

- Ownership is a real filesystem protocol used by independent processes, not a process-local mutex.
- Every lock contains bounded, strict metadata: schema version, PID, Linux boot ID plus `/proc/<pid>/stat` start ticks when available, random token, and creation time. Lock directories are `0700`; owner files are `0600`.
- PID probing treats only `ESRCH` as dead. `EPERM`, unexpected probe errors, missing process identity, malformed metadata, symlinks, and other ambiguous cases fail closed. A live PID with the same start identity is active; a different boot/start identity proves PID reuse and therefore a stale original owner.
- Lock acquisition and stale takeover are serialized by an atomic acquisition-gate directory. A recoverer holding the gate rechecks staleness, atomically renames the proven-stale main lock to a unique quarantine path, creates the replacement lock, and removes only the quarantined path. It never performs check-then-unlink on the fixed lock path.
- Two recoverers were exercised as independent processes. Exactly one obtained the acquisition gate and replacement lock; the loser failed closed and could not remove the winner's live lock.
- Automatic stale takeover is opt-in through `recoverStaleLock: true`. A stale lock without that option returns a recovery-required error. Only an actual stale-lock takeover changes persisted `running` tasks to `unknown` and increments their revisions. Merely passing the option on a clean open does not rewrite tasks, and recovered `unknown` work is never automatically replayed.
- If the short-lived acquisition gate itself is abandoned or malformed, automatic recovery is intentionally unavailable. Offline recovery must first stop all manager processes and prove that no PID/start identity can own the state root before quarantining that gate. The implementation does not race to delete it.

## TDD evidence

All Task 1 process tests used real temporary roots and independent Node processes. Every state-capable child overrode `HOME`, all used XDG roots, `PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG`. The default restricted runner rejected nested process pipes with `EPERM`, so only the exact focused Task 1 command was run with narrowly elevated temporary-process permission.

1. Initial RED, before implementation:

   `node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts`

   Result: 1 named test, 0 passed, 1 failed with `TaskStore implementation is missing`.

2. Expanded RED after the first persistence/idempotency slice:

   Same exact command, elevated for real children.

   Result: 10 named tests, 4 passed, 6 failed for invalid/unbounded JSON, concurrent lost writes, missing transitions, missing stale recovery, competing recovery, and unsanitized persisted-data errors.

3. Recovery-condition RED:

   Result: 11 named tests, 10 passed, 1 failed because requesting recovery without taking over a stale lock incorrectly changed `running` to `unknown`.

4. Strict-request/prototype-index RED:

   Result: 12 named tests, 10 passed, 2 failed because an extra request field was ignored and prototype-like requester/key strings were not safely indexed.

5. Exact-JSON mutation check:

   The first `__proto__` expectation was rejected during self-review because an object-literal expectation repeated JavaScript's special prototype behavior and could not catch the bug. It was replaced with an independently parsed literal plus an own-property assertion. The corrected test produced 11 passes and 1 expected failure before the JSON writer was fixed.

6. Additional review RED for mutable CAS options and ambiguous durability:

   Result: 13 named tests, 11 passed, 2 failed because queued `transition()` reread a caller-mutated revision and the store accepted later writes after a real persistence failure.

7. Final focused GREEN:

   `node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts`

   Result: 13 named tests, 13 passed, 0 failed, 0 skipped, duration 1273.444107 ms.

8. Final typecheck:

   `npm run typecheck`

   Result: `tsc --noEmit` exited 0 with no diagnostics.

No broad legacy Gate, browser, socket, package, build, or deployment suites were run.

## Focused test coverage

- Persistence across close/reopen.
- Requester-scoped idempotency, exact-content conflict rejection, and prototype-like strings.
- Input and returned-object mutation isolation.
- Strict, bounded JSON request/result/state parsing and sanitized malformed-data errors.
- Concurrent write serialization.
- Mutable transition-option snapshotting and fail-closed poisoning after a real persistence failure, including an already queued write.
- Valid/invalid state transitions and revision compare-and-set.
- Root, state, lock-directory, and owner-file modes.
- Rejection of a live independent writer, including when recovery is requested.
- Crash detection, explicit stale recovery, `running` to `unknown`, and no replay.
- Clean recovery-option open without a stale takeover.
- Two-process stale-takeover competition without replacement-lock deletion.
- Malformed and identity-ambiguous locks failing closed without raw-content exposure.

## Files owned by Task 1

- `manager/contracts.ts`
- `manager/task-store.ts`
- `tests/manager-task-store.test.ts`
- `tests/fixtures/task-store-child.mjs`
- `tsconfig.json` (only `manager/**/*.ts` added to `include`)
- `.superpowers/sdd/2026-10-26-manager-service-next-phase/task-1-report.md`

Controller-owned concurrent edits to `package.json`, `scripts/manager-dist.mjs`, `tests/manager-dist.test.mjs`, and `docs/validation/2026-10-26-manager-service-progress.md` were not modified, staged, or included.

## Self-review and limits

- Mutation review confirmed tests fail for changed request content, wrong requester scope, dropped concurrent writes, mutable CAS options, continuation after persistence uncertainty, an illegal transition, stale revision, missing permission enforcement, live second-writer acceptance, replaying/retaining `running` after crash, a recovery option falsely implying a takeover, a recoverer deleting a replacement lock, malformed raw-error exposure, unknown request fields, and prototype-key loss.
- Lock safety is cooperative private filesystem infrastructure. Mode `0700`/`0600` protects against other OS users according to normal filesystem permissions, but it does not isolate untrusted code running as the same UID; same-UID OS authority separation remains outside Task 1.
- Linux supplies boot/start identity through `/proc`. On platforms where start identity cannot be read, a live/permission-denied PID is ambiguous and automatic takeover is refused; only a definite `ESRCH` death can establish staleness without that identity.
- The `EPERM` branch was reviewed but not synthetically induced in the focused suite; the implementation maps it to ambiguous unless start-identity evidence independently proves active ownership or PID reuse.
- The acquisition gate deliberately has no recursive automatic stale recovery. An abandoned gate is an explicit offline-recovery condition, preventing an infinite hierarchy of racy recovery locks.
- The durability test induces a real pre-rename write failure by temporarily removing state-root write permission and verifies the same poison gate used for every atomic-write exception. The narrower “rename succeeded, then chmod or directory fsync failed” phase was not directly fault-injected because Task 1 adds no production test hooks; the implementation catches that exception at the same `#persist` boundary, leaves memory inaccessible, blocks queued/later operations, and requires reopen/reconciliation.
- The current bounds are 64 KiB per request/result, 1 MiB for the complete state file, depth 32, and 10,000 JSON nodes. Raising them later is a deliberate storage-contract change.
- Crash recovery converts only `running` work to `unknown`; queued and waiting work are retained but Task 1 contains no executor and therefore performs no automatic continuation or replay.
- No claim is made about public API authorization, backend lifecycle, production migration, or security isolation from same-UID agents.

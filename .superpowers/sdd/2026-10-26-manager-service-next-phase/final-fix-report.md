# Final fix report — Tasks 1–2

Scope: one final, narrow repair wave for I1, M1, and M2 from
`final-review.md`. The controller-owned validation document was not edited.

## Changes and causes

- **I1 — exact canonical JSON ordering:** `canonicalJson()` used
  `localeCompare()`, which is locale-dependent and can treat distinct keys such
  as `"é"` and `"é"` as equal. Stable sorting then retained insertion order,
  producing different idempotency comparisons for equivalent requests. It now
  uses deterministic exact-string total ordering (`<` / `>`). No Unicode
  normalization occurs, no schema/data migration was introduced, and no
  fingerprint is persisted in `tasks.json`.
- **I1 coverage:** a real `TaskStore` regression submits both object-key
  orders, verifies the exact two-key persisted payload representation, retries
  successfully after close/reopen, and rejects a changed value.
- **M1 — boot UUID portability:** the test no longer assumes the host boot UUID
  contains `a-f`. It always exercises live-PID leading-zero rejection, tries
  the observed uppercase variant only when it actually differs, and separately
  checks a deterministic uppercase UUID is malformed.
- **M2 — native harness diagnostics:** removed the catch-all dynamic-import
  replacement so real backend import failures preserve their original error and
  stack.

## RED / GREEN evidence

RED, before the TaskStore source change:

```text
node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts
17 tests: 16 pass, 1 fail
failing test: idempotency preserves distinct Unicode keys across reordered retries and reopen
TaskStoreConflictError: Idempotency key is already bound to different request content
at manager/task-store.ts:688
```

GREEN, after the source/test changes:

```text
node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts
17 tests: 17 pass, 0 fail

node --import ./tests/register-ts.mjs tests/native-backend.test.ts
30 tests: 30 pass, 0 fail

node --import ./tests/register-ts.mjs integration-tests/native-lifecycle.test.ts
1 test: 1 pass, 0 fail

npm run typecheck
tsc --noEmit: exit 0
```

The three Node test commands were run with narrowly authorized temporary
child-process communication. Their fixtures isolate HOME/XDG and
agent/session/config paths, and the integration test uses only the synthetic
provider; no credentials, Docker, network, or production resources were used.

## Scope and concerns

- `git diff --check` passed.
- Implementation/test edits are limited to the three brief-authorized paths.
- This report is the explicitly required additional artifact.
- No distribution artifacts, dependencies, public APIs, controller documents,
  Docker/host configuration, or production systems were changed.
- The default sandbox blocks the TaskStore fixture's child status communication;
  with the brief-authorized narrow runner permission, existing child/recovery
  tests pass. This is a runner restriction, not a product-test failure.

## Commit

This report and the final fix wave are committed together with subject:
`fix(manager): finalize bounded task-store repairs`.

# Temporary manager isolation probe — experiment only

This opt-in fixture is not a production Manager executor, Docker backend, webpage,
MCP integration, or Pi lifecycle service. It does not adopt old Pi processes.
Only the host runner can invoke Docker. No real credentials or existing volumes
are used. No package/dependency/build changes are required.

## Offline verification (never accesses Docker)

```sh
node --experimental-test-isolation=none --test integration-tests/manager-isolation/offline.test.mjs
node integration-tests/manager-isolation/run.mjs
```

The second command prints `NOT RUN`. The first uses the real TaskStore with
temporary local files; no subprocess, socket listener or Docker is needed.
Node 22.19 supports the shown test-runner flag and native TypeScript import.
The actual container fixture requires Node 24 in an already-local full image ID.

## Controller-only actual probe

```sh
node integration-tests/manager-isolation/run.mjs --image sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6 --allow-temporary-docker
```

Only exit 0 with the final `PASS temporary container isolation probe` and clean
postflight is acceptance. Unsupported images, command errors, denied child
process creation (including `error` alongside status 0), timeouts, excessive
output, failed assertions and cleanup residue fail the run. There are no skips.
The runner uses the local default Docker daemon with only host PATH inherited.
It checks image identity/implicit volumes, uses `--pull=never`, disables image
healthchecks, replaces the entrypoint with `/usr/bin/env`, and runs `env -i`
with only PATH for both container start and exec. It never pulls or builds.

## Boundary layout

| Role | UID / primary GID | Supplemental GIDs | Named-volume domains |
| --- | --- | --- | --- |
| Executor | 21001 | 21002, 21005 | private, control, exec, admin |
| Public entry | 21002 | 21006 | public, exec (read-only) |
| Frontend client | 21003 | 21006 | public (read-only), frontend-work |
| Agent client | 21004 | 21006 | public (read-only), agent-work |
| Administrator client | 21005 | none | admin (read-only) |

The public socket group is 21006; execution is 21002; approval is 21005.
Socket directories are 0750 and sockets 0660. Private/control/workspace volumes
are owner-only. A short-lived root init helper receives only these new volumes
and CHOWN/FOWNER/DAC_OVERRIDE; all actual roles are nonroot with no capabilities.
Every container has network none, read-only root, no-new-privileges, no published
ports, bounded memory/CPU/PIDs/logging, and no Docker socket or host-root/home mount.
Local logs use `max-size=1m`, `max-file=1`, and explicit `compress=false`:
the local driver's default compression is incompatible with single-file retention
on the controller's Engine 29.3.0. No daemon-wide configuration is changed.

The host stages exactly `manager/task-store.ts`, `manager/contracts.ts` and the
five necessary fixture modules (`executor.mjs`, `role.mjs`, `rpc.mjs`,
`protocol.mjs`, `access.mjs`). The executor gets the two real TS sources and executor module
as a narrow read-only bind. All roles receive only the four common fixture
modules through a separate narrow read-only bind. No repository or node_modules
mount is used. Staging is a fresh random temporary directory.

The executor is the sole real TaskStore writer. Public entry permits only
submit/query/dispatch-reference, never approval. Requests can only specify a
fixed marker action, fixed control target, and empty payload. Approval binds
task ID, revision, canonical immutable request hash, and policy hash. The
executor independently validates approval and revalidates it at dispatch.
Dispatch is a frozen `{taskId, revision}` with no extra keys. A serial dispatch
claim changes state before starting the delayed fixed marker action. No shell,
Pi, arbitrary command, user-provided path, or Docker command can be an action.

The probe checks real workspace writes, denied private-file reads/writes,
denied code changes and admin/execution/Docker socket connections for both
frontend **client** (UID 21003) and Agent (UID 21004). Separately it runs in the
actual public entry **server** container (UID 21002): private files,
administrator/Docker sockets and code changes must be denied; connecting to
its legitimate executor socket and reading its read-only fixture must succeed.
The entry server has no workspace, and no extra mount is added for this test.
Direct RPC requests from that entry domain to the executor socket bypass the
public-entry router: approval, unapproved dispatch, stale/wrong references and
extra payload fields must be rejected by an independent executor-side handler.
Positive direct query and unchanged queued state/empty marker checks prevent
counting broken connectivity as authorization enforcement.
The probe also checks allowed submit/query, forbidden self-approval
and approval bypass, binding mismatches, stale/incorrect/extra references,
legitimate single execution, stopped entry/Agent survival, graceful executor
replacement, identical terminal state, and no terminal replay. Administrator
socket readiness is positively established before inaccessible-socket tests;
missing sockets and filesystem permission denials are accepted boundary results,
but connection refused/timeouts are not.

## Deliberate unsafe-fixture negative control

```sh
node integration-tests/manager-isolation/run.mjs --image sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6 --allow-temporary-docker --unsafe-fixture-admin-access --acknowledge-negative-control
```

Both additional flags are required. This only adds the new run's admin socket
volume and GID 21005 to the new test **Agent** (UID 21004), not the frontend client
or entry server. It never weakens any existing
resource, host permission, production file, or Docker boundary. The unmodified
boundary test must fail with `BOUNDARY BREACH: connect /admin/approval.sock`;
cleanup must still succeed. An unrelated failure is not negative-control evidence.
The runner never reclassifies this nonzero exit as an overall pass.

## Cleanup, interruption, and limitations

The run prints a 128-bit random ownership nonce, created container IDs, and the
temporary `ownership.json` journal path. Before creating a resource it checks
that the exact random name is absent. Before starting/stopping/removing it,
the runner verifies the exact ID/name and `cn.swordfate.manager-isolation.run`
label. Failed creates are tracked as exact candidate names, resolved and checked
before cleanup. It never prunes or deletes by prefix/label alone.

Normal failures, SIGINT and SIGTERM enter cleanup. It uses a 120-second action
budget, a separate 60-second cleanup budget, at most 15 seconds/256 KiB per
Docker command, 3–4 second RPC deadlines, and 180-second role lifetimes. Forceful
host termination, daemon loss, or a failed cleanup can leave stopped containers
or volumes; there is no claim that SIGKILL can be cleaned up automatically.
On incomplete cleanup the journal and staging directory are preserved and exact
residual resource IDs/errors are printed. To recover, read that journal and:

1. Inspect each exact container ID (or the recorded exact name if creation was
   uncertain); verify its ID and the run label against the journal.
2. Stop that verified container if needed, inspect/verify again, then remove
   that exact container ID. Do not use prune, wildcard or broad-prefix cleanup.
3. Inspect each exact recorded volume name, verify the same run label, then
   remove only that exact volume name after all its test containers are gone.
4. Check both resource lists for the run label; if empty, remove only the exact
   journal staging directory. Never remove a resource whose ownership differs.

Postflight compares all pre-existing container IDs/start times and reports both
snapshots. A difference fails verification and reports facts without claiming
the probe caused it or that it was unrelated.

Approval capabilities are deliberately in-memory and lost on executor restart:
queued-but-not-dispatched tasks fail closed and need a future recovery design.
The reopen test covers completed tasks and graceful TaskStore close, not crash
atomicity between an external side effect and a store transition. The shared
public socket does not authenticate the requester's string or implement
multi-tenant query filtering. This probe demonstrates role/mount authority
separation and the frozen-reference pattern, not a general service framework.

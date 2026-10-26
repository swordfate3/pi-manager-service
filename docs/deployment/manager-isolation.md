# Manager service authority isolation on Linux Docker

This recipe runs the **actual packaged** `pi-manager-public.mjs`,
`pi-manager-admin.mjs`, `pi-manager-executor.mjs`, and `pi-manager-chat.mjs`
entries in separate authority domains. It is distinct from the older
`integration-tests/manager-isolation` marker protocol fixture. The new runner is
`integration-tests/service-isolation/run.mjs`; its probes are clients and
filesystem/socket checks, not replacement Manager services.

The acceptance profile uses the real Docker task adapter with an
administrator-fixed, inert Node marker child. It checks authorization and
actual backend mutation without executing Pi, installing dependencies, contacting
models or claiming chat/dialogue compatibility. The controller's separate real
Pi/Web tests cover those behaviors.

## Boundaries in this recipe

All containers are new and disposable. Numeric IDs refer only to their container
processes and the test's new temporary files; the runner does not add host users
or groups, use sudo, or change ownership of existing host paths.

| Role | UID | Authority/mounts |
| --- | --- | --- |
| Executor | 21001 | Private executor config and tasks, private Docker journal, submit/admin socket directories, read-only selected workspace root, daemon socket |
| Public server | 21002 | Its config, read-only code, submit socket; no executor/admin state or Docker socket |
| Private administrator | 21003 | Its config and synthetic administrator credential, read-only code, admin socket; no Docker socket |
| Fake Agent | 21004 | Read-only code, submit socket, its own writable workspace; no private authority or Docker socket |
| Chat service | 21005 | Its config and separate chat state/runtime; no task/admin sockets or Docker socket |
| Authorized marker child | 1000 | Its selected workspace and newly owned persistent home volume; network disabled, no host Docker socket |

Submit and administrator sockets are real Unix HTTP listeners created by the
executor with mode `0660`. Separate setgid parents assign groups 22002 (submit)
and 22003 (admin). Parents are owned by UID 21001 and mode `02750`: group members
can traverse/connect, not replace socket entries. Configs are owner-only `0400`
files in owner-only directories. The workspace root is owned by UID 1000 with
group 22001/read-search permission for the executor; the executor mounts it
read-only, while its authorized child receives the selected project read-write.

All normal role containers are nonroot, read-only-root, cap-drop-ALL,
no-new-privileges, with bounded memory/swap, CPU, PIDs and rotated logs. Image
environment is cleared by `/usr/bin/env -i`; no personal HOME, SSH, model config,
workspace or credentials are mounted. Only narrowly scoped initialization and
evidence-collection helpers use root, with CHOWN/FOWNER/DAC_OVERRIDE and a mount
of **only this run's new temporary directory**. No helper mounts Docker's socket.
The helper also joins groups 22002/22003 so setting their setgid directory bits
does not require CAP_FSETID. Provisioning verifies the resulting modes/owners;
the live test independently verifies both socket owners and groups.

The public/admin/chat listeners bind `127.0.0.1`. This test explicitly uses host
networking for those roles and the probe Agent so their loopback origins are
reachable. **Host networking is not network isolation.** A compromised public
process can reach the administrator's TCP listener; it must still authenticate
with independent administrator authority. The test also demonstrates that a
submitter credential cannot log in there. The bearer administrator credential
is used only through the private administrator service; it is never sent to the
public service or put in an ambient cookie.

## Opt-in acceptance

Prerequisites:

- Linux with the approved local Docker daemon and the exact already-present
  image below. The runner neither pulls nor builds images. Image-declared
  anonymous volumes are rejected.
- The controller must have regenerated and verified dist for current source.
  The runner checks the distribution manifest **before creating containers**;
  source/output drift is a hard prerequisite failure, not an isolation finding.
- Declared `ws` must already be installed locally. Only an explicit copy of that
  runtime package is supplied to the staged bundles. Shared `node_modules` is
  never changed.
- Docker bind-source coordinates must be the real daemon host's absolute
  coordinates. The same absolute temporary paths are used in both executor and
  daemon operations. A run-specific marker read inside the initialization
  container verifies the mapping; missing/different mappings are refused.
- Existing containers must remain stable during the run: the final full
  ID/StartedAt/Running/RestartCount snapshot must equal the initial snapshot.
  Do not coordinate an unrelated restart during this acceptance.

From the repository root:

```sh
node --test --experimental-test-isolation=none integration-tests/service-isolation/offline.test.mjs

node integration-tests/service-isolation/run.mjs \
  --run --allow-host-network \
  --image sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6 \
  --daemon-id bac0be49-8ddb-4387-83aa-362f70f3ae8d
```

The daemon endpoint is fixed to `unix:///var/run/docker.sock`. Unsupported
targets, missing acknowledgements, command errors, timeouts, invalid assertions,
or incomplete cleanup cause a nonzero exit. There is no silent skip mode.
Run this only with permission to create/remove the declared disposable resources.

## What a successful run proves

- A real public page and empty resource list work with zero Pi instances.
- Actual HTTP and MCP submit/query routes produce principal-bound persistent
  tasks, preserve idempotency, deny another principal's task, and expose no MCP
  approval tool.
- Public approval/execution and client-provided executable/argv/mount/principal
  fields are rejected. Forged approval/role messages sent **directly from the
  actual public server container** to the real submit socket are independently
  rejected by the executor before backend mutation.
- Public and Agent containers cannot read/write executor tasks/config or the
  administrator credential, modify mounted code, or connect to the admin or
  Docker sockets. Positive owner evidence, readable own code, working submit
  connectivity and writable Agent workspace prevent a missing-service failure
  from masquerading as isolation.
- Private review and exact independent approval execute the actual Docker
  adapter. Changed revision/request/policy hashes and administrator self-approval
  fail. Administrator login does not issue a cookie, and a cookie alone grants
  no authority.
- Approved stop/start uses the same exact child container and persistent home
  marker; a final approved stop finishes before cleanup.
- All owned disposable containers and the backend volume are removed, and
  existing container lifecycle snapshots are unchanged.

The run records source/output inventory identities, the manifest hash, Git HEAD,
every staged bundle/runtime file hash, exact created IDs and ownership labels,
assertion evidence, and cleanup results. These identify what actually ran; a
source commit alone is not evidence that an old dist was refreshed.

## Cleanup and evidence

The runner prints `EVIDENCE /tmp/msi-<random-run>-<suffix>/evidence.json`.
`ownership.json` records exact create intents before issuing commands and then
the returned IDs. New role resources carry a random run label. The actual
backend's resources are bound to its private journal's random task nonce,
profile owner and run-specific target, and are checked against preexisting IDs.
Every destructive operation revalidates exact identity and ownership. There is
no broad prune, foreign resource adoption or cleanup by a loose name prefix.

An uncertain create is reconciled only against its exact recorded random name
and ownership labels. A mismatch, unsupported state or ambiguous identity fails
and preserves evidence rather than authorizing deletion. The final result lists
cleanup errors. Inspect the retained journal before any manual reconciliation;
never substitute a broad prune command.

The temporary directory is deliberately retained for audit, returned to the
invoking UID/GID by the scoped collection helper and made `0700`. It contains
synthetic test credentials, so keep it private. The runner does not recursively
delete it. On incomplete collection, files may retain the test's numeric owners;
the exact path and resource IDs remain in the journal.

## Applicability and limitations

This is a Linux/local-Docker deployment/acceptance recipe, not a claim of a
universally isolated default installation. Native mode remains explicitly
**trusted-local**; it does not isolate a hostile process running under the same
host account. Windows, macOS, remote Docker, rootless Docker, user-namespace
remapping and alternative image layouts are not validated by this recipe.

The executor holds Docker-daemon authority and is therefore trusted. Container
separation does not protect against a malicious executor, root, or a daemon
administrator. Host networking does not provide egress or cross-role TCP
isolation. This profile does not prove Pi dialogue restoration, browser behavior,
release activation, dependency installation, power-loss recovery or hostile
kernel resistance. Consult the task report for the actual run result and exact
artifact/evidence identities; documentation or offline guard passes alone are
not live service acceptance.

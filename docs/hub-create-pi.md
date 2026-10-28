# Create and approve a Pi from the Hub webpages

This feature is opt-in. An administrator must configure the Docker backend,
workspace browser, fixed runtime and Chat provisioning broker before the
requester webpage can create a Pi. Existing production configuration and the
zero-backend quickstart are **not** enabled or changed by this feature. This is
not a production rollout or an installed-version update feature.

## Configure a portable Home and project root

The configured browser `home` is a host directory selected by the administrator,
not the Chat/executor process's `HOME`, a hardcoded user's home, or the Pi's home.
For example, these fragments belong in the executor's private configuration:

```json
{
  "workspaces": {},
  "workspaceBrowser": {
    "home": "/srv/pi-work/Home",
    "defaultRoot": "projects"
  },
  "docker": {
    "pathCoordinates": "host",
    "workspaceRoots": {
      "projects": "/srv/pi-work/Home/projects"
    }
  }
}
```

This is a fragment, not a complete deployable configuration. The backend also
needs a pinned daemon ID, immutable `sha256:` image ID, private state, sockets,
principals, Web package and enrollment configuration. See
[the fixed runtime and enrollment contract](hub-create-runtime-enrollment.md)
for those fields and exact permission requirements.

Create the project directories before using the webpage. Roots must be canonical
existing directories strictly below the configured Home. The browser lists
existing directories, not files; it does not create host directories. Traversal,
absolute paths, symlink escapes and protected private branches are rejected.
A root containing protected branches can be browsed, but cannot itself be
selected as a Pi workspace. A selected project is mounted read-write at
`/workspace`; choose its contents accordingly.

## Requester and administrator flow

1. Open the requester management webpage and authenticate with the separately
   provisioned requester credential. Choose **Create**, a logical instance name,
   an allowed root and an existing project directory. Submit the request.
2. The task remains `pending_approval`. Repeating the identical request with the
   same idempotency key returns the same task ID. Submission does not start a
   container, and the requester/public route cannot approve or execute it.
3. Open the separate, private administrator webpage and log in with an
   administrator credential. Review the stored action, instance name and exact
   root-relative directory (for example `projects` + `project`). It is the
   stored selection, not a later browser selection, that is approved. Review
   binds the task revision, request hash and administrator policy hash.
4. Click approval on that reviewed task. The administrator service approves and
   starts execution; poll the **original task ID**. `succeeded` for broker-backed
   create/start means the Pi is running **and** its registered Chat endpoint has
   answered a fresh readiness proof, not merely that Docker reports Running.
5. Open the registered session in Chat. Stop and start are separate submitted
   tasks requiring independent approval. Stop retains the container identity
   and its private home volume. Start can restore saved conversation history
   using that same container, home and registration identity, including after
   the executor has been closed and reopened.

The page does not permit request-selected images, arbitrary commands, mounts,
environment variables, models or extensions. The administrator fixes the image,
installed runtime, models JSON, explicit extension entries and provider. Each Pi
gets its own persistent writable `/home/node`; sharing a read-only runtime
volume does not share Pi histories, settings or authentication files.

## Deploy the separated roles deliberately

Chat and ordinary Pi run as UID1000; Pi uses `1000:1000`. The executor runs as a
different OS user. Provision a dedicated enrollment IPC GID shared by Chat and
executor, with a Chat-owned setgid `02750` parent and `0660` broker socket.
Keep Chat state/config/exports owner-only and its registry socket private. Keep
the dedicated broker token in an executor-owned `0600` authority file, not in
the public/admin service or Pi. Generate independent random requester,
administrator and enrollment credentials; do not reuse production secrets in
tests.

The narrow broker accepts only authenticated issue/status operations for an
exact task UUID and instance label. It never sends registration credentials
back to the executor or exposes a general Docker/approval API. Docker mounts
only the Pi's individual exported credential file and registry directory into
that Pi. The executor does not need to read Chat's private state or exports.

Docker bind sources are **host-daemon coordinates**. If the executor runs in a
container, mount its allowed project directories, installed code, fixed profile,
own authority/state and broker IPC at the same absolute coordinates. The
`registryHostDirectory` and `exportHostDirectory` are administrator-attested host
coordinates: they are not executor-visible directories to mount or traverse.
Use distinct private submit/admin IPC channels and keep the administrator HTTP
origin private; publishing the requester/Chat page does not authorize publishing
the administrator page.

For a runtime profile, the installed runtime volume must already exist and is
mounted read-only with `NoCopy`. The models JSON is read-only at
`/home/node/.pi/manager-agent/models.json`; auth/settings/model-store paths in
the independent home must remain UID1000-writable. Use an actually prepared
image satisfying `cn.swordfate.pi-manager.profile-home=uid1000-v1`, not an
unprepared image with a newly added label. Explicit extensions are read-only.
Omit `PI_OFFLINE` entirely for this profile: an inherited value of `0` is also
rejected. Normal implicit extension/context discovery remains disabled.

Security boundary: the raw Docker executor is trusted host-daemon authority,
not confined against its own compromise. Host-network Pi can reach host
loopback services. Gateway login is an external access boundary, **not** a
blanket local-process isolation guarantee. Do not describe this deployment as
an untrusted multi-tenant network or privacy sandbox.

## Isolated acceptance command

Run only with explicit permission to create disposable test containers and
volumes. Run the driver on Linux as UID/GID1000:1000 with access to the local
Docker socket. Supply an already prepared immutable test image and a clean Web
v1 source directory. The controller must already have built the standalone
`dist/manager/pi-manager-executor.mjs`; this test never installs dependencies,
builds dist or pulls/builds an image.

From the service repository, after setting the two required resource variables:

```sh
PI_MANAGER_DOCKER_TEST=1 \
PI_MANAGER_DOCKER_TEST_IMAGE="${PI_MANAGER_DOCKER_TEST_IMAGE:?Set an immutable prepared sha256 image ID}" \
PI_MANAGER_TEST_WEB_ROOT="${PI_MANAGER_TEST_WEB_ROOT:?Set a clean Web v1 source directory}" \
node --import ./tests/register-ts.mjs integration-tests/hub-create-pi/acceptance.test.mjs
```

Optionally set `PI_MANAGER_DOCKER_TEST_SOCKET` to the intended local socket;
otherwise `/var/run/docker.sock` is used. The enrollment GID21002 must be
distinct from the Docker socket GID and the executor must not need Chat's
GID1000 to access Docker.

The test packs Web offline with scripts disabled and an isolated npm HOME/cache.
It copies the existing deterministic `native-provider.ts`, never a personal
provider configuration. No paid/online model is contacted. It creates a fresh
temporary configured Home and a new labeled runtime volume, seeded only from
the pinned test image. It checks the following real path:

- Requester HTTP directory browse/selection, malformed/private-path denial,
  idempotent submission, denial of unauthorized approval, administrator HTTP
  login/review/approval, and task completion through broker readiness.
- An executor container as UID21001, enrollment socket GID21002/mode0660, and
  UID1000 Pi. A separate socket-free, read-only probe using UID21001 demonstrates
  `EACCES` on mounted Chat-private files; the actual executor has no Chat-private
  mount and verifies those paths are absent. Successful enrollment therefore
  uses the group socket, not direct grant access.
- Exact Pi mounts, read-only rootfs, dropped capabilities, no-new-privileges,
  read-only/NoCopy runtime, read-only models, UID1000-writable auth/settings/
  model-store targets, and an explicitly loaded fixture extension.
- A real prompt and deterministic assistant marker through the Hub WebSocket;
  independently approved stop/start, a clean executor reopen, unchanged
  container/home/grant identity and restored user/assistant turns. A before/after
  content/metadata digest checks the shared runtime was not modified.

Chat, requester HTTP and administrator HTTP are separate listeners in the host
UID1000 test driver; this test does **not** claim separate OS identities for all
three HTTP roles, nor graphical-browser click/screenshot automation. The
executor/Pi UID split and broker group access are real, not same-UID simulation.

The socket-free root provisioning helper can touch only the validated new
temporary root. It has no network or Docker socket and only CHOWN,
DAC_OVERRIDE and FOWNER capabilities, plus FSETID on the preparation helper to
preserve setgid when assigning a foreign group. A preceding regression probe
uses the old capability set without FSETID and records the resulting missing
setgid bit. Preparation then asserts the exact UID/GID/02750 permissions;
the host records them after preparation and before/after Chat startup, including
the resulting UID1000/GID21002/0660 socket. These snapshots are saved before
cleanup restores permissions. The driver journals every helper/executor
name and ID before subsequent use. Cleanup verifies exact journal identity,
random labels/instance, pinned image and baseline exclusion; it removes only
this run's containers and fresh home/runtime volumes. All preexisting container
IDs, StartedAt, Running and RestartCount are compared before/after. No prune,
wildcard deletion or adoption of existing containers/volumes occurs.

The test prints the exact `/tmp/hcpi-…/evidence.json` path. Temporary evidence,
synthetic config and bounded container logs are retained in an owner-only
directory even on success. On unknown outcomes or failed ownership checks,
retained Pi/home/runtime resources require trusted reconciliation using that
exact evidence; do not delete by a broad label or filename pattern.

Non-Docker gate/cleanup-guard checks:

```sh
node --import ./tests/register-ts.mjs integration-tests/hub-create-pi/safety.test.ts
PI_MANAGER_DOCKER_TEST=0 node --import ./tests/register-ts.mjs integration-tests/hub-create-pi/acceptance.test.mjs
```

The already existing `tests/docker-enrollment.test.ts` covers injected start
failure, Running-without-readiness and lost create replies using fake Docker,
checking retained identity and no duplicate grants/containers. Such faults are
not injected into production or the real acceptance daemon. The second command
above is a skip-safety check, **not** a passed Docker acceptance.

## Deliberate limits

Production online model behavior is untested without explicit credentials.
There is no automatic import/adoption of external `pirun` containers, no QQ
screenshot parity without a separate screenshot lifecycle bridge, no public or
mobile administrator exposure, and no production rollout in this task. Known
start/readiness failures retain identity for approved recovery; uncertain
outcomes require reconciliation, not a blind create retry. This feature does
not claim installed-version updates.

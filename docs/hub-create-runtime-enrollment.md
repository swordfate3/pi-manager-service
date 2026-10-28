# Administrator-fixed Pi runtime and split-role enrollment

This is an opt-in configuration contract, not a deployment script. Existing
`web.hubConfigFile` deployments retain their direct same-UID enrollment behavior.
Do not activate a new profile against an existing journal: the policy hash binds
the fixed profile, image, paths, and launch arguments. A changed policy requires
explicit operator migration, not automatic adoption or recreation.

## Role and filesystem boundary

The executor has raw Docker daemon authority and is trusted. A compromised
executor can use Docker to bypass host filesystem permissions; this broker does
**not** confine a malicious executor. The broker prevents accidental cross-role
private-state reads and keeps chat, public/admin web services, and ordinary Pi
containers free of Docker/provisioning authority.

Chat and ordinary Pi must both run with UID **1000**. Pi is always launched as
`1000:1000`; broker startup rejects a chat process whose UID is not 1000.
Use a distinct executor UID and an administrator-provisioned dedicated GID shared
only by chat and executor, not Pi or the public/admin web services. Group
membership is deployment authority, not inferred or changed by this package.

Recommended ownership/modes (illustrative paths):

| Source | Owner / mode | Who can access it |
| --- | --- | --- |
| `/srv/pi-chat/private` and its state/config | chat UID1000, directory0700, files0600 | chat only |
| `/srv/pi-chat/runtime` | chat UID1000, directory0700, registry socket0600 | chat; Pi through its narrow bind |
| `/srv/pi-chat/exports` | chat UID1000, directory0700, exports0600 | chat; Pi gets only its own file bind |
| `/srv/pi-enrollment` | chat UID1000, dedicated GID, **02750** | chat; executor can search the IPC parent |
| `/srv/pi-enrollment/broker.sock` | chat UID1000, dedicated GID, **0660** | chat and executor |
| `/srv/pi-executor/private/authority.json` | executor UID, file0600, parent0700 | executor only |

The broker checks existing directories; it does not chown or chmod them. The
setgid IPC parent ensures socket group inheritance. It must not be writable by
group or other. With socket0600, the parent must be owner-only. An existing
broker socket/file is never stolen, even if it looks stale. Trusted operators
must establish that its owner is gone before removing a stale socket or Hub lock.

All Docker paths use canonical **host-daemon coordinates**, not arbitrary paths
inside the executor container. Explicitly mount executor-readable workspace
roots, installed code, model/profile sources, broker IPC, and the authority file
at the **same absolute coordinates** inside the executor. Host directories must
be canonical, with no symlink aliases. Administrator-managed sources must not be
writable by untrusted workspace users.

`registryHostDirectory` and `exportHostDirectory` are different: the executor
must **not** mount, stat, realpath, list, or read through these chat-private
directories. They are normalized lexical host coordinates protected by workspace
policy. The operator is responsible for verifying their canonical host targets
and matching them to the chat configuration. Docker resolves these host sources
when mounting the registry directory and one deterministic export file into Pi.
Do not mount chat private state/config or the broker socket/authority file into Pi.

## Chat private configuration

Add `provisioning` to the existing private chat JSON; it is not accepted on the
public HTTP listener or the ordinary Pi registry socket:

```json
{
  "port": 16180,
  "stateDir": "/srv/pi-chat/private/state",
  "runtimeDir": "/srv/pi-chat/runtime",
  "provisioning": {
    "socketPath": "/srv/pi-enrollment/broker.sock",
    "exportDir": "/srv/pi-chat/exports",
    "tokenHash": "<sha256 of the dedicated enrollment bearer token>",
    "socketMode": 432
  }
}
```

JSON `432` is octal0660; use decimal384 for octal0600 (the default). The dedicated
executor-owned authority JSON contains only `{ "token": "<dedicated token>" }`.
Use a random bearer matching `[A-Za-z0-9_-]{32,128}`, not any existing Hub/Pi or
administrator credential. The authority reader opens with
`O_NOFOLLOW|O_NONBLOCK` and checks regular file, current owner, single hardlink,
private permissions, and an 8192-byte limit before reading. FIFO/device/symlink
configuration is rejected rather than blocking or revealing arbitrary files.

Only authenticated `POST /issue` and `POST /status` with exact Host
`pi-enrollment` and JSON `{key: <backend-task-UUID>, label: <instance-id>}` exist.
The protocol accepts no output path, backend host, general list, grant-read,
approval, delete, or Docker operation. Responses are only `{ok:true}` or
`{ready:boolean}`. Request bodies/headers/connections/deadlines are bounded and
errors are generic. No registration bytes are sent to the executor. The chat
service owns both listeners and cleans up Hub startup if broker startup fails.

## Docker private configuration

Choose exactly one of `web.hubConfigFile` (legacy) or `web.enrollment` (broker).
Keep the existing pinned daemon ID and exact `sha256:` image ID, `pathCoordinates:
"host"`, and workspace allowlist. Nothing here is selectable by a create request.

```json
{
  "startupTimeoutMs": 20000,
  "web": {
    "packageRoot": "/srv/pi-packages/web",
    "port": 18310,
    "enrollment": {
      "socketPath": "/srv/pi-enrollment/broker.sock",
      "authorityFile": "/srv/pi-executor/private/authority.json",
      "registryHostDirectory": "/srv/pi-chat/runtime",
      "exportHostDirectory": "/srv/pi-chat/exports"
    }
  },
  "runtimeProfile": {
    "runtimeVolume": "pi-runtime-approved",
    "modelsFile": "/srv/pi-profile/models.json",
    "environment": { "CUSTOM_PROVIDER_SETTING": "administrator-fixed-value" },
    "extensions": [
      { "packageRoot": "/srv/pi-packages/custom-provider", "entry": "index.ts" }
    ]
  }
}
```

This fragment belongs within the executor's `docker` object. `runtimeProfile`
is optional but requires `web`. Each field is optional; `{}` enables normal
online/tools behavior using the pinned image runtime. The existing optional
`web.provider:{packageRoot,name,model}` remains available.

`runtimeVolume` must already exist, use the local driver with no driver options,
and have a valid named-volume identifier. It is inspected, never pulled or
auto-created. The mount at `/home/node/.local` is read-only with
`VolumeOptions:{NoCopy:true}`, preventing image copy-up into an empty shared
volume. It cannot reuse the reserved per-instance home-volume namespace. Every
instance still gets its own new writable home volume at `/home/node`, including
normal home initialization and retained session data.

`modelsFile` must be a canonical regular JSON object file (bounded to1MiB), and
is bound read-only at `/home/node/.pi/manager-agent/models.json`. This nested bind
also requires the pinned image label
`cn.swordfate.pi-manager.profile-home=uid1000-v1`. The label attests that the image
already contains non-symlink `/home/node/.pi` and
`/home/node/.pi/manager-agent`, owned1000:1000, mode0700 and writable by UID1000.
Without it, the backend rejects the image before enrollment or any Docker
mutation. Docker could otherwise create missing file-bind parents as root before
Pi starts, preventing auth/settings/model-store writes in a fresh home.

An optional example, `docs/examples/Dockerfile.pi-runtime-profile`, prepares only
these directories as UID1000 at image build time, checks ownership, and applies
the versioned label. It accepts an explicit administrator-selected `BASE_IMAGE`;
it is not built or selected automatically and changes no production tag. Pin the
new image's exact ID in an isolated Task3 test configuration. Do not just add the
label to an unprepared image. It is a trusted image-author assertion, not proof
that Docker inspect can examine the filesystem.

Task3 must use a **fresh** independent home plus the real models file bind and
verify UID1000 can create auth/settings/model-store files in `manager-agent`
while models.json remains read-only. Verify the existing runtime volume remains
unchanged with NoCopy, and stop/start retains session history. The controller's
base-image probe found `.pi` and `manager-agent` absent: that unprepared base is
not accepted for a modelsFile profile. There is no runtime root initializer,
recursive chown of a persistent home, or production repair operation here.

At most16
extension packages are allowed. Each entry is an existing canonical regular
`.ts`, `.js`, or `.mjs` file below its canonical package directory, with a bounded
relative path and no empty/dot/traversal/backslash segments. The whole package
mounts read-only at `/opt/pi-profile/extensions/<index>`; only its specified entry
is explicitly loaded. Profile and Web/provider code sources cannot overlap known
executor/enrollment private authority sources; all sources enter workspace
protection and policy ownership checks.

Environment values come only from this explicit administrator mapping, never
from `process.env`: at most32 uppercase variable names, 8192 total encoded bytes,
string values without NUL. HOME/PATH/NODE_OPTIONS/NODE_PATH, LD_* and PI_* are
reserved. Environment secrets are visible to trusted Docker operators. Prefer
an explicitly installed provider that reads suitably narrow credential files;
this profile does not automatically copy existing credentials or provide a
general-purpose credential/bind-mount API. Do not put real secrets in examples,
task requests, error messages, or public configuration.

With `runtimeProfile`, the command omits `--offline` and `--no-tools`, but retains
disabled implicit extension/skill/prompt/theme/context/MCP discovery. Web and
approved provider/profile extensions are loaded explicitly. It omits the
`PI_OFFLINE` environment key entirely: Pi checks whether it is **undefined**, so
`0` or an empty string does not enable online models. A pinned image defining
PI_OFFLINE is rejected for the online profile because Docker merges image Env
and cannot unset the key this way. Legacy Web profiles retain `PI_OFFLINE=1`.

Ownership checks reconstruct the merged environment from the pinned image on
every inspection, including after executor reopen; harmless inherited variables
such as NODE_VERSION/PYTHON are preserved. Comparison is order-independent and
rejects duplicate/changed entries, changed Entrypoint/Cmd/working directory, and
missing/extra/changed mounts. UID1000:1000, read-only rootfs, cap-dropALL,
no-new-privileges, and the existing CPU/memory/PID/log limits remain configured.

## Readiness and retained failure artifacts

Broker creates/starts wait for a **current registered and freshly proved** Hub
session for their exact grant's run, not merely Docker Running. The readiness
method is local to Hub and is not an HTTP API. `startupTimeoutMs` defaults to
20000 and permits100..120000 milliseconds. Existing Docker transport deadlines
still apply to Docker operations; readiness status requests use the remaining
startup budget, capped at five seconds each. Stop does not revoke or delete.

The Hub grant stores `provisionKey` under the existing writer lock and state/grant
budget. On retry/restart the broker finds the unique matching grant and either
validates the existing export or republishes a missing export from that **same**
grant. The deterministic name is
`registration-<backend-task-uuid>.json`. Changed labels, conflicting/partial
exports, ambiguous duplicate keys, or revoked grants fail closed, without minting
another grant. Revoked keys remain tombstones and are never recycled.

Failure handling deliberately retains artifacts:

- After a known container identity is durable, start/readiness failure retains
  that identity, its per-instance home, grant, export, and backend journal.
  A subsequent independently approved start can recover the same container;
  a missing export is republished using the same key. No duplicate home/run is
  created.
- An ambiguous Docker create/response or earlier failed operation leaves an
  `unknown` backend journal entry for trusted reconciliation. A grant/export,
  home volume, and possibly a container can remain. Retrying create does not
  blindly repeat mutation, adopt a guessed container, or mint another grant.
- Grant/export write ambiguity retains the durable grant, its charged export
  reservation, any partial export, and any state staging files/locks retained by
  the existing Hub writer. A missing export is recoverable; a mismatched/partial
  export needs explicit trusted operator review.
- This broker has no revoke/delete API. Even known pre-create failures may retain
  a grant; existing trusted local Hub administration can revoke it, preserving
  the tombstone. There is no automatic cleanup of private files, volumes, or
  containers.

There is no QQ screenshot-watcher lifecycle in this feature. A static screenshot
bind is not presented as a substitute. Real Docker validation of this new
split-identity/profile combination is a separate controller acceptance step;
unit/socket coverage is not a production deployment claim.

# Runtime updater integration — development only

This directory is a **reviewable source integration**, not a deployment bundle.
Do not copy it into a running Gate or use the branch's version picker in production.
The approved feature and release gate are in
[`../../docs/superpowers/specs/2026-10-22-hub-version-picker-updates-design.md`](../../docs/superpowers/specs/2026-10-22-hub-version-picker-updates-design.md).

## Ownership and scope

- `gate/gate/`: imported Gate implementation with branch-local catalog, artifact-resolution,
  readiness and trusted test-namespace changes.
- `gate/tests/`: imported runtime/lifecycle tests, their source dependencies and new unit tests.
- `pi-runtime/`: the image-owned supervisor, input guard, session-control and launch-policy
  baseline. These files are not installed or started by the Web extension.
- `provenance.json`: original source paths and original SHA-256 values, before branch edits.
  These are provenance records, not current-file checksums or deployment authorization.
  Source import may normalize a final newline.

No live configuration, policies, credentials, Gate database, private deployment records,
sessions or caches were imported. Ordinary npm installation excludes this integration area
via the package's `files` whitelist. Importing a Python module does not start Gate.

`gate/gatectl` is an imported host-CLI source snapshot used by client unit regressions.
It retains the production container-name default and must **not** be run against the
host Docker daemon or used by the isolated acceptance harness. No deployment entrypoint
is supplied by this integration directory.

## Current implementation boundary

Implemented in the development sources: bounded official version discovery and exact
integrity-pinned resolution; guarded npm transport; separate prepare, offline behavioral
validation and atomic activation; complete dependency-tree/profile evidence; measured
source admission; private pre-stop restoration with a bounded input-freeze lease; pinned
successor execution; idle-only refresh and conservative interrupted-operation recovery.
There is no Pi release-number allowlist. A newly published exact stable version can be
evaluated without editing one, but publication or installation is never compatibility
evidence. An incompatible adapter, session format, Node engine or image profile still
blocks the requested transition.

**Current-source isolated acceptance passed:** a real browser/Hub/Gate/Docker flow
upgraded two official Pi processes `1.3.0 -> 1.4.0` and rolled them back to `1.3.0`.
A generating consumer finished before its refresh; an incompatible-session rollback
was refused before stopping its original process. Exact evidence and limitations are in
[`../../docs/validation/2026-10-22-version-picker-progress.md`](../../docs/validation/2026-10-22-version-picker-progress.md).

No production Hub/Gate/Pi container was changed for this integration. User-authorized
local main integration is separate from a production deployment; ordinary extension
installation does not deploy Gate or image-owned supervisor/guard sources.

## Offline unit verification

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/gate/tests -p 'test_runtime_[!h]*.py'
```

This pattern deliberately excludes `test_runtime_http.py`, which opens a localhost TCP
server. `test_runtime_discovery_http.py` exercises the actual request handler/authentication
in memory; despite its filename, it is **not** a TCP integration test. External boundaries
are fixtures in the scheduler/engine tests; those do not establish Docker or Pi compatibility.

The complete runtime suite requires permission to bind a temporary local port:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/gate/tests -p 'test_runtime*.py'
```

## Isolated real-package acceptance

The dedicated `tests/runtime_test_bootstrap.py` factory requires
`runtime_volume='pi-runtime-update-test-<hex>'`,
where `<hex>` contains 12–32 lowercase hexadecimal characters. All other non-default
volume names are rejected. No HTTP/browser request may choose this setting.

Production retains the default `pi-runtime`. The test factory rejects that default,
omission and malformed alternatives before constructing Gate/RuntimeEngine or calling
the resource engine. Use the real acceptance harness below, with only
synthetic homes, sessions and workspaces, a faux model
provider, uniquely named containers and an explicit image identity. Never mount production
home/runtime/session volumes, SSH credentials, model credentials or the production Gate
state. Candidate execution must have no network and no production state access.

The opt-in real harness is `tests/real_version_acceptance.py`. It starts a temporary
Gate and built Hub, creates a new test runtime volume and two real official Pi processes,
then uses a real browser to select `1.4.0` and `1.3.0`. It checks actual process versions,
unchanged container identity, saved history/leaf, provider/model/thinking and browser
reconnection. `PI_RUNTIME_ACCEPTANCE_BUSY=1` also holds one real synthetic generation
until the other consumer has adopted the new version, then verifies its deferred refresh.
Only the model responses are simulated. `tests/probe_acceptance.py` and
`tests/candidate_acceptance.py` are narrower checks, not full transition acceptance.

Example, after building the dedicated image described by `tests/Dockerfile.acceptance`:

```sh
PI_REAL_DOCKER_TEST=1 PI_REAL_BROWSER_TEST=1 \
PI_RUNTIME_TEST_IMAGE=pi-runtime-update-test:<dedicated-test-tag> \
PYTHONDONTWRITEBYTECODE=1 python3 integrations/runtime-updater/tests/real_version_acceptance.py
```

When the installed Chromium differs from Playwright's default revision, explicitly set
`PI_E2E_BROWSER_EXECUTABLE` to the installed test browser. The harness must not install
or borrow user credentials to make a test pass. Evidence and screenshots are written
under `.tmp/runtime-version-acceptance/<unique-namespace>/` and cleanup uses exact IDs.

The required acceptance includes actual `1.3.0 -> 1.4.0`, compatible rollback,
incompatible-session refusal before stopping the source process, active-generation
deferral and mobile/browser checks. These passed on the frozen test image recorded in
the validation report. Recovery/fault-injection coverage is scheduler/transport fixture
coverage, not a real daemon-crash or power-loss experiment.
Cleanup must use recorded exact test resource identities; do not use broad prune commands.

## Restricted Hub Pi launches

This opt-in capability lets the trusted Hub management page request a new detached
Pi using an existing directory below one administrator-selected root. Gate owns
Docker execution; Hub and Pi receive neither the Docker socket nor the Gate admin
socket. No host shell, `.bashrc`, `.env`, browser-specified command, image, environment
or arbitrary mount is evaluated. Updating the extension alone does not enable it.

### One-time administrator setup

1. Keep the existing dedicated `gateManagement` credential and management-origin
   authentication. The ordinary request/lifecycle token cannot browse or launch.
2. Choose the deployment root `$HOME/gitproject` and initial `pi_projects`.
   Existing directories only; do not expose the entire home or host filesystem.
3. Under the private pi-docker runtime/config area, create **separate** profile and
   per-launch credential directories, outside the selectable project root and Gate
   state, mode0700, owned by Gate's effective UID. Install the JSON policy directly
   inside the profile directory, mode0600, same owner, no symlinks or hardlinks.
4. Gate must see the selectable root read-only **at the same absolute path as the
   Docker daemon**, plus the private per-launch credential directory read/write at
   its same absolute path. The profile and optional model source are read-only.
   Gate writes only the exact per-launch credential; Docker binds that file into Pi.
5. Provide an existing dedicated export directory inside the Hub, separate from
   the config parent, mode0700 owned by UID1000. Do not put exports in the shared Pi
   home or project. Keep Hub config/state private and its registry volume separate.
6. Resolve the **full immutable image IDs** for the normal Pi image and running
   Hub image, and the **full running Hub container ID**. Fill the policy below with
   those identities and existing local volume names. The engine does not create or
   populate runtime/home volumes; use the normal prepared runtime volumes.
7. Start the upgraded Gate with its existing arguments plus
   `--launch-policy /absolute/private/profile/launch.json`. Persist that option and
   the narrowly scoped mounts in the administrator's Compose configuration. No
   production Compose configuration is changed by installing this package.
8. Confirm `launch-config.enabled=true` through the authenticated management page,
   then test a noncritical directory. Pi runs as1000:1000 with cap-dropALL and
   no-new-privileges. Existing active sessions do not need to be stopped.

The example is a schema template, **not a runnable configuration**: replace path,
image and container placeholders using trusted host values. Do not include secrets
in screenshots, chat or tracked policy files.

```json
{
  "version": 1,
  "enabled": true,
  "root": "/absolute/home/gitproject",
  "root_label": "gitproject",
  "default_path": "pi_projects",
  "profile_root": "/absolute/private/profile",
  "credential_root": "/absolute/private/launch-credentials",
  "pi_image": "sha256:<64 lowercase hex>",
  "hub_image": "sha256:<64 lowercase hex>",
  "hub_container": "<64 lowercase hex>",
  "gate_provenance": {
    "mode": "container",
    "container": "<full running Gate container ID>",
    "image": "sha256:<immutable Gate image ID>"
  },
  "hub_config": "/hub/private/config.json",
  "hub_export_root": "/hub/exports",
  "volumes": {
    "home": "pi-user-home",
    "runtime": "pi-runtime",
    "config": "pi-home",
    "credentials": "pi-credentials",
    "cache": "pi-huggingface-cache",
    "hub_runtime": "pi-web-hub-runtime"
  },
  "environment": {},
  "auxiliary_binds": []
}
```

All fields except `auxiliary_binds` are required. Unknown fields fail closed.
For a containerized Gate, `gate_provenance` pins its own running container and
image. The engine resolves Gate's mounted private state/profile back to daemon
volume/bind sources and excludes those entire backing mounts from every Pi mount.
Unmapped/writable-layer private state and ambiguous backing paths fail closed.
For a Gate genuinely running directly on the Docker host, use only
`{"mode":"host"}` instead: this is an explicit trusted-administrator assertion
that Gate state/profile and the daemon share absolute path coordinates, not a
workaround for container path translation. Never use host mode for a Gate container.
`environment` allows only the documented proxy names, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `HF_TOKEN`, and the fixed model-sync path; no shell/loader/runtime
identity overrides. Prefer the existing credential mechanisms over new secret values.
An optional single readonly bind with exact keys
`{"source":"/absolute/model-config","target":"/run/cc-switch-pi-models","read_only":true}`
enables host-backed model configuration; the engine supplies
`PI_CC_SWITCH_MODELS_DIR=/run/cc-switch-pi-models`. Its source is no-follow,
revision-bound, outside project/private/system roots, and cannot alias Hub mounts.
No SSH, Docker or arbitrary auxiliary bind is supported in this first profile.

Recreating/upgrading Hub or Gate changes its immutable container/image identity: update
the private profile from the trusted host before permitting new launches. A stale
profile fails closed. Preserve old matching policy/credentials for recovery; do
not blindly edit a profile while it has unresolved side effects. A running Pi does
not monopolize Gate admission: ordinary deployments/runtime updates/restarts retain
priority over background launch status polling.

### Recovery and boundaries

`queued`, `starting`, `running`, `exited`, `failed`, `recovery_required` are separate
states. An unknown grant/create/start/delete result is never automatically retried.
Use the original job ID and trusted Gate state to inspect before intervening; this
release does not provide a general arbitrary recovery/delete endpoint. Grant
history is retained. Exited owned containers and verified temporary credentials
are cleaned without deleting volumes or projects. Stable Pi lifetime is independent
of Hub/Gate/browser lifetime; no auto-restart after host/Docker restart is promised.

Limits:16live/unresolved jobs,256retained jobs,200directories per page and4096scanned
entries. At the conservative scan ceiling the request fails409, not an incomplete
page. Full job storage refuses new work; no eviction or hidden cleanup. Shared
writable home/runtime/config volumes retain existing shared-state implications.
Path checks are an HTTP selection boundary, not protection against a malicious host,
daemon or same-UID concurrent filesystem attacker; Docker later resolves bind paths.

### Disposable launch verification

Focused Gate tests use real filesystem/SQLite/HTTP and a recording Unix Docker
boundary; `tests/hub-launch-live.test.ts` verifies real temporary Hub→Gate protocol.
`e2e/hub-launches.visual.ts` is synthetic rendered desktop/phone validation, not E2E.
The separate real launch harness requires explicit opt-in and immutable **test**
images. It creates unique `pi-launch-test-<random>-*` resources only, seeds a synthetic
Pi configuration with an image-owned faux provider, launches detached, checks real
Hub registration, duplicate submission and owned exit cleanup, then removes only
its exact created resources. No model/API request or production mount is used.

```sh
PI_REAL_DOCKER_TEST=1 \
PI_LAUNCH_TEST_IMAGE=sha256:<dedicated-Pi-test-image-id> \
PI_LAUNCH_TEST_HUB_IMAGE=sha256:<compatible-Hub-test-image-id> \
PYTHONDONTWRITEBYTECODE=1 \
python3 integrations/runtime-updater/tests/real_launch_acceptance.py
```

The test Pi image must contain the image-owned mirror extension and
`e2e/fixtures/runtime-update-provider.ts`, as in `tests/Dockerfile.acceptance`.
Evidence is under `.tmp/launch-acceptance/<namespace>/`; a failed daemon call is
not proof that its resource was never created. Check deterministic names before
cleanup and never use a global prune command.

The harness journals every exact creation intent before dispatch. It reconciles
ambiguous results without replay and removes only positively proved test resources
(containers by full immutable ID). Independent teardown failures do not suppress
the original error or skip evidence: inspect `cleanup_errors` and `residual_targets`.
`cleanup: false` includes unresolved in-flight creates; it is not permission to
remove resources whose ownership cannot be proved.

Daemon-free fault regression for that accounting, not real launch acceptance:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/tests -p 'test_real_launch_acceptance.py' -v
```

Offline bootstrap regressions (no Docker resources are created):

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/tests -p 'test_runtime_test_bootstrap.py'
```

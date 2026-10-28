# Scoped create rollout review — 2026-10-27

## Verdict

No blocking issue found for the explicitly authorized local rollout and its
configured requester/admin URLs. One **P2 configuration correctness finding**
remains in the new `managerLinks` validation; it does not affect the URLs emitted
by the installation helper. This is a scoped code/deployment-contract review,
not a claim that live rollout acceptance has completed.

## Scope and evidence boundary

- Requirements: `docs/superpowers/plans/2026-10-27-hub-create-pi-rollout.md` and
  the review request's explicit deployment constraints.
- Reviewed the relevant portions of
  `/tmp/pi-manager-create-runtime-WUO7UmDv/review.patch`: new manager-link
  configuration/rendering/wiring and custom Manager-token compatibility.
- Read `tests/hub-manager-links.test.ts`, `tests/manager-gateway-auth.test.ts`,
  the browser-header regression in `tests/manager-version-query.test.ts`,
  `deploy/local/enable-stack-create.mjs`, and the installed
  `/home/fate/docker_files/pi-stack/compose.yaml`.
- Followed only the immediately relevant URL, HTTP-authentication, workspace,
  enrollment-permission and runtime-mount contracts. Older uncommitted broker
  and backend implementation is not independently re-reviewed here.
- The controller reports a fresh passing `npm test` run: 545 unit / 320 gate /
  49 runtime, with conditional skips, plus prior independent backend review and
  realDocker acceptance. These are supplied evidence, not tests rerun here.
- No subagents, secret/config-content reads from the installed deployment,
  Docker commands, network requests, deployments, rebuilds or full test runs.
  The only repository write made by this review is this report.

## Finding

### [P2] Reject empty query delimiters in canonical Manager root links

**Location:** `hub/config.ts:118–121` (`managerLinksConfig`'s root validator).

The new validator accepts `https://requester.example/?` and returns it unchanged.
Its shared helper checks `URL.search`/`URL.hash` for truthiness, but an empty query
has `search === ""` while the serialized `href` still ends in `?`. Checking only
`pathname === "/"` therefore does not establish the required exact root URL.
The portal retains that address in the requester link. A request with the
resulting target `/?` fails `manager/http.ts:25` with HTTP 400, before the Manager
landing page is served. The same root validator handles administrator links.

An in-memory probe against the actual validator, renderer and HTTP boundary
produced:

```text
input https://requester.example/    -> href unchanged; GET /  accepted
input https://requester.example/?   -> href unchanged; GET /? rejected, status 400
input https://requester.example/#   -> href unchanged; GET /  accepted
input https://requester.example/?x=1 -> configuration rejected
input https://requester.example/#x  -> configuration rejected
```

The HTTP requests above were synthetic `IncomingMessage` objects, not live
browser/gateway requests. They establish the accepted-config/request-boundary
mismatch; gateway normalization was not tested. The empty fragment is a related
canonicalization gap, but is not itself the HTTP failure because fragments are
not sent in the request target.

**Suggested correction:** after the shared validation, require the serialized
URL to equal `parsed.origin + "/"`, or deliberately normalize away empty query
and fragment delimiters before returning it. Add regression cases for both
requester and administrator links. Do not relax the Manager HTTP boundary.

**Rollout impact:** neither `https://pi-admin.swordfate.cn/` nor
`http://127.0.0.1:18302/` contains this suffix; the helper constructs these clean
root links. This finding is not a blocker for those exact URLs. No fix was made.

## Checks with no additional findings

### Navigation and gateway authentication

- Chat's strict key allowlist admits `managerLinks`; `readHubConfig` validates
  its contents before Hub startup. Unknown link keys, missing requester,
  non-root paths, nonempty queries/fragments, user-info credentials, non-loopback
  HTTP and overlapping Chat/requester/admin origins are rejected. Normal URL
  canonicalization precedes origin comparison, subject to the finding above.
- The Chat portal receives the validated links and renders escaped, link-only
  navigation to the independent root pages. The new links do not carry tokens
  or initiate approval. The public-requester/private-loopback-admin pair has an
  explicit local-only administrator label. Omitting links preserves the legacy
  management navigation; omitting only the administrator does not reintroduce
  a legacy administrator entry.
- The Manager browser API helper sends `X-Pi-Manager-Token` and does not replace
  the browser's gateway `Authorization`. Its requests remain same-origin.
  Server authentication still supports direct Bearer clients, bounds token
  syntax/length, and rejects duplicate custom headers or simultaneous custom
  and Authorization credentials. Host and Origin checks remain unchanged.
- In-memory authentication probes confirmed custom-only and Bearer-only
  success, and rejection of duplicate custom headers, Bearer-plus-custom and
  Basic-plus-custom. Thus the authorized gateway's removal of `Authorization`
  is necessary, not optional. Basic is not silently treated as Manager
  authority. The requester route remains unable to approve/execute/review;
  private administrator sessions retain their separate authentication path.
- Relevant generated Chat/Hub/public/admin bundles contain the new link or
  header code. This was a presence check, not a complete bundle-provenance or
  running-image verification.

### Installed deployment and provisioning contracts

- Installed executor identity is `21001:21001`, with supplementary groups
  `22002`, `22003`, `22004`, and Docker-access GID `1001`. Only executor mounts
  `/var/run/docker.sock`. This is the explicitly authorized raw-Docker trust
  boundary, not a restricted socket proxy or an untrusted-container boundary.
- Installed Chat identity is `1000:1000` with supplementary GID `22004`.
  The helper creates the enrollment directory as `1000:22004`, mode `2750`,
  and requests broker socket mode `0660`. The setgid directory supplies the
  shared socket group. Chat has the writable broker directory; executor's
  read-only bind reaches the same directory at its configured host-coordinate
  socket path. Executor does not receive Chat's private grant/export mounts.
- Executor's `/home/fate/gitproject` browser bind is read-only at identical
  host/container coordinates. `/home/fate` is an ancestor generated for nested
  mounts, **not a bind of the host home**. The helper protects
  `/home/fate/gitproject/codex_project_v2`; the existing selection contract also
  rejects selecting an ancestor that would include a protected subtree.
- The existing Pi creation contract uses a separate writable bind of the
  selected workspace at `/workspace` and a per-instance home volume. Executor's
  read-only browser mount does not turn that Docker-daemon-created workspace
  bind read-only. Runtime/model/web/registration inputs remain read-only mounts;
  no host-home or Docker-socket mount is added to created Pi containers.
- Docker state, fixed Web package, models-file path and enrollment socket mounts
  match the helper's executor-visible paths. Registry/export paths are daemon
  source coordinates; their absence as executor mounts is intentional, not a
  missing-mount defect.
- The helper checks root identity, installation marker, a digest-shaped fixed
  image ID, empty executor backend/workspace state and absent Chat provisioning.
  It copies all four role configs into a new private backup directory before
  creating enrollment authority or replacing any role config. Backups are
  root-owned mode `0600`; new role configs use exclusive temporary files and
  per-file atomic rename. It contains no Docker API/CLI invocation, volume
  mutation or secret logging. It is intentionally one-shot, not a transactional
  multi-service deployment/retry tool.
- The helper sets the public requester origin and leaves the administrator
  config untouched. Manager HTTP listeners bind loopback; installed services
  use host networking. The private administrator remains a loopback service,
  and the authorized public requester depends on the existing gateway.

## Verification and handoff limits

Fresh checks performed during this review:

- Read-only, in-memory URL/render/HTTP-boundary and authentication probes using
  `node --import ./tests/register-ts.mjs --input-type=module`; exit 0, with the
  finding and authentication results recorded above.
- `node --check deploy/local/enable-stack-create.mjs`; exit 0.
- Scoped `git diff --check` for the changed Hub/Chat/HTTP/UI/browser-test files;
  exit 0, no whitespace errors.

The Docker skill guided identity, mount-coordinate and socket-group checks;
systematic-debugging guided the isolated URL reproduction. Completion
verification is limited to these observed checks, not a fresh full-suite claim.

The existing Caddy Basic configuration and its Authorization stripping are
accepted deployment premises supplied by the requester, not independently read
or exercised here. Installed private JSON configs, credential contents, actual
container state, socket ownership at runtime and the prepared image contents
were not inspected. Live portal navigation, gateway-authenticated API access,
independent approval, creation/registration/HTTP/WS acceptance and preservation
of existing Pi containers remain controller-owned rollout acceptance steps.

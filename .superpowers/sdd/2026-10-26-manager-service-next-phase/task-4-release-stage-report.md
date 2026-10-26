# Task 4 release staging sidecar report

Date: 2026-10-26.

## Result and scope

Implemented the approved first-half, **artifact-only** release catalog and private
staging sidecar. Prepared outputs are explicitly `prepared-unverified`,
`runnable: false`, `dependencyClosure: "not-installed"`, and
`activation: "not-attempted"`. This is not a successful runtime update, a runnable
dependency installation, a compatibility grant, or a deployment/activation claim.

Owned files: `manager/updates/{catalog,stage,release,transport,json,archive,engine,errors}.ts`,
`manager/updates/README.md`, three `tests/manager-updates-*.test.ts` files, and this
report. No lifecycle/engine/API/MCP/UI/config/native/Docker/package/lock/build/dist
files were edited or staged by this task. Existing controller changes were left
alone. No subagents, candidate commands, npm dependency installs, personal model
calls, live services, production state, or deployment were used.

## Implemented capabilities

- Official catalog: construction-only administrator extension allowlist plus
  `@earendil-works/pi-coding-agent`; dynamically discovered future stable exact
  versions; numeric sorting, prefix search, snapshot-bound pagination; coalesced
  300-second cache with explicit fresh/stale/unavailable states and 30-second
  failure retry suppression.
- Bounded direct HTTPS: 8 MiB/8 seconds/20,000 version keys for metadata; 32 MiB/
  30 seconds for artifacts. No redirects, alternative hosts, URL credentials,
  ambient npm/proxy settings, inherited TLS verification override, or process.env
  mutations. A private agent and explicit bundled certificate roots are used.
  The default transport requests abbreviated npm metadata.
- Metadata validation: strict UTF-8 and JSON, including escaped duplicate keys;
  exact package/version, canonical official tarball, canonical 64-byte SHA-512
  integrity, declared engine range; frozen resolved record and deterministic
  SHA-256 identity for the controller's immutable task binding.
- Private artifact staging: exclusive new canonical root, validated ownership,
  marker-based reopen, root identity rechecks, filesystem-exclusive per-installation
  writer locks, duplicate/incomplete candidate refusal, and no automatic stale-lock
  reclaim. Files and directories are created exclusively and made read-only after
  preparation. Failures do not change live pointers or installed files.
- Archive validation before extraction: SHA-512 first, gzip/USTAR checksum and
  termination checks, bounded expanded/tree sizes and entry/depth counts, exact
  manifest identity/engine, refusal of traversal, aliases, duplicate entries,
  links, special files, PAX/GNU extensions, and file/directory collisions.
- Evidence: original artifact, extracted package, frozen receipt, normalized
  content hash, exact executable paths/content hashes, and artifact lockfile hash
  when present. No absolute private path or raw transport error appears in public
  receipt/error fields. Candidate scripts and binaries never run.
- Node checking: conservative exact, `>=X.Y.Z`, or `>=X.Y.Z <X.Y.Z` grammar.
  Unsupported expressions fail as `engine-unsupported`; known unsatisfied ranges
  fail as `node-incompatible`. No undeclared semver dependency was introduced.

## API handoff

`catalog.ts`: `new ReleaseCatalog({extensionPackages?})`,
`list(packageName, {query?, cursor?, limit?})`,
`resolve(packageName, exactVersion)`, `CatalogError`, `PI_PACKAGE`,
`ResolvedRelease`, and trusted `OfficialTransport` type.

`stage.ts`: `await ArtifactStager.create({root, extensionPackages?, nodeVersion?})`,
`await ArtifactStager.open(options)`,
`await stager.stage({installationId, release, expectedIdentity})`,
`StageError`, `StagerOptions`, `StageRequest`, and `PreparedArtifact`.

The controller must persist the catalog-resolved release and identity in its
authoritative task and supply that persisted identity to staging. A browser's
self-computed hash is not authority. Root/allowlist/Node selection/transport are
trusted construction inputs, not task payload options. Every writer for one
installation must share the same canonical root and installation ID.

See `manager/updates/README.md` for exact bounds, hash recipe, recovery semantics,
API usage, safe error serialization, trust assumptions and controller obligations.

## TDD and verification evidence

1. Added catalog tests before implementation; observed **6 failing assertions**
   that `ReleaseCatalog` did not exist. Implemented catalog; all 6 passed.
2. Added stage tests before implementation; observed **8 failing assertions**
   that `ArtifactStager` did not exist. Implemented stage; initial tests correctly
   exposed an overly narrow UID-0 ancestor assumption in this mount namespace.
   Read-only metadata showed `/` and `/tmp` owned by mapped UID 65534; the policy
   now uses the filesystem root's observed system owner while retaining exact
   private executor ownership of the staging root. All 8 passed afterward.
3. Added a default HTTPS policy regression; observed RED for requesting full
   `application/json` metadata instead of npm's abbreviated representation.
   Fixed the request header; test passed.
4. Expanded adversarial coverage to **23 focused tests**: future releases,
   stale/unavailable/recovery, coalescing, pagination expiry, metadata/source/hash
   mutations, unsupported/incompatible engines, scripts never executed, live
   pointer preservation, separate writer handles, cross-installation preparation,
   duplicate/orphan stage refusal, unknown packages, extension artifacts,
   lockfile evidence, special files/aliases/collisions, corrupt/truncated archives,
   stream deadlines, response redirection, bounded download overflow, and TLS
   request policy.

Verification command (Node v22.19.0):

```sh
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none \
  tests/manager-updates-catalog.test.ts \
  tests/manager-updates-stage.test.ts \
  tests/manager-updates-transport.test.ts
npm run typecheck
git diff --check
```

Focused test result: **23 passed, 0 failed, 0 skipped**. Typecheck: passed on the
latest checked shared tree. An earlier typecheck found a controller-owned Docker
typing error; this task did not edit it and later checks were clean.

The default process-isolating test runner initially returned only a child-file
failure in this environment; direct execution provided the actual RED evidence,
and Node's supported `--experimental-test-isolation=none` runs the complete
focused suite with normal per-test evidence. No build was run because it would
rewrite controller-owned distribution files. No public registry/live artifact
test or full update acceptance was performed. Request-boundary HTTPS tests do not
constitute an external network/TLS acceptance test.

## Deliberate limits / remaining work

- Strict gzip/USTAR subset only. PAX/GNU long-path records, nonportable filenames,
  overly large trees and unknown engine grammar are refused; not every npm
  package is supported. The parser is a small custom strict USTAR validator over
  Node's gzip primitive, not a claim of an independently audited tar library.
- No recursive dependency closure, npm subprocess or lifecycle execution. Unsafe
  dependency declarations remain inert bytes; no dependency sources are resolved
  or downloaded. An artifact package-lock hash is not a lock of installed code.
- Prepared tree is read-only against accidental writes, not hostile same-UID/root
  mutation. Genuine executor ownership/isolation must be provisioned; controller
  must revalidate provenance/content before future execution/activation.
- Orphaned locks and partial IO directories require explicit reconciliation.
  No recovery, deletion, pruning, aggregate storage quota or global concurrency
  admission policy was added. Individual artifacts/trees are bounded.
- Candidate execution, actual PTY/Web/session compatibility, task integration,
  generation/input fencing, activation, compatible rollback, UI and deployment
  remain controller work. No `--version` probe was used or counted as acceptance.
- Review was inline because subagents were prohibited; this report is not an
  independent security review or production approval.

## Commit boundary

Commit only the explicit owned paths listed above and this report. The report is
under the repository's ignored `.superpowers` directory and must be added by its
exact path with `git add -f`; do not add that directory wholesale. Use an
explicit-path `git commit --only` so unrelated controller index changes cannot
enter this task's commit.

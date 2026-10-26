# Official release artifact preparation

Executor-private sidecar, not an update/activation implementation. Every prepared
result is `prepared-unverified`, `runnable: false`, `dependencyClosure:
"not-installed"`, and `activation: "not-attempted"`.

## Entry points

`catalog.ts` exports `ReleaseCatalog`, `PI_PACKAGE`, `ResolvedRelease`,
`OfficialTransport`, and `CatalogError`.

- `new ReleaseCatalog({ extensionPackages? })`: Pi is always approved; extensions
  are copied from the administrator's construction-time list (at most 100).
- `list(packageName, { query?, cursor?, limit? })`: descending exact stable
  `X.Y.Z` releases, numeric-prefix search, 1–100 results per page (default 50).
  Snapshot-bound cursors also bind the package, query and page size.
  The frozen result reports `fresh`, `stale`, or `unavailable`.
- `resolve(packageName, exactVersion)`: fresh official exact-version metadata,
  not a cached compatibility decision. Returns a frozen package/version,
  canonical tarball, canonical SHA-512 integrity, declared Node range, and
  deterministic SHA-256 `identity`.

`stage.ts` exports `ArtifactStager`, `StagerOptions`, `StageRequest`,
`PreparedArtifact`, and `StageError`.

- `await ArtifactStager.create({ root, extensionPackages?, nodeVersion? })` creates
  a **new**, absolute, canonical private root. The parent must already exist, be
  owned by the executor, and not be group/other-writable. Ancestors must be
  trusted; system-owned sticky temporary ancestors are supported, including
  mount/user namespaces. Root mode is 0700. Existing roots are never adopted by
  `create`, even if empty.
- `await ArtifactStager.open(options)` reopens an existing private staging root
  bearing the exact private layout marker. It is not a recovery/reconciliation
  API. It does not reclaim locks or incomplete stages.
- `await stager.stage({ installationId, release, expectedIdentity })` verifies
  the binding, engine, downloaded integrity, archive policy, and exact manifest;
  writes a new artifact/tree/receipt; and returns frozen preparation evidence.
  Installation IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.

The controller must resolve and **persist** the release and its identity in the
authoritative immutable task before approval. `expectedIdentity` must come from
that persisted task, not from a browser-supplied hash. A content hash is a binding,
not a signature or an authorization grant. Keep the construction options and
transport injection seam private to the trusted executor.

An executor-side call sequence (variables are administrator/task-store inputs):

```typescript
const catalog = new ReleaseCatalog({ extensionPackages: approvedExtensions });
const release = await catalog.resolve(PI_PACKAGE, exactRequestedVersion);
// Persist release + release.identity in the authoritative task and obtain approval.
const stager = await ArtifactStager.create({ root: newPrivateStageRoot });
const prepared = await stager.stage({
  installationId: installationKey,
  release: persistedTask.release,
  expectedIdentity: persistedTask.releaseIdentity,
});
// prepared.status is only "prepared-unverified". Do not switch a live pointer.
```

All writers for an installation must use the same canonical staging root and
installation ID. A filesystem-exclusive writer lock covers download through
receipt creation, across handles/processes. Other installations may prepare in
parallel. A duplicate candidate is refused, not overwritten or implicitly
accepted. Locks left after a process crash and directories left after partial IO
require explicit administrator reconciliation; they are never automatically
replayed or deleted. Failure to release the exact owned lock also fails closed.

## Bounds and refusal policy

| Boundary | Fixed policy |
| --- | --- |
| Metadata | 8 MiB; 8-second total transport deadline; at most 20,000 version keys |
| Cache | 300-second freshness; coalesced refresh; 30-second failure retry delay |
| JSON | Strict UTF-8, duplicate decoded-key refusal, nesting <=64, <=500,000 values |
| Artifact download | 32 MiB compressed; 30-second total transport deadline |
| Archive | 128 MiB expanded tar; 64 MiB file contents; 20,000 headers/tree nodes including implicit directories; depth <=32 |
| Manifest | 1 MiB; exact package/version/Node-engine match |
| Filesystem | New exclusive files only; root/installation directories 0700; prepared directories 0500; prepared files 0400 |

Transport uses only canonical HTTPS `registry.npmjs.org` destinations, a private
HTTPS agent, explicit certificate verification with bundled roots, and no
redirect following, cookies, registry credentials, ambient proxy configuration,
npmrc, or global environment/TLS changes. Metadata requests use npm's abbreviated
representation. Status changes, response-URL changes, compressed HTTP encoding,
declared/chunked excess and length mismatches are refused. The trusted test
transport must honor its abort signal; it cannot select an executable or argv.

Stable versions are canonical numeric `X.Y.Z` with safe integer components;
prereleases, tags, ranges, and build suffixes are not selectable. Node engine
checking deliberately supports only `X.Y.Z`, `>=X.Y.Z`, and
`>=X.Y.Z <X.Y.Z`. Unknown grammar yields `engine-unsupported`; an unsatisfied
known range yields `node-incompatible`. The selected runtime version defaults
to the executor's Node and may only be overridden at administrator construction.
This is a declared-engine comparison, not an execution or compatibility probe.

Archive support is a strict gzip/USTAR subset, not a generic tar extractor. It
checks checksums and termination before extraction and refuses PAX/GNU extension
records, links, device/special files, duplicate paths/case aliases, unsafe or
nonportable spellings, absolute/traversal paths, and file/directory collisions.
Consequently some otherwise legitimate npm packages are deliberately unsupported.
No package script, executable, shell, npm installer, or dependency resolver runs.
Dependency declarations are inert artifact content, not approved/resolved sources.

## Evidence and integration boundary

`candidateKey` is relative to the private root:
`sha256(installationId)/release.identity`. It is not a public filesystem path.
The directory contains `artifact.tgz`, `package/`, and `receipt.json`.

The receipt records the release/integrity binding, checked Node version,
normalized package-tree content SHA-256, each declared executable's exact relative
path and SHA-256, and a package-lock SHA-256 **only if present in the artifact**.
The tree hash is SHA-256 of compact JSON rows sorted lexically by canonical path:
directories `[path, "directory", 320]`; files
`[path, "file", 256, byteLength, contentSha256]`. It covers the normalized package
tree, not the sibling artifact or receipt. Artifact integrity is recorded in the
release. A lockfile hash does not establish installed recursive dependencies.

Files are made read-only to prevent accidental mutation; the owning UID/root can
still change them. This is not isolation against hostile same-UID writers. The
controller must provision genuine private executor ownership and revalidate
content/provenance before any future execution or activation. Results contain
no absolute root path. Public errors should serialize only the stable `code`
and safe `message`, never an Error stack.

Not implemented here: dependency closure/npm staging, candidate execution, actual
Web/PTy/session compatibility, task/lifecycle integration, input/generation
fencing, activation, rollback, deployment, pruning, or aggregate disk/concurrency
quotas. Individual downloads and trees are bounded; admission control and storage
quotas across installations remain controller/administrator responsibilities.
The API deliberately provides no activation method and never touches a live
pointer or shared/root `node_modules`.

## Offline verification

```sh
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none \
  tests/manager-updates-catalog.test.ts \
  tests/manager-updates-stage.test.ts \
  tests/manager-updates-transport.test.ts
npm run typecheck
```

The tests use generated real gzip/USTAR bytes, actual temporary files, and fake
official transport responses. HTTPS policy is tested at the request boundary.
No public registry/download or production acceptance is claimed by these tests.

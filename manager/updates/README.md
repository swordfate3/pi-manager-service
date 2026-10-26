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

`stage.ts` exports `ArtifactStager`, `StagerOptions`, `StagingQuota`, `StageRequest`,
`PreparedArtifact`, and `StageError`.

- `await ArtifactStager.create({ root, extensionPackages?, nodeVersion?, quota? })` creates
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

All artifact writers for one executor/resource budget must use the **same
canonical staging root**, even for different installation IDs. A filesystem-exclusive
root-wide lock (`.artifact-writer.lock`) covers admission, download, decompression,
and receipt creation across handles/processes. Only one artifact preparation is
admitted at a time; competitors receive `writer-busy` immediately, without an
in-memory wait queue or download. The per-installation lock is retained, including
refusal of pre-existing locks. A duplicate candidate is refused, not overwritten
or implicitly accepted. Locks left after a process crash and directories left
after partial IO require explicit administrator reconciliation; they are never
automatically replayed or deleted. Failure to release the exact owned lock also
fails closed. Stop older staging writers before using this implementation; mixed
versions that do not honor the root-wide lock cannot share its guarantees.

### Administrator quota settings

`quota` is an optional `Partial<StagingQuota>` supplied **only at construction**:

| Setting | Default | Accepted ceiling |
| --- | --- | --- |
| `maxRetainedBytes` | 512 MiB | 16 GiB |
| `maxRetainedEntries` | 100,000 | 200,000 |
| `maxCandidates` | 8 | 128 |

Values must be positive safe integers. Unknown option/quota keys and invalid
values fail with `options-invalid`; stage requests containing quota or other
unknown fields fail with `release-invalid`. Construction options, the package
allowlist and quota are copied before the first await; the snapshots are frozen.
The effective quota is persisted in the read-only, size-bounded root marker.
`open({root, ...})` adopts that persisted quota. If `quota` is also supplied to
`open`, its values plus defaults must exactly match the persisted policy, or it
fails with `options-invalid`; opening another handle cannot raise a root's limit.
Original v1 markers remain readable with the default quota, without rewriting
the marker, candidates, or locks. There is no live quota-edit API.

Under the global lock, each admission walks actual retained state with streaming
directory reads (buffer size 1), not `readdir` arrays or receipt-based counters.
It counts every file/directory, including the root, marker, installation roots,
locks and partial candidates; all directories directly under installation roots
count as candidates even without a receipt. It counts regular-file **logical byte
lengths**, so sparse/partial files are charged too. No file content is read by the
scan. Links, special files, unknown root layout, nonprivate or foreign-owned
entries fail closed. The walk stops as soon as a quota is exceeded; depth is also
bounded to 34 below the root (32 archive components plus installation/candidate).
It retains at most 35 directory handles and a constant-size entry buffer per level.

Before download, decompression or candidate writes, admission reserves a full
worst-case new candidate: **97 MiB** (32 MiB artifact + 64 MiB extracted files +
1 MiB receipt), **20,004 new entries** (20,000 tree nodes plus installation,
candidate, artifact and receipt), and one candidate slot. Existing control files
and the two acquired locks are already counted. Even a tiny release is refused
with `resource-limit` if this full reservation does not fit; a new empty root
needs at least 20,008 entries and 97 MiB plus its marker bytes to admit work.
Reservations are held by the exclusive lock, not an optimistic in-memory counter.
The lock is synced before substantial work and survives a process crash. After
explicit lock reconciliation, the next admission recounts every remaining
partial file/directory. Normal failures release only this call's owned locks;
partial candidates are retained and charged. The receipt stays unchanged and
`prepared-unverified`.

These bounds constrain one shared root and one active bounded download/archive
parser, not arbitrary additional roots or other executor work. The byte budget
is not a filesystem block/free-space quota: filesystem metadata and allocation
rounding are separate from logical file lengths (entry count is independently
bounded). Provision appropriate filesystem space/isolation as well. Tiny budgets
can deliberately refuse all staging. No automatic pruning or stale-lock recovery
is performed; exhaustion requires explicit administrator action.

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
fencing, activation, rollback, deployment, or pruning. Aggregate admission and
retained-state quotas across installations are enforced within the shared root;
provisioning that root and explicit exhausted/crashed-state reconciliation remain
administrator responsibilities.
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

# Pi Manager Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved standalone Manager with isolated lifecycle execution, a shared task interface for Web/MCP, Docker support and verified update boundaries before a production migration.

**Architecture:** Keep the existing Hub routing protocol and separate public transport from the sole authoritative executor. Native and Docker lifecycle adapters consume administrator-fixed profiles, never browser-provided executable arguments. MCP submits to the same authenticated task gateway; approval remains on the independent administrator plane.

**Tech Stack:** Node >=22.19, TypeScript, private Unix IPC, Docker Engine Unix API, MCP server/client 2.4.0 and Node adapter 2.1.2 verified against the official npm registry on 2026-10-26.

**Spec:** `docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md`; continue accepted Tasks1–2 and unfinished Tasks3–4 in `2026-10-26-manager-service-next-phase.md`.

## Global Constraints

- Public HTTP/MCP entry does not hold the Docker socket, administrator approval credentials or native executable authority.
- Executor independently authenticates and validates every request, including direct requests bypassing the public proxy.
- Same-UID native mode is explicit trusted-local development, not hostile-Agent isolation. Production isolation requires provisioned separate permissions or Docker.
- Only the executor writes authoritative tasks; immutable requests, independent exact approval, revision CAS and requester-scoped idempotency apply across both transports.
- No operation takes over arbitrary existing PIDs/containers. No caller-controlled shell/argv/mounts/credentials.
- Never silently replay unknown outcomes. Preserve task data and exact owned resource identities across restart.
- Candidate verification and generation/input fencing precede stopping a running consumer or activating shared installs.
- Tests use synthetic credentials, temporary HOME/state/config and only new opt-in Docker resources. Existing Hub/Gate/Pi, real workspace data, domains and tunnels stay untouched.
- Source completion is not deployment authorization. Do not push, publish, merge or switch production as part of tests.

## Task 1: independent service and native closed loop

Files: the scoped Task3 brief under `.superpowers/sdd/2026-10-26-manager-service-next-phase/`; add `manager/{config,service,main}.ts`, `manager/executor/` and focused HTTP/CLI tests. Preserve old Hub CLI as a compatibility command.

- [ ] Run real HTTP RED for a zero-Pi page, pending task with no child, principal-derived requester, forbidden self-approval and Host/Origin rejection.
- [ ] Implement separate submit/query/dispatch and administrator transports, durable exact approval, bounded connection handling and secret-free errors. Use unchanged authoritative TaskStore transitions where possible.
- [ ] Implement administrator-root choices, task review/status UI and distinct management origin. Do not give a chat login blanket approval authority.
- [ ] Run native fixture tests and real Pi with deterministic provider; create/enroll/chat/stop acceptance uses an explicitly selected standalone Web installation, not neighboring source imports.
- [ ] Rebuild and test packaged entry with an empty temporary HOME. Restart must preserve task queries and not adopt native processes from reusable PIDs.

## Task 2: Docker lifecycle adapter

Files: `manager/backends/docker.ts`, `manager/backends/docker-engine.ts`, private identity/journal helper if needed, `tests/docker-backend.test.ts`, `integration-tests/docker-lifecycle.test.ts` and deployment examples.

Interfaces: `create({instanceId,workspace:{root,path}})`, `inspect(instanceId)`, `list()`, `stop(instanceId)` and explicit restore/start. Only admin config fixes daemon socket/ID, exact image digest, safe user, network profile, allowed roots and volumes. Do not infer the Docker daemon's filesystem coordinate system from a container cwd.

- [ ] First RED against a disposable Unix HTTP daemon: invalid roots/symlinks/extra fields never create resources; changed daemon/image/owner labels never stop a target.
- [ ] Implement bounded Engine transport with deadlines and ambiguous-mutation errors, private durable ownership journal, fixed dropped-capability/read-only-root/resource-limited container definitions and opt-in narrow network/mount configuration.
- [ ] Journal planned identities before mutation. Lost create/start responses leave unknown/reconciliation-required state; never blindly retry a mutation or delete mismatched resources.
- [ ] Persist home/session data separately from container writable layers; stop leaves data intact. Bind only the selected workspace and single per-instance registration credential; never manager state or Docker socket.
- [ ] Opt-in real new-container test: create, register, chat, stop, recover with the same test home, then verify all preexisting containers are unchanged. Cleanup only exact owned new IDs/labels; retain evidence on cleanup failure.

## Task 3: MCP and shared task gateway

Files: `manager/mcp/server.ts`, MCP transport tests, package/lock/build wiring, user connection documentation. Runtime dependencies must be exact and integrity-locked; development SDK client is test-only.

- [ ] First RED with the official SDK client: initialize/list tools, submit one restricted task, retrieve its persistent ID; unknown tool, excess fields and self-approval are rejected.
- [ ] Use official Node Streamable HTTP transport in stateless JSON response mode, request-local server/client lifecycle and common authenticated task gateway. Do not implement an ad hoc lookalike JSON-RPC protocol.
- [ ] Permit only task submission and scoped read queries. Check exact Host, Origin when present, bearer principal/audience, body/connection/deadline bounds before transport. No credential in query or generated HTML.
- [ ] Disconnect the SDK client, query the same task from HTTP, restart service and query again. Actual isolated Pi `mcp list` verifies its HTTP client; no user `mcp.json` or authentication file changes.
- [ ] Package must resolve declared SDK dependencies after actual offline tarball extraction. Isolated staging installs cannot mutate the shared development `node_modules` target.

## Task 4: Pi and extension update integration

Files: focused `manager/updates/` modules, executor handlers, management version/extension UI, native/Docker activation integration tests. Reuse audited Gate verification primitives where compatible; do not copy legacy source/volume assumptions into the general product.

- [ ] First RED for exact official release identity, integrity mismatch, unsupported Node version and unsafe source refusal. Versions come from an approved catalog, not a fixed allowlist of two releases.
- [ ] Stage candidate in a new version directory, scripts disabled, bounded official-origin downloads and archive validation. Record source identity and private verification evidence before approval/activation.
- [ ] Verify candidate with deterministic provider, actual Web registration and session compatibility before touching live processes. A `--version` command alone is not acceptance.
- [ ] Lock shared installation and every affected input/generation channel. Pending generations become waiting_idle; after acquiring the fence recheck settled state and reject new input until activation/restore completes.
- [ ] Prove upgrade, compatible rollback and incompatible-session rejection before stop. Ambiguous activation is unknown and requires explicit reconciliation, never automatic replay.
- [ ] Extension install/update/remove uses the same task queue, explicit source/locked resolved revision, private staging and fenced activation. Failure preserves installed version and unrelated extension configuration.

## Task 5: delivery gate

- [ ] Full test/type/build/integrity and actual packed installation with isolated state.
- [ ] Independent security/spec review; resolve important findings with targeted regression evidence.
- [ ] Actual desktop/mobile viewport browser screenshots and bounded-history/WebSocket session tests.
- [ ] Document one installation/start path, data directories, isolated deployment, migration dry-run and rollback; no private host paths required for other users.
- [ ] A deployment-ready claim requires all applicable acceptance results above, not a passing probe or successful build. Otherwise keep the branch explicitly developmental and list the precise remaining work.

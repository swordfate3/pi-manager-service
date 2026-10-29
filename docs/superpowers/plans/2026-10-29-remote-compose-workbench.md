# Remote Compose Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update and run Manager/Hub from remote Git source through Docker Compose without a local development checkout.

**Architecture:** A remote-build updater resolves an exact Git commit and builds `deploy/stack/Dockerfile`. Host-specific Compose is rendered from private config with same-path mounts for the existing launcher. Container-mode registration uses Docker exec to the trusted workbench, while ordinary Pi remains unprivileged.

**Tech Stack:** Node.js 24, Docker/Compose, Bash, Python3, existing TypeScript workbench and SQLite.

**Spec:** `docs/superpowers/specs/2026-10-29-remote-compose-workbench.md`

## Global Constraints

- Never use production Pi state in tests, delete volumes, print credentials, or silently replace the current public deployment before candidate validation.
- Default remote is `https://github.com/swordfate3/pi-manager-service.git`; default ref is `main`. Every deployment records the exact Git commit and Docker image ID.
- Preserve existing `pi-stack/local-workbench/config/config.json`, SQLite, Pi volumes, projects, model source, SSH handling and QQ attachment cleanup.
- No Docker socket in ordinary Pi; workbench is the explicitly trusted administrative service.

### Task 1: Remote updater (independent worker)

**Files:** Create `deploy/stack/update.mjs`, `tests/stack-update.test.mjs`.

**Interfaces:** export `resolveCommit`, `updateWorkbench`, `rollbackWorkbench`, with injectable process runner for deterministic offline tests. Production CLI is `node update.mjs update|rollback --stack ABSOLUTE [--ref REF] [--repository HTTPS]`. Workbench Compose at `STACK/workbench.compose.json`, environment managed by a private `STACK/local-workbench/config/container.json` receipt containing `image`, `commit`, `previousImage`, `containerName`, `composeProject`. The renderer/installer supplies the Compose file and bootstrap receipt.

- [ ] Write failing behavioral tests for invalid URLs/refs, commit-resolution parsing, Docker Git-context input, successful receipt, failed-build no cutover, failed-activation restoration and locking.
- [ ] Implement remote resolution with `git ls-remote`, precise branch/tag lookup and full-SHA acceptance; require exactly 40 lowercase hex. Build from `https://github.com/...git#FULLSHA` using Dockerfile `deploy/stack/Dockerfile`, OCI revision label, unique candidate image tag. No local source context.
- [ ] Run candidate image self-check before activation (`node --version`, entry bundle exists, Docker/Compose available). Compose loads the new image through `PI_WORKBENCH_IMAGE`; disable ambient .env/Compose overrides, preserve ordinary subprocess environment for allowed API credentials, avoid emitting secret output.
- [ ] Serialize via exclusive owner lock. Save receipt atomically only after exact service health succeeds. On activation error restore prior image and service; never call down -v, prune, or rewrite account/state.
- [ ] Run focused tests and write a report at `/tmp/pi-remote-update-worker-report.md`. Do not push, deploy or change production files.

### Task 2: Container runtime and launch integration (controller)

**Files:** Create `deploy/stack/Dockerfile`, `.dockerignore`, `configure.mjs`, `scripts/` containing existing Pi launcher helpers; tests for rendered Compose, lifecycle commands and helper registration. Existing TypeScript application behavior stays unchanged.

- [ ] Add RED tests for no local bundle dependency, same-path private mounts, owner UID/docker group, config rejection, isolated optional mounts and container-mode registration.
- [ ] Build workbench on pinned Node image with Docker CLI/Compose, Bash/Python/OpenSSH/curl and required small launcher tools. Ship Pi launcher/runtime assets from the remote repository.
- [ ] Configure Compose with read-only root, writable stack state, allowed workspace roots, optional QQ source/SSH/.bashrc/HF file, shared attachment lifecycle runtime, Docker socket and host network. Preserve configured port/origin and application state.
- [ ] Add container-aware `pi-dockerctl local` commands plus `update` and `rollback`; helper selects container CLI without requiring host-built Hub bundles. Leave legacy lifecycle commands intact.
- [ ] Run focused tests, typecheck, build and manifest verification.

### Task 3: Integration, release and deployment

**Files:** `docs/remote-compose.md`, README and validation record.

- [ ] Independent review of updater and runtime integration; address material findings.
- [ ] Commit the tested change on `codex/remote-compose-workbench`; publish only the task branch needed for the remote build, without merging main implicitly.
- [ ] Build from the actual remote commit, run candidate with separate config/state/ports, verify unauthenticated protection and a disposable Pi launch/registration/cleanup.
- [ ] Back up exact production config/controller/registration helper. When safe, stop old workbench service, activate Compose on original ports, verify public login and existing terminal Pi registrations. Roll back if any production check fails.
- [ ] Document exact branch/commit deployed, commands, rollback and any remaining main publication work.

# Clean Compose Stack Implementation Plan

**Goal:** Replace the mixed local/systemd/four-role deployment with one remote-built Compose stack and no runtime fallback to previous deployments.

**Architecture:** `hub` runs the authenticated Manager and embedded session Hub from an exact remote Git commit. `tunnel` runs SSH to the existing gateway using a read-only deployment key. Profiled `pi` containers share the existing five external volumes and bind the selected workspace. Only generated deployment configuration and host adapters live outside images.

**Approved specification:** User explicitly approved stopping services, rebuilding the deployment, using remote Hub sources only, configuring Compose container management, and removing prior compatibility. Keep the model directory `pi-models`; user projects, credentials, login SQLite and memory identity must survive.

## Task 1 — Configuration and image

- [ ] Add `tests/compose-config.test.mjs`: render synthetic private `config/hub.json` and `config/pi.json`; assert remote Git build context, no local application mounts, exact five external volume mounts, independent registry credentials, tunnel key read-only, no old roles, no alias escapes, and no writes for invalid configuration.
- [ ] Run `node tests/compose-config.test.mjs` and observe failure.
- [ ] Implement `deploy/compose/configure.mjs` exposing `renderStack({root,commit,ref})`, generating `compose.yaml`, `internal/hub-runtime.json` and `internal/release.json` only after validation.
- [ ] Add `deploy/compose/Dockerfile` using pinned Node/Python/Docker stages, building Manager from the remote context. Install only clean adapters under `/opt/pi-stack` and run `/opt/pi-manager/dist/manager/pi-manager-local.mjs`.
- [ ] Run focused tests, typecheck and build.

## Task 2 — Host adapters

- [ ] Implement clean `deploy/compose/bin/pi-pirun`, `hub-session.py`, screenshot lifecycle helpers and `pirun`. Consume only root/config/pi.json and fixed root/data paths; no old-root fallback, host-built Hub CLI, shell-profile loading or old-role dispatch.
- [ ] Implement `deploy/compose/control.py`: one Compose entry for up/down/status/logs, remote update, password reset; reject legacy/local subcommands. Updates use GitHub commit resolution and remote Docker build, not host source.
- [ ] Validate fake-Docker launch behavior and two-owner screenshot lifecycle. Ordinary Pi must never receive Docker socket or deployment key.

## Task 3 — Deployment and acceptance

- [ ] Commit only the new clean deployment and its tests to `codex/clean-compose-stack`; preserve unrelated dirty work. Push the branch and build the exact pushed SHA using Git URL context.
- [ ] With old services stopped, preserve SQLite and memory identity, archive superseded deployment files under root/archive, and install clean config/data/internal directories without symlinks. Do not remove external volumes or overwrite the current model file.
- [ ] Use a synthetic state directory and isolated Pi agent bind for real-container acceptance: authenticated web Pi creation, terminal registration, shared screenshot counts, last exit cleanup and SQLite survival across recreation. No real model requests.
- [ ] Start production with Compose. Verify anonymous blocking, health, selected model SHA, no old-source mounts, no old user services active, tunnel and public auth page.
- [ ] Deliver root README showing the exact repository/ref/SHA and copyable build/start/update commands; explain config vs automatic data vs external volumes.

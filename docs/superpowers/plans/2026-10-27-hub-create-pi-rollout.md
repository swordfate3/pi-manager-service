# Hub create Pi rollout implementation plan

> **For agentic workers:** use a focused worker for the independent portal link change; controller owns deployment and final live acceptance. Do not commit, merge or push in this task.

**Goal:** Make the already approved create/approve/enroll feature usable, not merely ship an image with the feature disabled.

**Architecture:** Keep requester, administrator, executor and chat independent. Add configurable cross-origin navigation in the chat portal; credentials never cross those navigation links. Enable only the trusted executor's raw Docker authority with the existing narrow Chat enrollment broker. Existing external pirun containers and volumes remain untouched.

**Tech Stack:** TypeScript/Node, Unix IPC, Docker Compose, existing SSH/Caddy gateway where applicable.

**Spec:** `docs/superpowers/specs/2026-10-27-hub-create-pirun-design.md` and `docs/hub-create-runtime-enrollment.md`.

## Global constraints

- Ordinary Pi UID/GID1000:1000, no-new-privileges, cap-drop ALL; only independent executor gets Docker socket authority.
- No self-approval, no administrator credentials in chat/public/Pi, no production model requests during acceptance.
- Browse only existing directories below the configured Home and allowed root; this user's root is `/home/fate/gitproject`.
- Preserve current Pi containers, all existing volumes, current model source and Caddy login.
- Do not declare success until the deployed portal entry, real creation task, independent approval, registration and HTTP/WS access all work. Record remaining mobile/public-access limits honestly.

## Task 1: Visible configurable management navigation

- [x] Add failing tests for chat portal navigation to the independent requester page, validation/escaping and legacy compatibility.
- [x] Add optional `managerLinks: {requester: string, administrator?: string}` to strict Chat config and Hub config; exact validated canonical root URLs, separate origins, HTTPS except loopback HTTP.
- [x] Render `新建 Pi` and independent administrator navigation with no credentials or automatic approval. Existing deployments without links preserve old behavior.
- [x] Run focused tests and report changed files; controller rebuilds dist after integration.

## Task 2: Enable production backend deliberately

- [x] Snapshot exact config, role/container baseline and immutable images without printing secrets.
- [x] Prepare a pinned local Pi profile image, fixed Web package, models source, dedicated enrollment group/socket/authority and backend state under pi-stack.
- [x] Grant Docker socket only to executor. Mount allowed roots/source at identical host coordinates. Preserve independent private state and normal Pi persistence.
- [x] Configure existing-directory browser rooted at `/home/fate/gitproject`, hide protected code/config branches, broker registration and fixed runtime.
- [x] Rebuild/recreate only Manager roles; keep existing Pi and gateway working. Verify auth and capabilities are actually enabled.

## Task 3: Deployed workflow acceptance and handoff

- [x] Verify portal entry and authenticated management pages; requester cannot approve.
- [x] Submit one clearly named acceptance Pi in a new isolated project under allowed root. Review and approve exact stored task through the admin HTTP/UI flow; wait for registered readiness and verify HTTP/WS without prompting a paid model.
- [x] Stop the acceptance Pi using an independently approved task; retain its identity/home or clean only precisely journaled acceptance resources with explicit evidence.
- [x] Compare existing Pi container IDs, start times and running states; archive evidence, rollback instructions and actual URLs under pi-stack.

Deployment and browser/public acceptance evidence: `docs/validation/2026-10-27-create-rollout-live.md`.
The physical-phone and legacy-pirun parity limits are recorded there; no commit/push was performed.

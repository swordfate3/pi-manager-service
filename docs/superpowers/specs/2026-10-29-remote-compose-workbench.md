# Remote-built Compose workbench

Approved in conversation on 2026-10-29: deployment must fetch the GitHub project instead of copying a local developer checkout, run the current authenticated workbench/Hub under Compose, and preserve Pi data, model configuration, directory selection and QQ attachments.

## Deployment contract

- Source defaults to `https://github.com/swordfate3/pi-manager-service.git`, ref `main`. Resolve a ref to an exact 40-character commit before a Docker Git-context build; record commit and image ID.
- The remote repository contains the workbench Dockerfile and deployment tooling. No local `dist`, `node_modules` or developer source is a build input. No token is a build argument.
- A separate workbench Compose definition is used; legacy four-role services and ordinary Pi Compose runs are not recreated by a workbench update.
- Workbench uses the existing private config, state and SQLite database, host networking, UID/GID matching the host owner, no-new-privileges and dropped capabilities. It is the trusted administrative owner: Docker socket authority belongs here, never to ordinary Pi containers.
- Expose only administrator-configured project roots, the exact stack paths needed by the launcher, and optional screenshot/credential mounts. Do not mount all `/`, `/home`, or the user's entire home. Preserve absolute host path coordinates for Docker bind sources.
- Host terminal pirun still runs the existing host launcher. Its registration helper invokes the container's Hub CLI when container deployment is selected. Web launches invoke the same launcher inside the workbench with identical absolute-path mounts. QQ attachment reference counting must be shared across both launch contexts.
- Update builds before stopping anything, checks readiness on the exact configured origin, records previous image, serializes updates, and restores the previous service on failed activation. Explicit rollback switches code only, not SQLite snapshots.
- First migration verifies a candidate on different ports with independent test state. Then stop the old user service, switch the same production ports, and retain the old files/service for rollback. Never reinitialize accounts or delete Pi volumes. Check active web-owned Pi before cutover; do not stop a running generation without explicit authority.
- Existing HTTPS and reverse SSH tunnel remain unchanged. Anonymous local state stays 401; session navigation redirects to login.

## Acceptance

Behavioral tests cover invalid refs, immutable build inputs, failed builds leaving live service untouched, activation failure restoring the last image, concurrent update rejection, container registration without host bundles, workbench lifecycle control, and private mount exclusions. Real Docker validation uses new test containers/state before production cutover. Verify login protection, terminal registration, a web-created disposable Pi, screenshot propagation and ordinary Pi privilege boundaries after deployment. Report unverified physical-phone behavior separately.

# Create-Pi rollout: prepared, not live

Date: 2026-10-27

Historical checkpoint: a later user-authorized retry was approved and deployed.
See `2026-10-27-create-rollout-live.md` for the current status. The blocked status
and safe restoration below describe the earlier checkpoint, not current runtime.

## Current delivery status

The creation workflow is **not available in the deployed portal**. Source,
tests and candidate images must not be described as a completed deployment.
The production cutover was denied by permission review: explicit informed
authorization is required before granting the independent executor access to
the host Docker socket and recreating the four Manager roles. No alternative
execution path may be used to bypass that denial.

## Safe restoration completed

- Restored `pi-stack/compose.yaml` byte-for-byte to the pre-staging copy.
- Restored the executor, chat and public private configs from the original
  role-config backups using a network-free helper with no Docker socket.
  Prepared configs remain separately backed up; no credentials were printed.
- Restored the stack receipt to the prior Manager image.
- Stopped and disabled only the newly introduced requester SSH tunnel.
- Did not activate the uploaded candidate Caddy configuration.
- Read-only runtime verification found all four original Manager roles healthy
  on image `490d2df83282`, and all five existing Pi containers running.
  No existing Pi container or data volume was recreated or removed.

The prepared images, disabled configuration copies and fixed Web package remain
available for a later explicitly authorized deployment. The one-shot enabling
helper must not be rerun blindly because its backups and authority already exist.

## Review correction

The canonical Manager root validator now rejects empty `?` and `#` suffixes
for both requester and administrator links. These previously passed URL parsing
but were not canonical root request targets. The HTTP request boundary was not
relaxed.

Fresh verification:

- Added the four suffix regression cases and observed the expected
  `Missing expected exception` failure before changing production validation.
- Focused Manager-link tests: 3 passed, 0 failed after the fix.
- Gateway authentication tests: 4 passed, 0 failed.
- `npm run build`: exit 0, including TypeScript checking and all bundles.
- `npm run verify:dist`: exit 0.
- Scoped `git diff --check`: exit 0.

Earlier full-suite results belong to the preparation run, not to a new live
acceptance. The rebuilt dist includes the suffix fix; the previously prepared
Docker image does not and must be rebuilt before deployment.

## Remaining acceptance after authorization

Reapply the reviewed configuration deliberately; rebuild and switch only the
four Manager roles; verify the visible portal entry and independent logins;
create one isolated Pi via requester submission and administrator approval;
verify registration, HTTP and WebSocket readiness; stop only that acceptance Pi;
then activate and verify the requester gateway route. Preserve existing Pi,
volumes, login settings and the existing chat tunnel throughout.

The administrator page remains loopback-only. Remote requester access is not
remote administrator approval, and must not be presented as such.

# Create-Pi deployment acceptance

Date: 2026-10-27. Supersedes the earlier blocked deployment status.

After the user was informed of executor Docker-socket authority and Manager
recreation risk, they requested another attempt. Both the explicit configuration
permission change and the Manager rollout were approved and executed. Ordinary
Pi/chat/public/admin containers do not receive raw Docker authority.

## Delivered

The live portal now has a visible New Pi link. The separately authenticated
requester browses existing allowed directories and submits tasks. A separately
authenticated local administrator reviews the exact task and approves it. A
created Pi has its own persistent home and registers automatically into the
session portal. Local and public HTTP/WebSocket access were exercised.

Runtime receipt pins Manager image
`sha256:912d55f421a1a9e4549f123bd13a3982f5cc529e824b651c484628732380e2e2`.
The four roles are healthy. User-stopped Pi containers were not restarted.

## Fresh evidence

- `verify:dist`, focused link tests (3), authentication tests (4), `npm run check`,
  helper syntax checks and `git diff --check` passed.
- HTTP acceptance created a unique workspace and real Pi through requester
  submission and independent approval; checked idempotency, traversal/protected
  directory rejection, requester approval denial, UID1000 workspace writes,
  private home, read-only runtime/models and no Docker/host credentials.
- The new Pi appeared in the portal, served HTML and WebSocket state_sync.
  Independently approved stop retained its exact container and home.
- Chromium mobile-viewport acceptance clicked the live public portal New Pi
  entry, authenticated the requester, selected an actual allowed directory,
  submitted resume of the acceptance Pi, used a separate administrator browser
  context for review/confirmation, received public HTTPS/WebSocket state_sync,
  and approved its stop. No page errors occurred.
- Independent public native-WebSocket and clean-browser probes also received
  state_sync. No conversation or credential content was logged.
- The thirteen unrelated baseline containers retained their IDs, start times,
  running states and restart counts.

## Failures found and resolved during deployment

1. Node fetch ignored the intended Host override in this deployed environment:
   it received403 while native HTTP received200. The deployment healthcheck and
   local test clients now use native HTTP where explicit Host is necessary. The
   server boundary was not weakened.
2. First Docker create exceeded the default10s transport deadline while copying
   a fresh home. The resulting unknown task and Created container were preserved,
   never replayed. Deployment transport timeout is now60s, and a new independent
   task passed real creation. Startup timeout remains60s.
3. The initial test workspace was0700, so the separate executor could list the
   parent but not browse that child. Only the nonsensitive test fixture was made
   0755. No user directory permissions were widened.
4. The initial browser harness reused requester request-interception state for
   its chat check and failed to observe state_sync. Independent public probes
   succeeded; the final harness uses a clean chat-scoped browser context and
   passed end-to-end. This was not fixed by modifying production WebSocket code.

## Boundaries

The public requester retains existing Caddy Basic login; the upstream strips
gateway Authorization and uses independent Manager credentials. The admin page
remains loopback-only. Mobile viewport automation is not a physical-phone test.
No paid model prompt, remote source push, commit or merge was performed. New
managed homes do not inherit every legacy pirun extension/credential or its QQ
screenshot launcher. Version/extension update execution remains disabled.

Two exact acceptance resources remain stopped/never-started with their homes;
there was no deletion or pruning. Deployment documentation, original configs,
private sanitized verification reports and rollback guidance are archived under
`/home/fate/docker_files/pi-stack/backup/create-pi-20261027-retry/validation/`.

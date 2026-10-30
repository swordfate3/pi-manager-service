# Browser recovery after screen lock and Hub restart

## Reproduction and authority model

An unchanged generation survived a 130-second browser freeze/offline baseline. A distinct, deterministic failure occurred when the same Pi runtime registered a replacement generation while the browser slept past its disconnected ordinary-handoff 45-second lease. The old implementation returned 410 even though the original runtime remained authorized and live. A real HTTP/WebSocket regression reproduced 410 instead of 200 before this repair.

The new reconnect ticket is stateless, HMAC/domain-separated, bounded, and binds the existing run grant to an exact immutable runtime ID. Its lifetime is the grant/runtime lifetime, not a screen-lock timer. It is delivered in the existing browser-only hub_route control; only the authenticated, same-origin POST handoff endpoint accepts it. Manager does not expose it to Pi HTTP/WebSocket, prompts, logs or URLs. No database, volume, retained browser record or new service is introduced.

There are three independent authorities:

- Ordinary handoff intentionally authorizes its first successor, including a normal `/reload` runtime replacement, within the existing short lease.
- Managed restart authority retains its operation-specific successor and absolute deadline; reconnect does not substitute for or extend it.
- Runtime reconnect restores only the exact same authorized runtime when the ordinary capability is missing/expired, after a Hub reboot, or after its already-bound successor retired in another address rotation. It cannot choose an arbitrary next runtime.

Valid ticket + registration gap returns 202; another runtime or invalid/revoked authority returns 410; temporary backend proof failure returns 503. Proof is asynchronous, so grant revocation/token/backend host/current session/runtime are rechecked before returning the path. Old generation URLs stay retired.

## Regression evidence

- Full serial Hub socket suite: 122/122 passing, including new 24-hour controlled clock, Hub reboot, repeated rotations, gap, bad signature, wrong Origin, revocation/replacement during proof, and ordinary reload-vs-second-runtime tests.
- Real authenticated Manager transport: 7/7 passing, including login-required, wrong-Origin refusal, ticket forwarded only to handoff, no leak to Pi, and revocation.
- Manager build/typecheck and source/dist hash verification pass.
- Paired Web full unit suite: 502 tests, 501 passing, one existing optional skip, no failures.
- Real Chromium → authenticated Manager → Hub → isolated Pi RPC test covers `/new`, `/resume`, temporary proofs503, visible offline recovery and frozen/offline page across a test Hub restart. Re-registration plus a deliberate 50-second wait outlasts old handoff authority; the mounted page recovers automatically without prompt replay, preserving conversation and unsent draft. Screenshots inspected at390×844 and1440×900.

Independent read-only review corrected an initial interpretation that ticket should constrain still-live ordinary handoff: that would break intentional `/reload`. Existing first-successor authority is preserved and now has an explicit regression. Review also identified freeze timing races, fixed in paired Web with wall-clock health/handshake fences and lifecycle-operation identity guards. The legacy512-entry handoff capacity remains a separate, non-blocking hardening item.

## Rollout and limits

This is local development/isolated acceptance, not a production deployment receipt. No production Pi/Hub/tunnel was restarted or production account/state changed. Update Manager and Web together; refresh an already-open old browser page once to load the new client and receive its ticket.

Mobile OS suspension is unavoidable; the repair promises no physical always-open socket. Tests exercise a preserved/frozen browser page, not a phone OS destroying/reloading the entire page. Full page eviction, logout/revocation, a genuinely exited Pi or an unapproved changed runtime are not covered by unconditional restoration. New tickets are kept only in client memory; no draft/attachment persistence was added. A leaked ticket cannot bypass Manager login/Origin, and grant revocation/token rotation invalidates it.

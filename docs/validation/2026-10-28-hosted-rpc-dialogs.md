# Hosted RPC dialog bridge — development acceptance

## Implemented scope

The current local-workbench process owns a newly launched Pi RPC child. A logged-in
browser on its exact session route can answer standard confirm/select/input/editor.
No additional approval role, management code or automatic approval is introduced.
Native terminal processes, pre-restart processes and custom terminal widgets are not taken over.

Both repositories use branch `codex/web-hosted-rpc-dialogs`. The matching Web changes
are based on clean v1. Source and generated distribution must be shipped together.

## Evidence (2026-10-28)

- Final Manager authentication/security/launcher/API/module run: 50 tests passed.
- The dialog module has16 tests plus the authenticated API integration, including wrong caller
  session, wrong generation, duplicate query fields, rejected arbitrary RPC fields,
  revoked authorization, UTF-8 bounds and duplicate decisions.
- Manager package suite passed when temporary child processes were permitted.
  Initial sandbox-only package run failed with EPERM, not an assertion regression;
  rerun outside that restricted process boundary passed.
- Web protocol run: 7 tests passed, including bounded-v2 routes, native browser fetch
  receiver behavior and no retry after uncertain delivery.
- Existing Web terminal prompt/store suites passed.
- Both typecheck/build and source/distribution verification passed. Existing Vite
  large-chunk, Node typeless-package and experimental-SQLite warnings remain.
- Real isolated Pi 1.1.0 + packaged Manager Hub + headless Chromium passed the five
  actual SDK results: confirmed true, selected literal option, exact input,
  multiline editor value and cancelled confirmation false. Pi negotiated a real
  bounded-v2 registration; the test asserts its issued `b2-...` generation.
- Same browser test passed pending-dialog browser refresh, initially unavailable
  owner discovery, transient503/hide/reappear recovery, and a sixth real source
  AbortController-A/immediate-B flow: the first owner snapshot after abort is B.
- Existing real-Pi terminal integration passed all three confirmation, timeout,
  AbortController cases, including end events and cleared reconnect metadata.
- Screenshots at1365×900 and390×844 were visually inspected: full synthetic preview
  and cancel/reject/confirm buttons visible with no horizontal clipping. Evidence
  is in Web's gitignored `.tmp/host-rpc-dialogs/`.

Tests used temporary directories and synthetic extensions, not production volumes,
credentials, user projects or model calls. The browser test uses the real Hub for
registration/proxying and a synthetic owner-API shim; actual Manager login/CSRF and
launcher ownership are covered separately by its HTTP API test.

## Review disposition

Independent review identified legacy-only generation parsing; both sides now use
the shared Hub grammar. It also identified unavailable-owner polling stopping too
early and hidden unhealthy dialogs not recovering; the browser regression covers
both fixes. The suggested missing source-abort UI end was checked against SDK
`withUIPrompt(...).finally(finish)` and the real abort integration: public UI end
is emitted, although RPC stdout itself has no generic end record. Late source IDs
remain subject to Pi's original resolver and cannot authorize a new request.
The narrower abort-A/then-B queue issue was reproduced in a failing module test.
Matching Web now emits clear-only standard `setStatus` lifecycle markers: start
binds a bounded token to one existing raw request by method/title digest; matching
end retires only that original ID, including while its session check is in flight.
There is no visible status text, source UI patch or arbitrary stdout write. The
  regression uses a successor with the same title to ensure it is not cancelled.

## Production rollout deliberately not performed

Read-only observation found two live website-created Pi instances. Restarting the
current workbench closes their owned stdin and may end them. No production service,
Pi process, extension installation, configuration, SSH tunnel or state volume was
changed. Save/exit those instances or explicitly authorize their interruption before
installing both distributions, restarting workbench and creating fresh web instances.
This is not a claim that existing mobile sessions have been upgraded or phone-device tested.

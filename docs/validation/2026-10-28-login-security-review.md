# Independent workbench-login security review — 2026-10-28

Initial review checkpoint: 2026-10-28 01:40 +08:00. Scoped fix re-review checkpoint: 2026-10-28 01:48 +08:00. This is a review of the actual working files, not a Git diff or the built distribution. The shared worktree is dirty and implementation continues in parallel; each verdict applies to its recorded source checkpoint, not subsequent edits.

## Result

**Current verdict: both original P2 findings are closed by the independently checked fixes. No unresolved important finding remains in this two-fix re-review scope.** The original findings and reproductions are retained below as historical evidence; they describe the pre-fix checkpoint and are not assertions against the current source. No anonymous HTTP, file, or WebSocket authentication bypass was identified in the initial scoped code inspection.

Supplemental FIN sign-off, 2026-10-28 01:52 +08:00: independently accepted the added `browser.once("end", cleanup)` at `manager/local-websocket.ts:18` as part of the same WebSocket finding. This explicitly supplements the previous close/error checks with half-open peer-FIN handling; it is not a new full audit. Both findings remain CLOSED, including the FIN case. The transport sidecar's separate result and the local idle-only deployment decision remain outside this review verdict.

Final scoped sign-off, 2026-10-28 01:50 +08:00: rechecked all six source/test fingerprints recorded in the fix re-review; each was unchanged. Independently reran `node --import ./tests/register-ts.mjs --test tests/local-auth.test.ts tests/local-websocket.test.ts tests/local-security.test.ts`: exit 0, all three test-file entries passed, zero failures, approximately 5.0 seconds. Both fixes remain CLOSED. The main implementer's reported 67/68 broader focused result and the separate transport assertion under refinement were not independently adjudicated here; this sign-off neither claims that broader suite is GREEN nor reopens a confirmed-closed finding on the basis of an unreviewed aggregate result. No additional audit, parked issue, or production/deployment approval is attached to this verdict.

No source, deployment, account, or live-service data was changed. Only this report was added in the repository. Probes used synthetic credentials, temporary SQLite directories, and in-memory streams; no Docker command, launcher invocation, child agent, or public rollout was performed. An isolated loopback fixture could not bind (`listen EPERM`) in the sandbox, so the WebSocket reproduction below deliberately uses the actual handler with in-memory transport. It is not claimed as an end-to-end network test.

## Scoped fix re-review — 2026-10-28 01:48 +08:00

Scope was limited to the reported corrections in `manager/local-auth.ts`, `manager/local-websocket.ts`, their wiring in `manager/local-service.ts`, the unchanged two-slot hash admission in `manager/local-security.ts`, and the corresponding `tests/local-auth.test.ts` / `tests/local-websocket.test.ts`. No deployment or production approval is implied.

### Supplemental half-open FIN verification — 2026-10-28 01:52 +08:00

The `end` listener at `manager/local-websocket.ts:18` is installed alongside close/error listeners before opening the upstream request. It invokes the existing idempotent cleanup, which marks the helper closed, clears the timer, removes tracking, destroys the pending request and connected upstream, and destroys the browser. Consequently the late-101 closed guard also covers a browser that has sent FIN without previously emitting close.

Fresh independent run of `node --import ./tests/register-ts.mjs --test tests/local-websocket.test.ts tests/local-auth.test.ts tests/local-security.test.ts` exited 0: all three test-file entries passed, zero failures, approximately 5.1 seconds. This includes the new peer-FIN regression at `tests/local-websocket.test.ts:22-26` and both earlier synthetic races.

Additional pure probes exercised the exported helper using `Duplex({allowHalfOpen:true})` and `push(null)` to produce an actual readable `end`, rather than manually emitting that event:

- FIN before 101 cancelled the pending request and destroyed the browser; a subsequently delivered 101 destroyed its upstream, never called `onOpen`, and left active count zero with cleanup called once.
- FIN after a successful 101 destroyed both legs and the pending request, removed the active tracking entry, and called cleanup once.
- An in-memory-only copy of the current helper with just the new `end` listener omitted reproduced the prior failure: `readableEnded=true`, `browser.destroyed=false`, pending request not cancelled, cleanup count zero. Restoring the actual helper resolves that exact condition. No source was changed for this RED-condition comparison, and no live network was used.

Auth/security source fingerprints remained identical to the previous review. Updated FIN source/test fingerprints:

```text
85ebd20e4052fc436788b24fbb0fa6aaaa8d59f9c8cc24b7d1df71897474c7df  manager/local-websocket.ts
d7c03826f4c613ab748e2d3aaab65f1760a1eb63caf8b380b8bdc859b1ef351d  tests/local-websocket.test.ts
```

### Finding 1: CLOSED — shared proxy peer no longer causes a long correct-password ban

At `manager/local-auth.ts:31-44`, admission keeps at most eight timestamps in a rolling 1,000 ms window. Password verification precedes the shared-peer failure throttle, which is evaluated only on a username/password mismatch. A valid password takes the account-version recheck and success path, clearing the shared-peer failures before issuing a session. The existing two-concurrent-scrypt guard remains at `manager/local-security.ts:116-128`. No forwarded identity headers were introduced or trusted.

The new same-proxy regression at `tests/local-auth.test.ts:33-38` passed independently. Additional pure probes confirmed:

- Five failed attempts on `127.0.0.1` followed by a correct login produced a valid session in secure-cookie auth mode. The next mismatch returned 401 rather than an old throttle's 429, demonstrating that success cleared its failure history.
- With a controlled clock, eight malformed login attempts reached validation; the next 100 attempts returned 429; after advancing 1,001 ms, admission resumed. The timestamp array's maximum length of eight was checked directly in source.
- Three simultaneous valid-password logins on a fresh auth instance yielded two successes and one 429, independently confirming the two-slot expensive-hash bound.

Short 429 responses during current admission/hash saturation remain possible by design. They are not the former persistent 15-minute shared-peer lockout and are not a parked review issue.

### Finding 2: CLOSED — cancellation owns the pending request and both upgraded legs

`manager/local-service.ts:151-157` retains the Host/Origin/session gate and delegates to the helper, with a fresh database-backed validity check and map add/remove callbacks. In `manager/local-websocket.ts:14-19`, idempotent cleanup and browser close/error listeners exist before `open()` is called. Lines 23-33 reject a late 101 when closed, browser-destroyed, invalid, or validity-check-throwing, and destroy the late upstream. Lines 14-16 destroy the pending request, connected upstream, and browser; `onClose` removes the tracking entry. The pending deadline at lines 21-22 is 10,000 ms and is cleared on completion/cleanup.

Both new synthetic regressions at `tests/local-websocket.test.ts:7-20` passed independently: browser close before 101 cancels the pending request and destroys a late connection without `onOpen`, and session revocation before 101 never accepts the connection.

Additional in-memory probes using the actual exported helper passed for successful upgrade followed by browser close, successful upgrade followed by upstream close, browser error during handshake, and a throwing database/session validity callback. Each relevant path destroyed both transport legs and invoked cleanup once. A controlled timer probe verified that the pending deadline is configured to 10,000 ms, cancels the request/browser, and rejects a subsequently delivered 101; this was a deterministic callback check, not a ten-second wall-clock or live-network test.

### Fresh verification evidence

Executed independently against the current source:

```sh
node --import ./tests/register-ts.mjs --test tests/local-auth.test.ts tests/local-websocket.test.ts tests/local-security.test.ts
```

Exit status 0; three test-file entries passed, zero failures (approximately 4.8 seconds). The additional pure auth and WebSocket probes described above also exited 0. No build, full integration suite, real transport exhaustion test, or production deployment was run by this re-review; the main implementer's broader GREEN status is not substituted for independent evidence here.

SHA-256 of the re-reviewed source and new regression files:

```text
db3379309423e91c50c444f97e8361c433ba3aab03cd09592c1129a8d12ae462  manager/local-auth.ts
910798ed2b8adff754fa0fcc64ef4004628e75220429dbb4e26ea604c45603d7  manager/local-security.ts
476aa23cf6c855a8012b3f82d1e44357ab19738d6f749913944e9383906d9009  manager/local-service.ts
39b1338c9be32c398cd7be386878d34bb46e4fe052a752e45ae798937141a982  manager/local-websocket.ts
1d25187d190f06be4dae751d64f26ced12f9ebf80201fd6086ae1c0c91480ab4  tests/local-auth.test.ts
f40f1677517133b72484d289aaf458d7935033f4c89ca3109a42baee7434b0f3  tests/local-websocket.test.ts
```

## Original finding 1 — [P2, now CLOSED] Five anonymous failures lock out every client behind the HTTPS proxy

**Locations:** `manager/local-service.ts:95`; `manager/local-auth.ts:30-40`; `manager/local-security.ts:65-73`.

The service keys the password throttle with `req.socket.remoteAddress`, rather than the external client. The listener is intentionally bound to `127.0.0.1`, so normal phone/desktop HTTPS access through a reverse proxy reaches Node with the same proxy peer address. Five incorrect login attempts from any unauthenticated external client block that shared key for 15 minutes. `allow()` runs before password verification, so the owner's correct password cannot clear the block. Subsequent failures after each block expires increase the delay up to 16 hours. The existing two-hash admission bound does not prevent this: the attacker can submit the five failures sequentially.

**Threat and impact:** an unauthenticated client that can reach the configured HTTPS entry can deny all fresh or returning logins through that proxy, without knowing the real username or password. The public authentication-state endpoint supplies the anonymous CSRF token, and a non-browser HTTP client can supply the exact expected Host and Origin; these are CSRF protections, not credentials against this attacker. Existing authenticated sessions remain usable. This is conditional on remote HTTPS access being enabled; there is no claim of a current public deployment or of a remote attacker reaching the default private loopback listener directly.

**Reproduction, from the repository root:** this exercises the real auth/store implementation without a server, real account, or proxy. Two distinct external clients are represented by their necessarily identical TCP peer key at Node.

```sh
node --import ./tests/register-ts.mjs --input-type=module <<'NODE'
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from './manager/local-store.ts';
import { LocalAuth } from './manager/local-auth.ts';
const store = await LocalStore.open(await mkdtemp(path.join(tmpdir(), 'login-review-lockout-')));
const local = new LocalAuth(store, false);
const initial = await local.setup({username:'reviewer', password:'temporary-review-password'});
const auth = new LocalAuth(store, true);
const proxyPeer = '127.0.0.1';
try {
  for (let i = 1; i <= 5; i++) {
    try { await auth.login({username:'not-the-owner', password:'wrong-password'}, proxyPeer); }
    catch (error) { console.log('attackerAttempt', i, 'status', error.status); }
  }
  try { await auth.login({username:'reviewer', password:'temporary-review-password'}, proxyPeer); }
  catch (error) { console.log('correctPasswordDifferentRemoteClientSameProxyPeer', error.status); }
  console.log('existingSessionSurvivesLockout', !!local.authenticate(initial.token));
} finally { store.close(); }
NODE
```

Observed with the same store/auth path: attempts 1–5 each returned `401`; the correct-password login then returned `429`; an existing session remained valid. No waiting or high-rate traffic was needed. The 15-minute exponential duration follows directly from `LoginThrottle.failure()` at line 73.

**Suggested correction:** avoid a long hard ban on a shared reverse-proxy peer. Either use a deliberately configured trusted-proxy client-identity mechanism with strict stripping/validation at the boundary, or use a bounded admission/backoff policy that does not let five anonymous failures exclude every correct-password client for minutes. Do not simply start trusting arbitrary `X-Forwarded-For` headers. Add a regression covering two external clients behind one proxy peer. This needs no new user approval flow or authorization platform.

## Original finding 2 — [P2, now CLOSED] A close-before-101 WebSocket race leaves an orphaned proxy leg

**Locations:** `manager/local-service.ts:154-160`, especially the missing browser-liveness check at line 156 and the late `socket.once("close", ...)` at line 160; session revocation cleanup at lines 64–66. Downstream resource consequence was checked against the existing Hub browser-pair cap in `hub/limits.ts:5` and admission/release logic in `hub/server.ts:1041-1072`.

After authenticating a WebSocket upgrade, the outer service creates an upstream request but does not yet attach a browser-close cancellation handler. If the browser socket has already emitted `close` before the upstream emits `upgrade`, the 101 callback checks only session validity and service shutdown. It then inserts the already-destroyed socket into `websockets`, installs a close listener after the event has happened, and leaves the upstream connection open. Calling `destroy()` again during logout, expiry, or database fail-close does not re-emit that past close event, so neither the map entry nor that upstream leg is cleaned by this path.

**Threat and impact:** this requires an authenticated upgrade request, not an anonymous attacker. An authenticated client can arrange the order deliberately; abrupt network loss during mobile connection establishment can also produce the relevant close/error ordering. The stale map entry is retained and the internal proxy leg can remain open after logout. In the real Hub, an otherwise-live orphan can retain one of the eight shared browser-pair admissions until some other event terminates it, denying new chat connections after repeated occurrences. The eight-slot exhaustion consequence is a code-derived inference, not a live-Hub load-test result; the map retention and missing upstream destruction were directly reproduced.

**Reproduction, from the repository root:** the scoped upgrade callback is read verbatim from the current source, TypeScript-only syntax is stripped by Node, and its transport dependencies are replaced by `EventEmitter`/`PassThrough`. Authentication and the boundary are stubbed successful intentionally: the property under test is cancellation *after* authentication, not the correctness of those checks.

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const source = await readFile('manager/local-service.ts', 'utf8');
const start = source.indexOf('  server.on("upgrade",');
const end = source.indexOf('\n  });', start) + 7;
const handler = stripTypeScriptTypes(source.slice(start, end));
const server = new EventEmitter(), requests = [], websockets = new Map();
let valid = true;
const store = {session: () => valid ? {} : undefined};
const context = {
  server, boundary: () => {}, header: (req, name) => req.headers[name],
  origin: 'http://127.0.0.1:1234', hub: {url:'http://127.0.0.1:5678/'}, closing:false,
  sessionFor: () => ({hash:'fixture-hash'}),
  requireThat: (condition, status) => { if (!condition) throw Error(String(status)); },
  request: () => { const req = new EventEmitter(); req.end = () => {}; requests.push(req); return req; },
  localProxyHeaders: () => ({}), localProxyResponse: headers => headers,
  store, websockets, URL, ManagerError: class extends Error {}
};
vm.runInNewContext(handler, context);
const socket = new PassThrough(); socket.resume();
server.emit('upgrade', {url:'/s/fixture/ws', headers:{origin:context.origin}}, socket, Buffer.alloc(0));
socket.destroy(); await new Promise(done => setImmediate(done));
console.log('browserDestroyedBeforeUpstream101', socket.destroyed);
const connection = new PassThrough();
requests[0].emit('upgrade', {headers:{connection:'Upgrade', upgrade:'websocket'}}, connection, Buffer.alloc(0));
await new Promise(done => setImmediate(done));
console.log('trackedAlreadyClosedBrowser', websockets.size, 'upstreamDestroyed', connection.destroyed);
valid = false;
for (const [browser, hash] of websockets) if (!store.session(hash)) browser.destroy();
await new Promise(done => setImmediate(done));
console.log('afterSessionRevocation', 'mapEntries', websockets.size, 'upstreamDestroyed', connection.destroyed);
connection.destroy(); socket.destroy();
NODE
```

Observed output on the reviewed callback:

```text
browserDestroyedBeforeUpstream101 true
trackedAlreadyClosedBrowser 1 upstreamDestroyed false
afterSessionRevocation mapEntries 1 upstreamDestroyed false
```

**Suggested correction:** attach browser-close/error cancellation before starting the upstream handshake, cancel the pending request on disconnect, and check browser liveness again when accepting the upstream 101. Keep cleanup idempotent and track/destroy both legs so revocation does not depend on a future browser `close` event. Add a transport regression that forces browser close before upstream 101, then revokes the session; require no retained map/admission entry and a destroyed upstream. This does not add a business or approval restriction.

## Checked boundaries and observations not elevated to findings

- HTTP management state/mutations, `/s/` file/chat proxying, `/api/sessions`, and WS upgrades are behind the outer session check. The only intentional anonymous endpoints are login/auth script/auth state and guarded auth submissions. A first-party top-level navigation exception does not extend to APIs, frames, mutations, or WS.
- Host comparison is exact; supplied Origin must match exactly, mutations require Origin, WS always requires Origin, and `publicOrigin` is validated as an exact HTTPS origin. Proxy headers do not enable HTTPS mode. Web setup is denied in HTTPS mode, and the local setup submission rejects forwarding headers.
- Duplicate matching session cookies fail closed. Password changes use account-version compare-and-update and revoke all stored sessions transactionally; login rechecks the account version after hashing. Setup has both an in-process busy guard and a transactional account-exists check.
- The proxy request allowlist excludes Cookie, Authorization, forwarding and asserted identity headers; response filtering drops `Set-Cookie`. Response no-store handling was inspected. No proxy credential exposure was identified by that inspection.
- Stored sessions are capped at 64, audit rows at 1,000, legacy run import at 1,000 records/4 MiB, directory cache at 64 entries, passwords at 256 Unicode code points/1,024 UTF-8 bytes, and concurrent scrypt operations at two. Corrupt legacy input validation, exclusive byte-identical backup behavior, import marker transaction, and account/session SQL were inspected. This is not a complete filesystem crash/fault-injection audit.
- A successful password verification already in flight can issue a new session after `logout-all`: the operation deletes existing sessions without changing an issuance epoch. A pure auth probe confirmed old token invalid/new token valid in that order. This is **not** elevated to an authentication-bypass finding: it requires the correct current password, and a fresh valid-password login after logout remains permitted. Only treat it as a change request if the intended semantics explicitly include cancelling password logins admitted before the logout boundary.
- Direct access by a trusted host process to the intentionally unauthenticated internal loopback Hub is an explicit design boundary, **not** a reported remote bypass. No proposed finding relies on malicious same-UID file mutation, reading another user's real data, adding path restrictions, or introducing an approval platform.

## Scope and evidence checkpoint

Independent pure regression run: `node --import ./tests/register-ts.mjs --test tests/local-security.test.ts tests/local-auth.test.ts tests/local-store.test.ts` exited 0; all three test-file entries passed, zero failures (approximately 3.3 seconds). These existing regressions passing does not cover or negate the two targeted reproductions above.

Read the complete current implementations of `manager/local-{service,auth,store,security,config,account-cli,auth-ui,launcher}.ts`, `bin/pi-manager-local.mjs`, and `docs/superpowers/specs/2026-10-28-workbench-login-design.md`. Referenced helper and Hub code only to resolve boundary/resource semantics. The main implementer's mobile/HTTPS/integration successes were reported during the review, not independently rerun by this sidecar. Cache/deployment work outside the listed files was not audited.

SHA-256 at the checkpoint, allowing later concurrent changes to be distinguished:

```text
abf625e8a1e0362fd82d11460494678b84195c94328975ea0b9609038c6e18c0  manager/local-service.ts
c00c44eff5c8916e7e38ae68d04696e4ac77934f9394abdb3245a8c9f0ceda98  manager/local-auth.ts
7963f4c2a1ca9261498e588bd3deff5aa7ac2195e46052e33f9b921b317e1782  manager/local-store.ts
910798ed2b8adff754fa0fcc64ef4004628e75220429dbb4e26ea604c45603d7  manager/local-security.ts
c4cbfa84dbf2b700f40e0041d448eff069d311c3d461f48d584d255c392dbec5  manager/local-config.ts
efa8e928c562c8838301bae0093049157d8b3127d3d52f190e6b044060e5761f  manager/local-account-cli.ts
0d399c0275c9d74fc70dbe0941962ab580dc37d98211dcaea5a1e1a918266c7e  manager/local-auth-ui.ts
bef479a534f349b6b2885cf2a48bbd506a8e2db59b2bf6411bb665150643c879  manager/local-launcher.ts
283f3dd154742416bb03035f0e368f2b34425c22f133c84fde7408381b4996e6  bin/pi-manager-local.mjs
d11bb4652d48e3a957edeb902a045d2acfee2d7bf63de6c40db7d0ec0359e3de  docs/superpowers/specs/2026-10-28-workbench-login-design.md
```

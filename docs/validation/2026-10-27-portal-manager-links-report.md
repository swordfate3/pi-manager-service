# Task 1: portal manager-links validation

Date: 2026-10-27

## Scope completed

Implemented only Task 1 from `docs/superpowers/plans/2026-10-27-hub-create-pi-rollout.md`.

- Added optional Hub/Chat `managerLinks` configuration:
  `{ requester: string, administrator?: string }`.
- Requires canonical root URLs: HTTPS, or HTTP only for loopback hosts; rejects
  credentials, query/fragment values, non-root paths, unknown keys, and shared
  chat/requester/administrator origins.
- Chat portal navigation is link-only: requester goes directly to the
  independent Manager requester root, and administrator goes to the independent
  administrator root. No token, credential, query parameter, cross-origin XHR,
  or approval operation is added.
- The requested deployment pair is rendered as:
  `https://pi-admin.swordfate.cn/` for requester and
  `http://127.0.0.1:18302/` for administrator. The latter is visibly labelled
  `打开管理员入口（仅本机可用） ↗` when paired with a non-loopback requester.
- Configurations without `managerLinks` retain the legacy `/sessions/#new-pi`
  and `打开运行管理 ↗` navigation behavior.

## Test-first evidence

Initial RED command:

```text
$ node --import ./tests/register-ts.mjs tests/hub-manager-links.test.ts
not ok 1 - Hub managerLinks canonicalize separate root origins and reject hostile or overlapping URLs
  error: Expected values to be strictly deep-equal:
  + actual - expected
  + undefined
  - { requester: 'https://requester.example/', administrator: 'https://administrator.example/' }
not ok 2 - chat launcher accepts managerLinks and renders only independent credential-free navigation
  error: Invalid request
not ok 3 - managerLinks navigation is escaped and legacy management navigation is unchanged when omitted
  error: The input did not match the regular expression for the requester link
# pass 0
# fail 3
```

The later local-only-label test was also observed RED before its renderer change:

```text
not ok 3 - managerLinks navigation is escaped and legacy management navigation is unchanged when omitted
  error: The input did not match /打开管理员入口（仅本机可用） ↗/
# pass 2
# fail 1
```

Final focused GREEN command and exact output:

```text
$ node --import ./tests/register-ts.mjs --test tests/hub-manager-links.test.ts
TAP version 13
# Subtest: tests/hub-manager-links.test.ts
ok 1 - tests/hub-manager-links.test.ts
  ---
  duration_ms: 196.398589
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 202.359781
```

The test exercises real `readHubConfig`, the Chat launcher’s strict-key parser,
and `renderPortalHtml`. It covers URL canonicalization, origin separation,
loopback HTTP, hostile HTML attribute escaping, independent root-page links,
the explicit loopback-admin label, and legacy fallback.

Scoped whitespace check:

```text
$ git diff --check -- hub/config.ts hub/portal.ts hub/server.ts manager/chat-service.ts
(exit 0; no output)
```

## Changed files for this task

- `hub/config.ts`
- `hub/portal.ts`
- `hub/server.ts` — only the `renderPortalHtml` argument was changed.
- `manager/chat-service.ts`
- `tests/hub-manager-links.test.ts` (new)
- `docs/validation/2026-10-27-portal-manager-links-report.md` (this report)

## Deliberately not changed or run

- Did not edit `manager/http.ts` or `manager/ui.ts`; the controller owns the
  browser `X-Pi-Manager-Token` work compatible with the Basic-auth gateway.
- Did not edit deployment configuration, backend/executor code, prepared Pi
  image, Caddy, `dist/`, or existing Pi state.
- Did not install dependencies, rebuild dist, commit, or run the broader test,
  build, or typecheck commands; the task authorization permits focused tests
  only.
- A preliminary real Chat-server test could not bind its Unix registry socket
  in this sandbox (`listen EPERM .../runtime/registry.sock`) before page
  rendering. It was replaced with the actual strict launcher parser test;
  controller-owned deployed acceptance remains the live socket/browser check.

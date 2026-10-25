# Task 1 fix round 2 re-review

**Verdict: PASS.** No remaining finding or new breakage was found in the scoped `44abb46..1a8b9fb` fix diff.

Evidence:

- Every direct child in `tests/socket/hub-cli.test.ts` now receives a scenario-local environment: the lifecycle `init`/other commands, standalone `init` + `serve`, detached `init` + `serve`, and each unknown-command `init` + command invocation.
- `isolatedHubCliEnvironment(dir)` removes inherited `HOME`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG`, then replaces all three with paths below that scenario's temporary directory. `assertIsolatedChildEnvironment` rejects missing, root-equal, absolute escape, or `..` escape paths before launch.
- The inherited-command regression remains meaningful: each synthetic config is initialized first, both config variables point to it, and the inherited-property command is invoked with no trailing arguments. A regression that falls through to `serve` would use that valid temporary config and hit the timeout; the test instead requires immediate status `1`, no spawn timeout/error, empty stdout, the expected failure diagnostic, and no registry socket.
- `docs/migration-inventory.json` records target SHA-256 `c423390ffbf49f952d8737f983a5899cd897775778ff236b9c24d76b357458d0`, matching the current `tests/socket/hub-cli.test.ts` bytes.

Verification boundary: the already-recorded focused result is 11/11 passing; it was not rerun as instructed. The four fix-round-1 findings remain accepted as PASS and were not reopened. No full review or packed-source-policy review was performed.


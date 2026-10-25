# Task 1 fix round 1 re-review

Date: 2026-10-26

Reviewed range: `4040b04..44abb46`

Scope: focused re-review of `.superpowers/sdd/2026-10-26-independent-packages/review-task-1-fix-1.diff` against the four findings in `task-1-review.md` and the plan's Global Constraints. No legacy audit, suite rerun, Docker/service/network access, host-state inspection, or subagent use. Controller-owned unstaged documentation and `integration-tests/protocol-compatibility.test.mjs` were excluded.

## Verdict

**PASS — all four original findings are resolved. No remaining important issue was found in the fix diff.**

## Original finding dispositions

- **Resolved — omitted `runtime_probe_provider.ts`.** `package.json:38-48` now explicitly packs the provider alongside the existing runtime globs and launcher. The packed-artifact regression requires `runtime_probe.py`, `runtime_probe_provider.ts`, and `runtime_probe_ws.mjs` to exist as regular, non-symlink files (`tests/manager-dist.test.mjs:84-93`). The verifier inventory also hashes the exact trio (`scripts/manager-dist.mjs:16-26`), matching the fixed three-file profile recorded by the migrated sources.

- **Resolved — installed `verify:dist` missing-source failure.** The verifier now inventories only shipped source/executable inputs (`scripts/manager-dist.mjs:9-28`) and still hashes all files below the shipped `bin/`, `hub/`, `protocol/`, and `gate/gate/` trees plus the explicit runtime set. It verifies both that source inventory and every non-manifest file under `dist/` (`scripts/manager-dist.mjs:106-135,155-164`). The regression creates the actual scripts-disabled, offline tarball, extracts it, and runs the verifier from that extracted package (`tests/manager-dist.test.mjs:33-57,84-102`). This is adequate for packed-artifact integrity without exercising unimplemented native, Docker, MCP, or orchestration features.

- **Resolved — helper HOME/both-config isolation.** `isolatedHubCliEnvironment` removes inherited `HOME`, `PI_MANAGER_CONFIG`, and `PI_WEB_UI_HUB_CONFIG`, creates a private temporary home/fallback directory, and assigns both configuration variables below the same helper root (`tests/helpers/hub-cli.ts:19-30`). All helper CLI subprocesses use that environment while retaining explicit `--config` (`tests/helpers/hub-cli.ts:54-70,84-89,138-140`). The focused regression asserts all three paths remain below the temporary root (`tests/helper-environment.test.ts:8-18`). This satisfies Global Constraints even for a CLI regression that ignores the explicit option.

- **Resolved — README future/current ambiguity.** Current behavior is limited to independent Hub initialization/serving, existing registration/session/portal behavior, and distribution of presently unconnected Gate/runtime sources (`README.md:40-45`). Lifecycle management, extension tasks, MCP, native/Docker backends, and the unified Manager are explicitly labeled future and unimplemented (`README.md:47-52`), consistent with the status warning at `README.md:3-5`.

## Focused integrity and migration assessment

- The packed-source-only manifest is internally coherent for its stated purpose. Vite derives the embedded build identity from the same source inventory, while the shipped verifier binds that inventory and the packaged output. Excluding checkout-only tests, lockfiles, and TypeScript/Vite configuration means the manifest is an installed-artifact consistency check, not a reproducible-toolchain attestation; `scripts/manager-dist.mjs:9-12` and `README.md:20` state that boundary. Under the explicitly intentional policy for this fix, this is adequate and not a finding.

- The tarball regression covers the prior packaging failures at the correct boundary: it tests the real npm allow-list result, checks the runtime probe trio's file type, and executes the installed verifier (`tests/manager-dist.test.mjs:33-57,84-102`). A live probe/native/MCP execution would exceed this fix's extraction-only scope and is not needed to establish the three-file packed closure.

- Migration accounting now explicitly records retirement/replacement of the old nested Hub package and Web-repository Vite entry (`docs/migration-inventory.json:7-20`). The runtime README and provenance dispositions are clearly documentary-only (`docs/migration-inventory.json:22-35`), while their copied targets remain separately hash-accounted in the ordinary migration entries (`docs/migration-inventory.json:1551-1555,1593-1597`). These additions do not claim runtime wiring or current unified-manager capability.

## Evidence limit

No commands that build, pack, run tests, open listeners, or inspect external state were executed in this re-review. Reported GREEN results in `task-1-report.md` were treated as supplied fix evidence; this verdict is based on the scoped diff and static file/line inspection only.

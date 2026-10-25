## Task 1: Independently buildable Manager distribution

**Files:** Create manager-owned `hub/`, `bin/`, `protocol/`, `gate/`, `runtime/`, `scripts/`, `tests/`, package metadata/lock, TypeScript/build configuration, LICENSE, and migration inventory. Read only the Web snapshot; do not alter Web files in this task.

**Interfaces:** Preserve `startHub(config, options)`, private registration protocol and existing task/API contracts. Produce `dist/hub/pi-web-hub.mjs` for transition tests and a `pi-manager` package bin pointing to the bundled CLI. Existing Hub CLI commands remain usable; a CLI alias is not a new process supervisor.

- [ ] Write package isolation tests first. The real CLI must initialize private state without Pi; detached bundle must execute with only declared runtime dependencies; invalid arguments must fail without printing secret input.

```js
const result = spawnSync(process.execPath,
  [cli, 'init', '--config', path.join(temp, 'config.json'), '--port', '0'],
  {encoding: 'utf8'});
assert.equal(result.status, 0, result.stderr);
assert.equal(statSync(path.join(temp, 'config.json')).mode & 0o077, 0);
```

- [ ] Run `node --test tests/manager-package.test.mjs` and observe failure from the missing distributable. Record RED output.
- [ ] Copy exact tracked sources and LICENSE from the immutable snapshot; include Gate and runtime tests. Compute a source inventory with original path, target path and SHA-256. Preserve hybrid Web/Hub integration fixtures under `integration-tests/legacy-web/` outside default tests, with an explicit dependency/setup guide; do not silently drop them or label them passed.
- [ ] Move required protocol helpers out of extension ownership into `protocol/`; update internal imports. Copy only the dependency closure needed by the manager and its tests; no imports into a sibling checkout. Keep the old protocol fields and security checks unchanged.
- [ ] Add `package.json` with local project name `@swordfate/pi-manager`, `private: true`, `bin.pi-manager`, production dependency ws, and build/check/test scripts. Do not declare `pi.extensions`. Use the installed toolchain for development only; a local node_modules link must not become a shipped dependency.
- [ ] Build the Hub bundle with independent source/output consistency checks and strict private-file behavior. Preserve embedded version/build metadata using manager metadata; preserve old API field names for protocol compatibility. A build must not depend on Web frontend files.
- [ ] Migrate applicable tests, fixing real paths rather than weakening assertions. Default test enumeration includes all migrated manager unit tests; socket tests remain runnable separately if this environment disallows binding.
- [ ] Run build, types, distribution verification, package tests, offline manager tests, Gate offline tests and `npm pack --dry-run --ignore-scripts --json`. Test a detached temporary copy with only declared dependencies; classify any socket/permission/network blockage explicitly.
- [ ] Update README with actual working CLI usage and outstanding capabilities; commit only manager task files. Write report with RED/GREEN commands, migrated test inventory, skipped/blocked checks and changed paths.


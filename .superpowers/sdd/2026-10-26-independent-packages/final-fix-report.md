# Final extraction fix wave report

Date: 2026-10-26

Manager base: `7ef34900b786585bc8c6f5cff385cfb6557db926` (`codex/bootstrap`)

Web base: `eef18b555dbe99f31de9408299751af221daab7b` (`v1`)

Web fix commit: `2838497` (`docs: clarify local web v1 evaluation`)

Manager fix commit: the commit containing this report; its hash is reported in the final handoff because a commit cannot contain its own final hash.

## Scope completed

- Manager generated-cache policy now ignores only regular `__pycache__` directories and `.pyc`/`.pyo` bytecode during source inventory, after rejecting symlinks. Real source changes remain inventory-visible.
- Manager package selection now explicitly ships `gate/gate/*.py` rather than the entire cache-bearing directory.
- Real synthetic-cache `npm pack`/extract coverage proves archive exclusion and extracted self-verification.
- Source, cache-directory, cache-bytecode and output symlinks remain fail-closed.
- All four reviewed direct state-capable CLI children use the fixture-owned `f.cliEnvironment`; the static guard rejects a generic `env: process.env` substitute.
- Installed help advertises `pi-manager` and shipped `README.md` while preserving the bundle filename, commands and protocol behavior.
- The three adapted migration target hashes were refreshed; immutable source hashes were not changed.
- Manager distribution was rebuilt. Web documentation now distinguishes the public default source from the local unpublished `v1`, gives an actual local extension-evaluation path, explains local update behavior and shows proxy-to-Web / proxy-to-Manager as alternatives.

## Changed paths

Manager implementation, tests and generated distribution:

- `bin/pi-web-hub.mjs`
- `package.json`
- `scripts/manager-dist.mjs`
- `tests/manager-dist.test.mjs`
- `tests/manager-package.test.mjs`
- `tests/hub-cli-environment.test.ts`
- `tests/hub-cli-isolation-guard.test.mjs`
- `tests/socket/hub-state-budget.test.ts`
- `tests/socket/hub-bounded-registry.test.ts`
- `docs/migration-inventory.json`
- `dist/hub/pi-web-hub.mjs`
- `dist/build-manifest.json`
- `.superpowers/sdd/2026-10-26-independent-packages/final-fix-report.md`

Web documentation:

- `/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals/README.md`

`package-lock.json` did not change. Existing `gate/gate/__pycache__/` files were neither deleted nor modified.

## TDD RED evidence

Every state-capable command below used an outer temporary `HOME`, `PI_MANAGER_CONFIG` and `PI_WEB_UI_HUB_CONFIG`. The cache/package and help commands initially required the approved narrow local-child permission after the restricted runner returned `EPERM`; the approved reruns remained local/offline and temporary.

### Direct CLI environment guard

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-red-guard-direct.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node tests/hub-cli-isolation-guard.test.mjs
```

Result: exit `1`; **0 passed, 1 failed**. Expected failure: `tests/socket/hub-state-budget.test.ts direct CLI child requires an explicit isolated env`.

### Generated-cache identity and real archive

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-red-dist-approved.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node tests/manager-dist.test.mjs
```

Result: exit `1`; **4 passed, 4 failed across 8 assertions**. Expected failures:

- synthetic caches changed source count `73 -> 75` and source SHA-256;
- the actual tarball contained `__pycache__`/bytecode;
- the extracted package verifier rejected source inventory drift.

Source mutation, ordinary source-symlink rejection and cache-directory-symlink rejection already passed and were retained as security characterizations.

### Installed help

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-red-help-approved.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node --test --test-name-pattern='installed CLI help advertises' tests/manager-package.test.mjs
```

Result: exit `1`; **0 passed, 1 failed**. Expected failure: output had `pi-web-hub` commands and `docs/hub.md`, not `pi-manager` and shipped `README.md`.

### Existing environment-helper characterization

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-red-env.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node --import ./tests/register-ts.mjs --test tests/hub-cli-environment.test.ts
```

Result: exit `0`; **1 passed, 0 failed**. This established the existing helper behavior before wiring the four missing call sites.

## GREEN and focused verification evidence

### Manager build and typecheck

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-build.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback" "$outer/npm-cache"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" NPM_CONFIG_CACHE="$outer/npm-cache" npm run build
```

Result: exit `0`; TypeScript typecheck passed, Vite transformed 33 modules, and `dist/hub/pi-web-hub.mjs` was rebuilt.

Final manifest identity:

- source count: `73`
- source SHA-256 / embedded Manager build fingerprint: `f2de543148aae1627dfb104aa7e2f33ec24aa6b8e1fd65b90a2fc231632a4ceb`
- output count: `1`
- output inventory SHA-256: `256ddd7123a90e636e86e879fd0cb7285cf5169c85a8f46135e3e96a3dfb69e0`
- bundle SHA-256 recorded in the manifest: `8ac83c6e6468317648bdd8bacc01008b925166e916f2dc27a2079d77508482e1`

### Cache, drift, symlink and actual pack/extract regression

Final command:

```bash
outer=$(mktemp -d /tmp/pi-manager-green-symlink-pack.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node tests/manager-dist.test.mjs
```

Result: exit `0`; **10 passed, 0 failed**. Covered:

- unchanged identity and clean manifest verification after synthetic `__pycache__/*.pyc` plus top-level `.pyc` creation;
- genuine source mutation rejection;
- ordinary source symlink rejection;
- cache-directory symlink rejection;
- bytecode-named symlink rejection;
- output symlink rejection;
- actual offline `npm pack --ignore-scripts`, tar extraction, archive cache absence, runtime-probe closure and extracted verifier success.

### Package and installed help

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-green-package.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node tests/manager-package.test.mjs
```

Result: exit `0`; **7 passed, 0 failed**, including the focused installed-help assertion.

### State-budget direct children

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-green-state-budget.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node --import ./tests/register-ts.mjs tests/socket/hub-state-budget.test.ts
```

Result: exit `0`; **12 passed, 0 failed**. Quota, race, lock, proof and symlink assertions were preserved.

### Named bounded-registry subset only

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-green-bounded.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node --import ./tests/register-ts.mjs --test --test-name-pattern='a separate CLI revoke during proof wins before registration memory publication' tests/socket/hub-bounded-registry.test.ts
```

Result: exit `0`; **1 passed, 0 failed**. The unchanged 2,000-rotation/60-second stress case was not selected or rerun.

### Direct static and behavioral environment guards

Commands:

```bash
outer=$(mktemp -d /tmp/pi-manager-green-tight-guard.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node tests/hub-cli-isolation-guard.test.mjs

outer=$(mktemp -d /tmp/pi-manager-green-guards.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node --import ./tests/register-ts.mjs tests/hub-cli-environment.test.ts
```

Result: exit `0`; **2 passed, 0 failed**. The AST guard requires the reviewed `env: f.cliEnvironment` expression at exactly four direct state-capable child sites.

### Final distribution and migration-hash audit

Command:

```bash
outer=$(mktemp -d /tmp/pi-manager-final-audit.XXXXXX)
mkdir -p "$outer/home" "$outer/fallback"
env HOME="$outer/home" PI_MANAGER_CONFIG="$outer/fallback/manager.json" PI_WEB_UI_HUB_CONFIG="$outer/fallback/legacy.json" node scripts/manager-dist.mjs
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const inventory=require("./docs/migration-inventory.json"); const targets=["bin/pi-web-hub.mjs","tests/socket/hub-state-budget.test.ts","tests/socket/hub-bounded-registry.test.ts"]; for (const target of targets) { const entry=inventory.entries.find((item)=>item.target===target); const actual=crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"); if (!entry || entry.targetSha256!==actual) throw new Error(`${target}: ${entry?.targetSha256} != ${actual}`); console.log(`${target} ${actual}`); }'
node -e 'const m=require("./dist/build-manifest.json"); console.log(`source ${m.source.count} ${m.source.sha256}`); console.log(`outputs ${m.outputs.count} ${m.outputs.sha256}`);'
find gate/gate/__pycache__ -type f | wc -l
git diff --check
```

Result: exit `0`. Updated target hashes:

- `bin/pi-web-hub.mjs`: `72aed9f51729dcd59aa396f611e2ed7177d7410fb9426d3c383b723aafa1be5e`
- `tests/socket/hub-state-budget.test.ts`: `d17ccd970920b333b3cda93effbb266bccb03a3919c8891aa82b5936c4d85064`
- `tests/socket/hub-bounded-registry.test.ts`: `918b69c8607e9df5c7539b7b3aedb2dd329f418031a0167ef1d44728458041d5`

The existing ignored cache count remained `18`.

## Web documentation verification

No Web source, manifest or generated asset changed, so Web assets were not rebuilt.

Commands/checks:

```bash
git diff --check
node -e "const p=require('./package.json'); if (p.pi?.extensions?.[0] !== './extensions/mirror-server.ts') throw new Error('missing extension'); if (p.exports?.['./interactions/v1'] !== './extensions/interactions/client.ts') throw new Error('missing interactions export'); for (const name of ['build:web','verify:dist']) if (!p.scripts?.[name]) throw new Error('missing script '+name); console.log('metadata-ok');"
test -f extensions/mirror-server.ts
test -f scripts/web-dist.mjs

outer=$(mktemp -d /tmp/pi-web-readme-help.XXXXXX)
mkdir -p "$outer/home" "$outer/xdg" "$outer/agent" "$outer/sessions"
env HOME="$outer/home" XDG_CONFIG_HOME="$outer/xdg" PI_CODING_AGENT_DIR="$outer/agent" PI_CODING_AGENT_SESSION_DIR="$outer/sessions" node_modules/.bin/pi --help | rg -n -- '--extension|Package|install|update' | sed -n '1,120p'
```

Result: metadata/path checks passed; isolated Pi help advertised `pi install`, `pi update` and `--extension, -e <path>`. README references the existing `extensions/mirror-server.ts`, `build:web`, `verify:dist`, public Git source and explicit local extension-file path. Only `README.md` was committed in Web.

One earlier read-only `pi --help` probe omitted temporary Pi variables and stopped on `EROFS` while attempting to create `/home/fate/.pi/agent/trust.json.lock`; no file was created or modified. The isolated rerun above passed. One read-only `rg` probe used unsafe shell quoting around Markdown backticks and emitted `@v1: command not found`; it changed nothing and was rerun successfully with single-quoted input.

## Preserved boundaries and gaps

- Did not delete, regenerate into identity, stage or modify the 18 ignored existing Python cache files.
- Did not weaken source/output symlink checks or real-source drift detection.
- Did not rerun the unchanged 2,000-rotation stress case or convert its recorded 60-second cancellation into green evidence.
- Did not run the full Manager suite, broad socket aggregate, full Gate/runtime suites, broad Web tests, Web rebuild, browser/mobile, real-Pi, Docker, deployment, network publication or production operations.
- Controller retains ownership of post-build zero-Pi desktop/mobile smoke, the cross-project existing-two-test driver, docs/research/source-provenance/validation files and the five archived-report EOF corrections. None is staged by this fix wave.
- Existing controller `.tmp` drivers/evidence were not overwritten.
- No push, merge, main switch, publication, deployment or real credential/config/state operation was performed.

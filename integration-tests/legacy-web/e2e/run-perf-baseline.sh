#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PI_E2E_RUNTIME_DIR="${PI_E2E_RUNTIME_DIR:-$HOME/.pi/agent/local/pi-web-ui/releases/0.1.1-3455d073085dedfbc606806b}"
export PI_E2E_REPORT="${PI_E2E_REPORT:-immutable-0.1.1-3455d073085dedfbc606806b-baseline}"
# The release bundle contains immutable extension/assets; launch the installed project Pi CLI.
export PI_E2E_BIN="${PI_E2E_BIN:-$ROOT/node_modules/.bin/pi}"
test -f "$PI_E2E_RUNTIME_DIR/dist/index.html"
test -f "$PI_E2E_RUNTIME_DIR/extensions/mirror-server.ts"
cd "$ROOT"
./node_modules/.bin/bddgen test -c e2e/playwright.config.ts
./node_modules/.bin/playwright test -c e2e/playwright.config.ts --grep '长会话 sidebar toggle'

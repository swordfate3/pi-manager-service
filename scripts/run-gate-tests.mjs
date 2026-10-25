import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const gateTestGroups = Object.freeze({
  offline: Object.freeze([
    "test_lifecycle_round2.py",
    "test_lifecycle_round3.py",
    "test_lifecycle_source_evidence.py",
    "test_registry.py",
    "test_runtime_catalog.py",
    "test_runtime_clients.py",
    "test_runtime_discovery_http.py",
    "test_runtime_engine.py",
    "test_runtime_exit_confirmation.py",
    "test_runtime_inspect_transport.py",
    "test_runtime_install.py",
    "test_runtime_installed_version.py",
    "test_runtime_inventory_obligations.py",
    "test_runtime_inventory_retry.py",
    "test_runtime_namespace.py",
    "test_runtime_npm_origin.py",
    "test_runtime_npm_transport.py",
    "test_runtime_poll_reconciliation.py",
    "test_runtime_probe_launcher.py",
    "test_runtime_regressions.py",
    "test_runtime_restore_contract.py",
    "test_runtime_restore_control.py",
    "test_runtime_restore_recovery.py",
    "test_runtime_restore_validation.py",
    "test_runtime_security.py",
    "test_runtime_session_capture.py",
    "test_runtime_source_identity.py",
    "test_runtime_source_validation.py",
    "test_runtime_supervisor_fences.py",
    "test_runtime_updates.py",
    "test_runtime_validation_flow.py",
    "test_runtime_versions.py",
  ]),
  socket: Object.freeze([
    "test_gate.py",
    "test_hub_management.py",
    "test_lifecycle.py",
    "test_lifecycle_round1.py",
    "test_multiservice.py",
    "test_pi_launch_engine.py",
    "test_pi_launches.py",
    "test_runtime_http.py",
    "test_runtime_restore_upload.py",
  ]),
});

function run(group) {
  const files = group === "all" ? [...gateTestGroups.offline, ...gateTestGroups.socket] : gateTestGroups[group];
  if (!files) throw new Error("Usage: run-gate-tests.mjs <offline|socket|all>");
  const modules = files.map((file) => file.slice(0, -3));
  const result = spawnSync("python3", ["-m", "unittest", ...modules], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: [path.join(root, "gate"), path.join(root, "gate", "tests")].join(path.delimiter),
      PI_MANAGER_LEGACY_WEB_SOURCE: path.join(root, "gate", "tests", "fixtures", "legacy-web-source"),
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Gate tests terminated by ${result.signal}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

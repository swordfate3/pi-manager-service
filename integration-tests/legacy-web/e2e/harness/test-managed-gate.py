"""Opt-in: real Gate + packaged Hub + two real Docker/Pi TUI processes.

Requires PI_REAL_DOCKER_TEST=1 and an isolated PI_RUNTIME_TEST_IMAGE built
with Dockerfile.managed-runtime. Never mounts existing volumes or credentials.
"""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("isolated_managed_runtime", ROOT / "e2e/harness/test-managed-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
GATE_SOURCE = Path(os.environ.get("PI_GATE_SOURCE", ROOT.parent / "pi-runtime-restart-work/gate"))


@unittest.skipUnless(os.environ.get("PI_REAL_DOCKER_TEST") == "1" and os.environ.get("PI_RUNTIME_TEST_IMAGE"),
                     "requires explicit opt-in and isolated test image")
class RealGateIntegration(unittest.TestCase):
    def test_hub_authorized_gate_restart_preserves_container_and_exact_branch(self):
        sys.path.insert(0, str(GATE_SOURCE))
        from gate.engine import Engine
        from gate.service import Gate, start_servers

        observations = []
        inspections = {}

        class ObservedEngine(Engine):
            def inspect(self, identifier, timeout=None):
                value = super().inspect(identifier, timeout=timeout)
                if value:
                    projection = {key: value.get(key) for key in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')}
                    projection['started'] = value.get('State', {}).get('StartedAt')
                    previous = inspections.get(identifier)
                    if previous and previous != projection:
                        changes = [key for key in projection if previous[key] != projection[key]]
                        observations.append({'boundary': 'inspect-drift', 'changed_fields': changes,
                                             'mount_order': [m.get('Destination') for m in projection['Mounts']],
                                             'same_mount_set': sorted(json.dumps(m, sort_keys=True) for m in previous['Mounts']) ==
                                             sorted(json.dumps(m, sort_keys=True) for m in projection['Mounts'])})
                    inspections[identifier] = projection
                return value

            def call(self, method, route, *args, **kwargs):
                started = time.monotonic()
                try:
                    value = super().call(method, route, *args, **kwargs)
                    if route.startswith('/exec/') and route.endswith('/json'):
                        observations.append({'boundary': 'exec-inspect', 'running': value.get('Running'),
                                             'exit': value.get('ExitCode'),
                                             'elapsed_ms': round((time.monotonic() - started) * 1000)})
                    return value
                except Exception as error:
                    observations.append({'boundary': 'docker-' + method, 'error': type(error).__name__,
                                         'elapsed_ms': round((time.monotonic() - started) * 1000)})
                    raise

        def observe(name, callback):
            def wrapped(*args, **kwargs):
                started = time.monotonic()
                try:
                    return callback(*args, **kwargs)
                except Exception as error:
                    observations.append({'boundary': name, 'error': type(error).__name__, 'reason': str(error),
                                         'elapsed_ms': round((time.monotonic() - started) * 1000)})
                    raise
            return wrapped

        image = os.environ["PI_RUNTIME_TEST_IMAGE"]
        image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
        # Named non-production test image only; never enable policy on the real Gate.
        self.assertRegex(image_id, r"^sha256:[a-f0-9]{64}$")
        with tempfile.TemporaryDirectory(prefix="pi-gate-e2e-") as temporary:
            directory = Path(temporary)
            gate = Gate(directory / "gate")
            gate.lifecycle.engine = ObservedEngine()
            for name in ('_resolve', '_status', '_consume'):
                setattr(gate.lifecycle, name, observe(name, getattr(gate.lifecycle, name)))
            gate.lifecycle.set_policy({"mode": "auto", "images": [image_id]})
            servers = start_servers(gate, port=0)
            stopped = threading.Event()

            def tick():
                while not stopped.wait(0.05):
                    gate.tick()

            ticker = threading.Thread(target=tick, daemon=True)
            ticker.start()
            cli = ["node", str(ROOT / "dist/hub/pi-web-hub.mjs")]
            config = directory / "hub.json"

            def command(*args):
                result = subprocess.run([*cli, *args, "--config", str(config)], capture_output=True,
                                        text=True, check=True, timeout=10)
                return json.loads(result.stdout)

            command("init", "--port", "0")
            credential = directory / "lifecycle.json"
            credential.write_text(json.dumps({"token": gate.lifecycle_token}))
            credential.chmod(0o600)
            settings = json.loads(config.read_text())
            settings["lifecycle"] = {"endpoint": f"http://127.0.0.1:{servers[0].server_port}",
                                     "credentialFile": str(credential)}
            settings["management"] = {"port": 0}
            config.write_text(json.dumps(settings))
            hub_process = subprocess.Popen([*cli, "serve", "--config", str(config)], stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, text=True)
            a = b = None
            try:
                self.assertTrue(select.select([hub_process.stdout], [], [], 10)[0], "Isolated Hub startup failed")
                hub = json.loads(hub_process.stdout.readline())
                admin_url = hub["managementUrl"]
                origin = urlsplit(admin_url)
                origin = f"{origin.scheme}://{origin.netloc}"
                cap_a = command("issue", "--label", "Synthetic managed A", "--output", str(directory / "a.json"))
                cap_b = command("issue", "--label", "Synthetic managed B", "--output", str(directory / "b.json"))
                (directory / "a").mkdir()
                (directory / "b").mkdir()
                a = runtime.RealTui(directory / "a", hub, cap_a, "a", image)
                b = runtime.RealTui(directory / "b", hub, cap_b, "b", image)
                old = runtime.wait_for(a.status)
                other = runtime.wait_for(b.status)
                container_id = subprocess.check_output(
                    ["docker", "inspect", "--format", "{{.Id}}", a.container], text=True).strip()

                def sessions():
                    with urllib.request.urlopen(hub["localUrl"] + "api/sessions", timeout=3) as response:
                        return json.load(response)["sessions"]

                initial = runtime.wait_for(lambda: sessions() if len(sessions()) == 2 else None)
                selected = next(item for item in initial if "managed A" in item["label"])
                cookie = csrf = ""

                def request(route, value=None):
                    headers = {"Content-Type": "application/json", "Origin": origin}
                    if cookie:
                        headers.update(Cookie=cookie, **{"X-Pi-Hub-Csrf": csrf})
                    body = None if value is None else json.dumps(value).encode()
                    with urllib.request.urlopen(urllib.request.Request(
                            admin_url + "api/management/" + route, data=body, headers=headers), timeout=8) as response:
                        return json.load(response), response.headers.get("Set-Cookie")

                if os.environ.get("PI_REAL_BROWSER_TEST") == "1":
                    browser = subprocess.run(
                        ["node", "--import", "./tests/register-ts.mjs", "e2e/harness/browser-managed-restart.ts"],
                        input=json.dumps({"adminUrl": admin_url, "chatUrl": hub["localUrl"],
                                          "generation": selected["generation"], "label": selected["label"],
                                          "code": command("pair")["code"]}),
                        cwd=ROOT, capture_output=True, text=True, timeout=90)
                    self.assertEqual(browser.returncode, 0, browser.stderr + "\nSynthetic Gate jobs: " +
                                     json.dumps(gate.lifecycle.jobs()) + "\nSynthetic target: " + json.dumps(a.status()) +
                                     "\nSynthetic boundary observations: " + json.dumps(observations[-30:]))
                    browser_result = json.loads(browser.stdout)
                    self.assertTrue(browser_result["browserRecovery"])
                    key = browser_result["id"]
                else:
                    key = "d" * 32
                paired, set_cookie = request("unlock", {"code": command("pair")["code"]})
                cookie = set_cookie.split(";")[0]
                csrf = paired["csrf"]
                if os.environ.get("PI_REAL_BROWSER_TEST") != "1":
                    target, _ = request("targets/" + selected["generation"])
                    self.assertTrue(target["managed"])
                    self.assertEqual(target["mode"], "auto")
                    accepted, _ = request("restarts", {
                        "generation": selected["generation"], "runtimeId": old["runtime_id"],
                        "sessionId": old["session_id"], "leafId": old["leaf_id"], "idempotencyKey": key})
                    self.assertEqual(accepted["id"], key)

                def finished():
                    result, _ = request("restarts/" + key)
                    return result if result["status"] not in ("pending", "queued", "running") else None

                final = runtime.wait_for(finished, 45)
                self.assertEqual(final["status"], "succeeded", final)
                self.assertRegex(final["path"], r"^/s/[a-f0-9]{32}/$")
                new = a.status()
                self.assertNotEqual(new["runtime_id"], old["runtime_id"])
                self.assertEqual((new["session_id"], new["leaf_id"]), (old["session_id"], old["leaf_id"]))
                self.assertEqual(new["version"], final["expected_version"])
                self.assertEqual(subprocess.check_output(
                    ["docker", "inspect", "--format", "{{.Id}}", a.container], text=True).strip(), container_id)
                self.assertEqual(b.status()["runtime_id"], other["runtime_id"])
                messages = [json.loads(line) for line in a.session.read_text().splitlines()
                            if json.loads(line).get("type") == "message"]
                self.assertEqual(len(messages), 2)
                public_result = json.dumps(final)
                for private in (container_id, gate.lifecycle_token, str(directory)):
                    self.assertNotIn(private, public_result)
                retry, _ = request("restarts", {"generation": selected["generation"], "runtimeId": old["runtime_id"],
                                                "sessionId": old["session_id"], "leafId": old["leaf_id"],
                                                "idempotencyKey": key})
                self.assertEqual(retry["status"], "succeeded")
                self.assertEqual(a.status()["runtime_id"], new["runtime_id"], "Query/retry must not restart again")
                os.write(a.fd, b"/quit\r")
                runtime.wait_for(a.exited, 10)
                self.assertEqual(b.status()["runtime_id"], other["runtime_id"])
            finally:
                if a:
                    a.close()
                if b:
                    b.close()
                hub_process.terminate()
                hub_process.wait(timeout=10)
                hub_process.stdout.close()
                stopped.set()
                ticker.join(timeout=2)
                for server in servers:
                    server.shutdown()
                    server.server_close()
                gate.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

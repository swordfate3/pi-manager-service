"""Opt-in integration: real Pi TUI + private supervisor + packaged Hub, no external model.

PI_RUNTIME_SOURCE points to the staged pi-docker sources. Uses temporary state only.
Run with python3 e2e/harness/test-managed-runtime.py from the package root.
"""
import fcntl
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
import unittest
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get("PI_RUNTIME_SOURCE", ROOT.parent / "pi-runtime-restart-work/pi-docker"))
RUNTIME_SOURCE = SOURCE / "runtime" if (SOURCE / "runtime").is_dir() else SOURCE


def wait_for(function, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = function()
            if result:
                return result
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        time.sleep(0.05)
    raise AssertionError("Isolated real Pi did not reach the expected state")


class RealTui:
    def __init__(self, directory, hub, capability, branch, docker_image=None, *, runtime_volume=None,
                 image_owned_package=False):
        if runtime_volume is not None and (not docker_image or not re.fullmatch(
                r"pi-runtime-update-test-[a-f0-9]{12,32}", runtime_volume)):
            raise ValueError("an isolated runtime test volume is required")
        self.expected_version = os.environ.get("PI_RUNTIME_TEST_VERSION") if docker_image else None
        if docker_image and not self.expected_version:
            raise AssertionError("Docker runtime acceptance requires PI_RUNTIME_TEST_VERSION")
        if (RUNTIME_SOURCE / "pi_stdin_guard.mjs").read_bytes() != (ROOT / "extensions/runtime-stdin-guard.mjs").read_bytes():
            raise AssertionError("Image guard must match the reviewed package guard before integration")
        self.directory = directory
        self.runtime = directory / "runtime"
        self.runtime.mkdir(mode=0o700)
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.agent = directory / "agent"
        self.agent.mkdir()
        self.session = directory / "conversation.jsonl"
        self.session_id = f"synthetic-session-{branch}"
        # Keep the synthetic conversation inside the UI's default recent window.
        instant = datetime.now(timezone.utc) - timedelta(seconds=2)
        stamps = [(instant + timedelta(seconds=index)).isoformat() for index in range(3)]
        ticks = [int((instant + timedelta(seconds=index)).timestamp() * 1000) for index in range(3)]
        entries = [
            {"type": "session", "version": 3, "id": self.session_id, "timestamp": stamps[0],
             "cwd": "/workspace/workspace" if docker_image else str(self.workspace)},
            {"type": "message", "id": f"user-{branch}", "parentId": None, "timestamp": stamps[1],
             "message": {"role": "user", "content": "SYNTHETIC SAVED TURN, DO NOT REPLAY", "timestamp": ticks[1]}},
            {"type": "message", "id": f"leaf-{branch}", "parentId": f"user-{branch}", "timestamp": stamps[2],
             "message": {"role": "assistant", "content": [{"type": "text", "text": "Synthetic saved reply"}], "api": "openai-completions", "provider": "faux", "model": "faux-1", "stopReason": "stop",
                         "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "timestamp": ticks[2]}},
        ]
        self.session.write_text("".join(json.dumps(e) + "\n" for e in entries))
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            web_port = port.getsockname()[1]
        self.env = {**os.environ, "TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(self.agent), "PI_E2E": "1", "PI_OFFLINE": "1",
                    "PI_RUNTIME_RUN_ID": capability["runId"], "PI_RUNTIME_DIR": str(self.runtime), "PI_WEB_UI_HOST": "127.0.0.1", "PI_WEB_UI_PORT": str(web_port),
                    "PI_WEB_UI_REGISTRY_SOCKET": hub["socketPath"], "PI_WEB_UI_REGISTRY_CREDENTIAL_FILE": capability["credentialFile"],
                    "PI_WEB_UI_DISABLED": "false", "PI_WEB_UI_STATIC_DIR": str(ROOT / "dist"), "PI_WEB_UI_PUBLIC_URL": ""}
        argv = ["/usr/bin/python3", str(RUNTIME_SOURCE / "pi_supervisor.py"), "--", str(ROOT / "node_modules/.bin/pi"),
                "--provider", "faux", "--model", "faux-1", "--api-key", "faux-key", "--thinking", "medium", "--session", str(self.session),
                "--no-skills", "--no-prompt-templates", "--no-context-files", "--tui-mode", "regular",
                "--extension", str(ROOT / "e2e/fixtures/faux-provider-extension.ts"), "--extension", str(ROOT / "extensions/mirror-server.ts")]
        self.container = None
        self.verified_image_guard = False
        if docker_image:
            self.container = "pi-runtime-test-" + uuid.uuid4().hex
            package = directory / ".test-package"
            shutil.copytree(ROOT / "extensions", package / "extensions")
            shutil.copytree(ROOT / "e2e/fixtures", package / "e2e/fixtures")
            shutil.copytree(ROOT / "node_modules/ws", package / "node_modules/ws")
            if os.environ.get("PI_REAL_BROWSER_TEST") == "1":
                shutil.copytree(ROOT / "dist", package / "dist")
            peers = package / "node_modules/@earendil-works"
            peers.mkdir(parents=True)
            installed = "/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent"
            (peers / "pi-coding-agent").symlink_to(installed)
            (peers / "pi-ai").symlink_to(installed + "/node_modules/@earendil-works/pi-ai")
            # A test-local hardlink reaches the same live Unix socket without
            # mounting Hub's private state or borrowing its production volume.
            os.link(hub["socketPath"], directory / ".test-registry.sock")
            # Explicitly selected synthetic configuration only: never copy host
            # API keys, SSH, credentials or persistent volumes into this test.
            keys = ("PI_CODING_AGENT_DIR", "PI_E2E", "PI_OFFLINE", "PI_RUNTIME_RUN_ID",
                    "PI_WEB_UI_HOST", "PI_WEB_UI_PORT", "PI_WEB_UI_REGISTRY_SOCKET",
                    "PI_WEB_UI_REGISTRY_CREDENTIAL_FILE", "PI_WEB_UI_DISABLED",
                    "PI_WEB_UI_STATIC_DIR", "PI_WEB_UI_PUBLIC_URL")
            selected = {key: self.env[key] for key in keys}
            selected.update(HOME="/home/node", TERM="xterm-256color", PI_RUNTIME_DIR="/run/pi-runtime",
                            PI_CODING_AGENT_DIR="/workspace/agent", PI_WEB_UI_REGISTRY_SOCKET="/workspace/.test-registry.sock",
                            PI_WEB_UI_REGISTRY_CREDENTIAL_FILE="/run/secrets/pi-web-session.json",
                            PI_WEB_UI_STATIC_DIR="/workspace/.test-package/dist")
            argv = ["docker", "run", "--rm", "-it", "--name", self.container,
                    "--network", "host", "--user", "1000:1000", "--cap-drop=ALL",
                    "--security-opt=no-new-privileges", "--memory", "1g", "--pids-limit", "128",
                    "--label", "cn.swordfate.pi.run-id=" + capability["runId"],
                    "--label", "cn.swordfate.pi.lifecycle=1",
                    "--workdir", "/workspace/workspace"]
            if runtime_volume is not None:
                argv.extend(["--mount", f"type=volume,source={runtime_volume},target=/home/node/.local"])
            mounts = [(directory, "/workspace", False),
                      (Path(capability["credentialFile"]), "/run/secrets/pi-web-session.json", True)]
            for source, destination, readonly in mounts:
                argv.extend(["--mount", f"type=bind,source={source},target={destination}" + (",readonly" if readonly else "")])
            for key, value in selected.items():
                argv.extend(["--env", f"{key}={value}"])
            argv.extend([docker_image, "--provider", "faux", "--model", "faux-1", "--api-key", "faux-key",
                         "--thinking", "medium", "--session", "/workspace/conversation.jsonl", "--no-skills",
                         "--no-prompt-templates", "--no-context-files", "--tui-mode", "regular",
                         "--extension", ("/opt/pi-web-ui/e2e/fixtures/runtime-update-provider.ts" if image_owned_package
                                         else "/workspace/.test-package/e2e/fixtures/faux-provider-extension.ts"),
                         "--extension", ("/opt/pi-web-ui/extensions/mirror-server.ts" if image_owned_package
                                         else "/workspace/.test-package/extensions/mirror-server.ts")])
        # Gate/Hub already own threads here; do not fork Python and execute
        # Python user code in the child with inherited thread locks.
        self.fd, slave = pty.openpty()
        try:
            self.process = subprocess.Popen(argv, cwd=self.workspace, env=self.env,
                                            stdin=slave, stdout=slave, stderr=slave,
                                            start_new_session=True)
        except BaseException:
            os.close(self.fd)
            raise
        finally:
            os.close(slave)
        self.pid = self.process.pid
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        self.output = bytearray()
        self.closed = False
        self.drainer = threading.Thread(target=self.drain, daemon=True)
        self.drainer.start()

    def drain(self):
        while not self.closed:
            try:
                ready, _, _ = select.select([self.fd], [], [], .1)
                if not ready:
                    continue
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    return
                self.output.extend(chunk)
                self.output = self.output[-262144:]
                if b"\x1b[6n" in chunk:
                    os.write(self.fd, b"\x1b[1;1R")
                if b"\x1b[c" in chunk:
                    os.write(self.fd, b"\x1b[?1;2c")
            except OSError:
                return

    def control(self, request):
        command = (["docker", "exec", "--user", "1000:1000", self.container, "/usr/local/bin/pi-session-control"]
                   if self.container else ["/usr/bin/python3", str(RUNTIME_SOURCE / "pi-session-control")])
        result = subprocess.run([*command, "--request", json.dumps(request)],
                                env=self.env, capture_output=True, text=True, timeout=5)
        value = json.loads(result.stdout)
        return value.get("result") if value.get("ok") else None

    def status(self):
        result = self.control({"action": "status"})
        if result and self.expected_version and result.get("version") != self.expected_version:
            raise AssertionError(f"Expected Pi {self.expected_version}, got {result.get('version')}")
        if result and self.container and not self.verified_image_guard:
            actual = subprocess.check_output(
                ["docker", "exec", "--user", "1000:1000", self.container, "/usr/bin/sha256sum",
                 "/usr/local/lib/pi-runtime/pi_stdin_guard.mjs"], text=True, timeout=5).split()[0]
            expected = hashlib.sha256((ROOT / "extensions/runtime-stdin-guard.mjs").read_bytes()).hexdigest()
            if actual != expected:
                raise AssertionError("Test image must contain the reviewed package guard")
            self.verified_image_guard = True
        return result

    def exited(self):
        if not self.pid:
            return True
        status = self.process.poll()
        if status is not None:
            self.pid = None
            return status == 0
        return False

    def close(self):
        if self.container:
            # Exact test-owned target only. Never stop user Pi or the real Hub.
            subprocess.run(["docker", "stop", "--time", "3", self.container], capture_output=True, timeout=8)
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
                wait_for(self.exited, 8)
            except (OSError, AssertionError):
                # Test-owned process group only, never real Pi or a production container.
                try: os.killpg(self.pid, signal.SIGKILL)
                except OSError: pass
                try: self.process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired): pass
        self.closed = True
        self.drainer.join(timeout=1)
        os.close(self.fd)


class ManagedRuntimeIntegration(unittest.TestCase):
    def test_real_tui_restart_retains_terminal_and_exact_saved_branch(self):
        with tempfile.TemporaryDirectory(prefix="pi-rt-e2e-") as tmp:
            directory = Path(tmp)
            cli = ["node", str(ROOT / "dist/hub/pi-web-hub.mjs")]
            config = directory / "hub.json"
            def command(*args):
                result = subprocess.run([*cli, *args, "--config", str(config)], capture_output=True, text=True, check=True, timeout=10)
                return json.loads(result.stdout)
            command("init", "--port", "0")
            server = subprocess.Popen([*cli, "serve", "--config", str(config)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            a = b = None
            try:
                self.assertTrue(select.select([server.stdout], [], [], 10)[0], "Isolated Hub failed to start")
                hub = json.loads(server.stdout.readline())
                cap_a = command("issue", "--label", "Synthetic A", "--output", str(directory / "a.json"))
                cap_b = command("issue", "--label", "Synthetic B", "--output", str(directory / "b.json"))
                (directory / "a").mkdir(); (directory / "b").mkdir()
                image = os.environ.get("PI_RUNTIME_TEST_IMAGE")
                a = RealTui(directory / "a", hub, cap_a, "a", image)
                b = RealTui(directory / "b", hub, cap_b, "b", image)
                try:
                    old = wait_for(a.status)
                except AssertionError as error:
                    # Synthetic-only terminal, bounded evidence for startup failures.
                    raise AssertionError(str(error) + "\nSynthetic Pi terminal:\n" +
                                         a.output[-6000:].decode("utf8", errors="replace")) from error
                other = wait_for(b.status)
                original_container = None
                if image:
                    original_container = subprocess.check_output(
                        ["docker", "inspect", "--format", "{{.Id}}", a.container], text=True).strip()
                self.assertEqual(old["session_id"], a.session_id)
                self.assertTrue(old["idle"] and not old["pending"] and not old["busy"],
                                "Synthetic saved TUI must be restart-eligible before submission: " + json.dumps(old))
                self.assertIn(old["leaf_id"], [json.loads(line).get("id") for line in a.session.read_text().splitlines()])
                def sessions():
                    with urllib.request.urlopen(hub["localUrl"] + "api/sessions", timeout=2) as response:
                        return json.load(response)["sessions"]
                initial_routes = wait_for(lambda: sessions() if len(sessions()) == 2 else None)
                request = {"action": "restart", "run_id": cap_a["runId"], "runtime_id": old["runtime_id"], "session_id": old["session_id"], "leaf_id": old["leaf_id"], "operation_id": "a" * 32}
                self.assertEqual(a.control(request)["status"], "running")
                def finished():
                    status = a.status()
                    return status if status and status.get("operation", {}).get("status") not in (None, "running") else None
                final = wait_for(finished, 40)
                self.assertEqual(final["operation"]["status"], "succeeded", final.get("operation"))
                self.assertEqual(final["operation"]["old_runtime_id"], old["runtime_id"])
                self.assertNotEqual(final["runtime_id"], old["runtime_id"])
                self.assertEqual(final["session_id"], old["session_id"])
                self.assertEqual(final["leaf_id"], old["leaf_id"])
                self.assertEqual(final["version"], final["operation"]["expected_version"])
                self.assertEqual(b.status()["runtime_id"], other["runtime_id"])
                if image:
                    self.assertEqual(subprocess.check_output(
                        ["docker", "inspect", "--format", "{{.Id}}", a.container], text=True).strip(), original_container)
                    owned = subprocess.check_output(
                        ["docker", "exec", "--user", "1000:1000", a.container, "/usr/bin/python3", "-c",
                         "from pathlib import Path; import os; p=Path('uid-check.txt'); p.write_text('synthetic'); print(os.getuid())"],
                        text=True).strip()
                    self.assertEqual(owned, "1000")
                    self.assertEqual((a.workspace / "uid-check.txt").stat().st_uid, 1000)
                routes = wait_for(lambda: sessions() if len(sessions()) == 2 and sessions() != initial_routes else None)
                self.assertEqual(len(routes), 2)
                messages = [json.loads(line) for line in a.session.read_text().splitlines() if json.loads(line).get("type") == "message"]
                self.assertEqual(len(messages), 2, "Restart must not replay saved turns")
                os.write(a.fd, b"/quit\r")
                wait_for(a.exited, 10)
                self.assertEqual(b.status()["runtime_id"], other["runtime_id"])
                self.assertFalse((a.runtime / "control.sock").exists(), "Ordinary quit must exit supervisor")
            finally:
                if a: a.close()
                if b: b.close()
                server.terminate()
                server.wait(timeout=10)
                server.stdout.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

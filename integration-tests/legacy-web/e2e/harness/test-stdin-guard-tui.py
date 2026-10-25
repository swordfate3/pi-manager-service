"""Synthetic TUI guard acceptance, optionally against PI_RUNTIME_TEST_IMAGE."""
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("main_tui_fixture", Path(__file__).with_name("test-managed-runtime.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

class GuardTui(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-guard-tui-")
        self.addCleanup(self.cleanup)
        self.directory = Path(self.temp.name)
        self.config = self.directory / "hub.json"
        self.cli = ["node", "--import", str(ROOT / "tests/register-ts.mjs"), str(ROOT / "bin/pi-web-hub.mjs")]
        self.command("init", "--port", "0")
        self.server = subprocess.Popen([*self.cli, "serve", "--config", str(self.config)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.assertTrue(select.select([self.server.stdout], [], [], 10)[0])
        hub = json.loads(self.server.stdout.readline())
        cap = self.command("issue", "--label", "Guard synthetic", "--output", str(self.directory / "cap.json"))
        run = self.directory / "run"; run.mkdir()
        original_exec = os.execvpe
        image = os.environ.get("PI_RUNTIME_TEST_IMAGE")
        def with_probe(executable, argv, env):
            probe = "/workspace/.test-package/e2e/fixtures/stdin-guard-probe.ts" if image else str(ROOT / "e2e/fixtures/stdin-guard-probe.ts")
            original_exec(executable, [*argv, "--extension", probe], env)
        # Child launch only: no production API or SDK method is mocked.
        with patch.object(fixture.os, "execvpe", with_probe):
            self.tui = fixture.RealTui(run, hub, cap, "guard", docker_image=image)
        self.old = fixture.wait_for(self.tui.status)
        self.assertFalse(self.old["busy"], "fresh preloaded TUI must be eligible: " + (self.tui.workspace / "guard-start.json").read_text() + " version=" + self.old["version"])

    def command(self, *args):
        return json.loads(subprocess.check_output([*self.cli, *args, "--config", str(self.config)], text=True, stderr=subprocess.DEVNULL, timeout=10))

    def cleanup(self):
        if hasattr(self, "tui"): self.tui.close()
        if hasattr(self, "server"):
            self.server.terminate(); self.server.wait(timeout=10); self.server.stdout.close()
        self.temp.cleanup()

    def ipc(self, action, **extra):
        # Only this fixture's synthetic child credential; never logged or persisted.
        if self.tui.container:
            script = """import json, socket, sys
from pathlib import Path
child = Path('/proc/1/task/1/children').read_text().split()[0]
environment = dict(item.split(b'=', 1) for item in Path('/proc/' + child + '/environ').read_bytes().split(b'\\0') if b'=' in item)
request = json.loads(sys.argv[1])
request['token'] = environment[b'PI_RUNTIME_CHILD_TOKEN'].decode()
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(3)
    connection.connect('/run/pi-runtime/extension.sock')
    connection.sendall((json.dumps(request) + '\\n').encode())
    raw = b''
    while b'\\n' not in raw:
        raw += connection.recv(16384)
    print(json.dumps(json.loads(raw)))
"""
            result = subprocess.check_output(["docker", "exec", "--user", "1000:1000", self.tui.container,
                                              "/usr/bin/python3", "-I", "-c", script,
                                              json.dumps({"action": action, **extra})], text=True, timeout=5)
            return json.loads(result)
        children = Path(f"/proc/{self.tui.pid}/task/{self.tui.pid}/children").read_text().split()
        child = children[0]
        environment = dict(item.split(b"=", 1) for item in Path(f"/proc/{child}/environ").read_bytes().split(b"\0") if b"=" in item)
        request = {"action": action, "token": environment[b"PI_RUNTIME_CHILD_TOKEN"].decode(), **extra}
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3); connection.connect(str(self.tui.runtime / "extension.sock"))
            connection.sendall((json.dumps(request) + "\n").encode())
            raw = b""
            while b"\n" not in raw: raw += connection.recv(16384)
            return json.loads(raw)

    def web_command(self, message, flags=None):
        script = """const {WebSocket}=await import('ws');
          const ws=new WebSocket(process.argv[1]);
          const timer=setTimeout(()=>process.exit(2),5000);
          ws.on('open',()=>ws.send(JSON.stringify({type:'req',id:'guard-probe',method:'prompt',params:{message:process.argv[2],...JSON.parse(process.argv[3])}})));
          ws.on('message',raw=>{const v=JSON.parse(raw);if(v.type==='res'&&v.id==='guard-probe'){clearTimeout(timer);ws.close();process.exitCode=v.ok?0:3;}});"""
        subprocess.run(["node", "--input-type=module", "-e", script, f"ws://127.0.0.1:{self.tui.env['PI_WEB_UI_PORT']}/ws", message, json.dumps(flags or {})], cwd=ROOT, check=True, timeout=8)

    def test_running_bash_is_ineligible_and_normal_quit_survives(self):
        os.write(self.tui.fd, b"!sleep 1; touch guard-bash-done\r")
        fixture.wait_for(lambda: self.tui.status()["busy"])
        self.assertFalse((self.tui.workspace / "guard-bash-done").exists())
        expected = {key: self.old[key] for key in ("runtime_id", "session_id", "leaf_id")}
        self.assertFalse(self.ipc("prepare", operation_id="a" * 32, expected=expected)["ok"])
        fixture.wait_for(lambda: (self.tui.workspace / "guard-bash-done").exists())
        self.assertTrue(self.tui.status()["busy"], "idle never clears uncertainty")
        os.write(self.tui.fd, b"/quit\r"); fixture.wait_for(self.tui.exited, 10)

    def test_prepare_blocks_builtin_and_extension_without_replay(self):
        expected = {key: self.old[key] for key in ("runtime_id", "session_id", "leaf_id")}
        self.assertTrue(self.ipc("prepare", operation_id="a" * 32, expected=expected)["ok"])
        before = self.tui.session.read_bytes()
        os.write(self.tui.fd, b"/name guard-forbidden\r/guard-touch\r")
        fixture.wait_for(lambda: self.ipc("snapshot")["result"]["busy"])
        self.assertEqual(self.tui.session.read_bytes(), before)
        self.assertFalse((self.tui.workspace / "guard-command.json").exists())
        self.assertTrue(self.ipc("cancel", operation_id="a" * 32)["ok"])
        time.sleep(.1)
        self.assertFalse((self.tui.workspace / "guard-command.json").exists())
        self.assertTrue(self.tui.status()["busy"])
        os.write(self.tui.fd, b"/quit\r"); fixture.wait_for(self.tui.exited, 10)

    def test_web_arbitrary_command_taints_before_dispatch_and_reload_preserves_it(self):
        self.web_command("/guard-touch", {"executePiCommand": True})
        marker = self.tui.workspace / "guard-command.json"
        fixture.wait_for(marker.exists)
        self.assertEqual(json.loads(marker.read_text()), {"safeAtDispatch": False})
        self.assertTrue(self.tui.status()["busy"])
        previous = self.tui.status()["runtime_id"]
        os.write(self.tui.fd, b"/reload\r")
        fixture.wait_for(lambda: self.tui.status() and self.tui.status()["runtime_id"] != previous)
        self.assertTrue(self.tui.status()["busy"])
        os.write(self.tui.fd, b"/quit\r"); fixture.wait_for(self.tui.exited, 10)

    def held_web_command(self, flags):
        self.web_command("/guard-hold", flags)
        marker = self.tui.workspace / "guard-held.json"
        fixture.wait_for(marker.exists)
        try:
            self.assertFalse((self.tui.workspace / "guard-finished").exists(), "command must outlive Web ACK")
            self.assertEqual(json.loads(marker.read_text()), {"safeAtDispatch": False})
            snapshot = self.tui.status()
            self.assertTrue(snapshot["idle"])
            self.assertFalse(snapshot["pending"])
            self.assertTrue(snapshot["busy"], "ACK must not restore restart eligibility")
            expected = {key: self.old[key] for key in ("runtime_id", "session_id", "leaf_id")}
            self.assertFalse(self.ipc("prepare", operation_id="a" * 32, expected=expected)["ok"])
        finally:
            (self.tui.workspace / "guard-release").touch()
        fixture.wait_for(lambda: (self.tui.workspace / "guard-finished").exists())
        self.assertTrue(self.tui.status()["busy"], "completion never resets uncertainty")
        os.write(self.tui.fd, b"/quit\r"); fixture.wait_for(self.tui.exited, 10)

    def test_unflagged_async_web_command_refuses_prepare_after_ack(self):
        self.held_web_command({})

    def test_false_flag_async_web_command_refuses_prepare_after_ack(self):
        self.held_web_command({"executePiCommand": False})

    def test_audited_web_name_preserves_eligibility(self):
        self.web_command("/name audited-web-name")
        snapshot = self.tui.status()
        self.assertFalse(snapshot["busy"])
        expected = {key: snapshot[key] for key in ("runtime_id", "session_id", "leaf_id")}
        self.assertTrue(self.ipc("prepare", operation_id="a" * 32, expected=expected)["ok"])
        self.assertTrue(self.ipc("cancel", operation_id="a" * 32)["ok"])
        os.write(self.tui.fd, b"/quit\r"); fixture.wait_for(self.tui.exited, 10)

if __name__ == "__main__": unittest.main(verbosity=2)

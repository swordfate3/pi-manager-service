#!/usr/bin/env python3
"""Own one interactive Pi child and perform at most one requested restart at a time."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import Any

MAX_MESSAGE = 16 * 1024
DEFAULT_RUNTIME_DIR = "/run/pi-runtime"
DEFAULT_STOP_TIMEOUT = 30.0
DEFAULT_START_TIMEOUT = 120.0
ID_RE = re.compile(r"^[0-9a-f]{32}$")
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")

SNAPSHOT_KEYS = {
    "run_id", "runtime_id", "session_id", "leaf_id", "session_file", "cwd",
    "version", "idle", "pending", "busy", "provider", "model", "thinking",
}
IDENTITY_KEYS = ("runtime_id", "session_id", "leaf_id")
RESTART_KEYS = {
    "action", "run_id", "runtime_id", "session_id", "leaf_id", "operation_id",
}
RESTORE_PROOF_KEYS = {'session_sha256', 'expected_hash', 'source_hash',
                      'target_tree_sha256', 'target_task', 'version', 'profile_hash'}

SAFE_BOOLEAN_FLAGS = {
    "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-mcp",
    "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes",
    "--no-context-files", "-nc", "--verbose", "--approve", "-a",
    "--no-approve", "-na", "--offline",
}
SAFE_VALUE_FLAGS = {
    "--api-key", "--system-prompt", "--append-system-prompt", "--session-dir",
    "--models", "--tools", "-t", "--exclude-tools", "-xt", "--extension",
    "-e", "--skill", "--prompt-template", "--theme", "--use-theme",
    "--tui-mode",
}
REPLACED_VALUE_FLAGS = {
    "--provider", "--model", "--thinking", "--session", "--session-id",
    "--fork", "--name", "-n",
}
REPLACED_BOOLEAN_FLAGS = {
    "--continue", "-c", "--resume", "-r",
}


class ProtocolError(Exception):
    """A generic, externally undisclosed protocol rejection."""


def image_module(name):
    """Load fixed sibling source, never a user import path or environment hook."""
    if name not in ('runtime_identity', 'runtime_session'):
        raise ProtocolError
    source = Path(__file__).resolve().with_name(name + '.py')
    spec = importlib.util.spec_from_file_location('pi_image_' + name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compact_json(value: Any) -> bytes:
    encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) + 1 > MAX_MESSAGE:
        raise ProtocolError
    return encoded + b"\n"


def content_digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read_message(connection: socket.socket) -> Any:
    data = bytearray()
    while b"\n" not in data:
        chunk = connection.recv(min(4096, MAX_MESSAGE + 1 - len(data)))
        if not chunk:
            raise ProtocolError
        data.extend(chunk)
        if len(data) > MAX_MESSAGE:
            raise ProtocolError
    line, remainder = bytes(data).split(b"\n", 1)
    if remainder or not line:
        raise ProtocolError
    try:
        return json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError from error


def bounded_text(value: Any, *, nullable: bool = False, limit: int = 4096) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ProtocolError
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ProtocolError
    return value


def validate_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SNAPSHOT_KEYS:
        raise ProtocolError
    snapshot = dict(value)
    if not isinstance(snapshot["run_id"], str) or not ID_RE.fullmatch(snapshot["run_id"]):
        raise ProtocolError
    for key in ("runtime_id", "session_id", "version", "provider", "model", "thinking"):
        snapshot[key] = bounded_text(snapshot[key])
    snapshot["leaf_id"] = bounded_text(snapshot["leaf_id"], nullable=True)
    snapshot["session_file"] = bounded_text(snapshot["session_file"], limit=8192)
    snapshot["cwd"] = bounded_text(snapshot["cwd"], limit=8192)
    for key in ("idle", "pending", "busy"):
        if not isinstance(snapshot[key], bool):
            raise ProtocolError
    return snapshot


def restart_prefix(original: list[str]) -> list[str]:
    """Return reviewed replay-safe options, rejecting every ambiguous shape."""
    result = [original[0]]
    index = 1
    while index < len(original):
        argument = original[index]
        if argument == "--":
            break
        if "=" in argument and argument.startswith("-"):
            raise ProtocolError
        if argument in REPLACED_VALUE_FLAGS:
            if index + 1 >= len(original):
                raise ProtocolError
            index += 2
            continue
        if argument in REPLACED_BOOLEAN_FLAGS:
            index += 1
            continue
        if argument in SAFE_BOOLEAN_FLAGS:
            result.append(argument)
            index += 1
            continue
        if argument in SAFE_VALUE_FLAGS:
            if index + 1 >= len(original):
                raise ProtocolError
            result.extend((argument, original[index + 1]))
            index += 2
            continue
        if argument.startswith("-"):
            raise ProtocolError
        # Discard positional messages and @file inputs, but keep scanning the
        # pre-delimiter region for later reviewed options or unknown shapes.
        index += 1
    return result


def restart_argv(original: list[str], snapshot: dict[str, Any]) -> list[str]:
    """Build a successor argv from reviewed options without arity guessing."""
    result = restart_prefix(original)
    result.extend((
        "--provider", snapshot["provider"],
        "--model", snapshot["model"],
        "--thinking", snapshot["thinking"],
        "--session", snapshot["session_file"],
    ))
    return result


class PiSupervisor:
    def __init__(self, child_argv: list[str], stop_timeout: float, start_timeout: float):
        run_id = os.environ.get("PI_RUNTIME_RUN_ID", "")
        if not ID_RE.fullmatch(run_id):
            raise ProtocolError
        if not child_argv:
            raise ProtocolError
        self.run_id = run_id
        self.terminal_profile = os.environ.get('PI_RUNTIME_PROFILE') == 'web-terminal-v1'
        self.runtime_dir = Path(os.environ.get("PI_RUNTIME_DIR", DEFAULT_RUNTIME_DIR))
        self.control_socket = self.runtime_dir / "control.sock"
        self.extension_socket = self.runtime_dir / "extension.sock"
        self.original_argv = list(child_argv)
        self.initial_cwd = os.getcwd()
        self.stop_timeout = stop_timeout
        self.start_timeout = start_timeout
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.shutdown_signal: int | None = None
        self.shutdown_child: subprocess.Popen[Any] | None = None
        self.spawning = False
        self.server: socket.socket | None = None
        self.server_thread: threading.Thread | None = None
        self.child: subprocess.Popen[Any] | None = None
        self.child_token = ""
        self.source_identity: dict[str, Any] | None = None
        self.last_snapshot: dict[str, Any] | None = None
        self.operation: dict[str, Any] | None = None
        self.operation_request: dict[str, Any] | None = None
        self.operation_worker_started = False
        self.restart_active = False
        self.checking_deadline: float | None = None
        self.restore_capture = None
        self.restore_timer: threading.Timer | None = None

    def prepare_runtime(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.runtime_dir, 0o700)
        self.control_socket.unlink(missing_ok=True)
        self.extension_socket.unlink(missing_ok=True)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(self.control_socket))
        os.chmod(self.control_socket, 0o600)
        server.listen(8)
        server.settimeout(0.1)
        self.server = server
        self.server_thread = threading.Thread(target=self.serve, name="pi-control", daemon=True)
        self.server_thread.start()

    def guarded_node_options(self) -> str:
        # Only audited inert V8 resource options may accompany the fixed preload.
        # In particular -r runs before --import, so inherited preloads/loaders
        # cannot merely be appended after this guard.
        try:
            options = shlex.split(os.environ.get("NODE_OPTIONS", ""))
        except ValueError as error:
            raise ProtocolError from error
        if any(not re.fullmatch(r"--(?:max-old-space-size|max-semi-space-size)=\d+", option) for option in options):
            raise ProtocolError
        guard = Path(__file__).resolve().with_name("pi_stdin_guard.mjs")
        if not guard.is_file():
            raise ProtocolError
        return f'--import="{guard}"' + (" " + " ".join(options) if options else "")

    def child_environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment["NODE_OPTIONS"] = self.guarded_node_options()
        token = secrets.token_hex(32)
        if not TOKEN_RE.fullmatch(token):
            raise ProtocolError
        environment.update(
            PI_RUNTIME_RUN_ID=self.run_id,
            PI_RUNTIME_CHILD_TOKEN=token,
            PI_RUNTIME_EXTENSION_SOCKET=str(self.extension_socket),
            PI_RUNTIME_CONTROL_SOCKET=str(self.control_socket),
        )
        self.child_token = token
        return environment

    def spawn(self, argv: list[str], cwd: str, *, selection: dict[str, Any] | None = None) -> subprocess.Popen[Any]:
        with self.lock:
            self.require_running()
            self.spawning = True
        try:
            self.extension_socket.unlink(missing_ok=True)
            # Pin the measured path for this launch, rather than measuring one
            # release and then executing a mutable shared bin/pi symlink.
            try:
                measurement = image_module('runtime_identity')
                identity = measurement.measure_package(argv[0])
                if selection is not None:
                    target = Path(selection['target'])
                    if (identity != selection['identity'] or argv[0] != identity['executable'] or
                            target.resolve(strict=True) != target or
                            measurement.tree_digest(target) != selection['tree_sha256']):
                        raise ProtocolError
            except (OSError, ValueError):
                if selection is not None:
                    raise ProtocolError from None
                identity = None  # Legacy/unknown source remains unrefreshable.
            # Pin the image Node too. The private offline copies deliberately
            # live on a noexec tmpfs; Pi is JavaScript, not a native executable.
            selected = ['/usr/local/bin/node', identity['executable'], *argv[1:]] if identity else argv
            environment = self.child_environment()
            self.require_running()
            # Do not hold the shutdown lock across Popen. A signal can latch
            # immediately; publication then delivers it to the new child too.
            child = subprocess.Popen(selected, cwd=cwd, env=environment, close_fds=True)
            with self.lock:
                self.child = child
                self.source_identity = identity
                self.forward_shutdown_locked()
            return child
        finally:
            with self.lock:
                self.spawning = False

    def require_running(self) -> None:
        if self.stop_event.is_set():
            raise ProtocolError

    def restart_cancelled(self) -> bool:
        if not self.stop_event.is_set():
            return False
        self.finish_operation("failed", "shutdown")
        return True

    def forward_shutdown_locked(self) -> None:
        """Caller holds lock; each published child gets the latched graceful signal."""
        child = self.child
        if self.shutdown_signal is not None and child is not None and child is not self.shutdown_child:
            if child.poll() is None:
                self.shutdown_child = child
                try:
                    child.send_signal(self.shutdown_signal)
                except OSError:
                    pass

    def extension_request(self, request: dict[str, Any], timeout: float = 1.0) -> dict[str, Any]:
        payload = dict(request)
        with self.lock:
            payload["token"] = self.child_token
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(self.extension_socket))
            client.sendall(compact_json(payload))
            reply = read_message(client)
        if not isinstance(reply, dict) or set(reply) not in ({"ok", "result"}, {"ok", "error"}):
            raise ProtocolError
        if reply.get("ok") is not True:
            raise ProtocolError
        snapshot = validate_snapshot(reply.get("result"))
        if snapshot["run_id"] != self.run_id:
            raise ProtocolError
        with self.lock:
            self.last_snapshot = snapshot
        return snapshot

    def snapshot(self) -> dict[str, Any]:
        return self.extension_request({"action": "snapshot"})

    def safe_snapshot(self) -> dict[str, Any] | None:
        try:
            return self.snapshot()
        except (OSError, ProtocolError, TimeoutError):
            with self.lock:
                return copy.deepcopy(self.last_snapshot)

    @staticmethod
    def public_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
        return {
            "managed": True,
            "run_id": snapshot["run_id"],
            "runtime_id": snapshot["runtime_id"],
            "session_id": snapshot["session_id"],
            "leaf_id": snapshot["leaf_id"],
            "version": snapshot["version"],
            "idle": snapshot["idle"],
            "pending": snapshot["pending"],
            "busy": snapshot["busy"],
        }

    def status(self) -> dict[str, Any]:
        with self.lock:
            operation = copy.deepcopy(self.operation)
            snapshot = (
                copy.deepcopy(self.last_snapshot)
                if operation is not None and operation["status"] == "running"
                else None
            )
        if snapshot is None:
            snapshot = self.safe_snapshot()
        if snapshot is None:
            raise ProtocolError
        result = self.public_snapshot(snapshot)
        with self.lock:
            if self.source_identity is not None and self.source_identity['version'] == snapshot['version']:
                result['source_identity'] = copy.deepcopy(self.source_identity)
        try:
            result['installed_version'] = self.installed_version()
        except (OSError, ValueError, ProtocolError):
            pass  # Unknown display metadata is not inferred from process version.
        if operation is not None:
            result["operation"] = operation
        return result

    def installed_version(self) -> str:
        # Display/precondition metadata only. Do not execute an unvalidated
        # shared entrypoint with the live consumer's model credentials.
        executable = self.original_argv[0]
        if not os.path.isabs(executable):
            executable = shutil.which(executable)
            if executable is None:
                raise ProtocolError
        entry = Path(executable)
        resolved = entry.resolve(strict=True)
        for directory in list(resolved.parents)[:8]:
            manifest = directory / 'package.json'
            if not manifest.is_file():
                continue
            if manifest.stat().st_size > 1024 * 1024:
                raise ProtocolError
            value = json.loads(manifest.read_text())
            if not isinstance(value, dict):
                raise ProtocolError
            version = value.get('version')
            if (value.get('name') != '@earendil-works/pi-coding-agent' or
                    not isinstance(version, str) or len(version) > 64 or
                    not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version)
                    or entry.resolve(strict=True) != resolved):
                raise ProtocolError
            return version
        raise ProtocolError

    def validate_restart_request(self, request: Any) -> str:
        if self.terminal_profile:
            raise ProtocolError('terminal_profile_unaudited')
        if not isinstance(request, dict) or set(request) not in (RESTART_KEYS, RESTART_KEYS | {'restore_proof'}):
            raise ProtocolError
        if request.get("action") != "restart":
            raise ProtocolError
        if request.get("run_id") != self.run_id:
            raise ProtocolError
        operation_id = request.get("operation_id")
        if not isinstance(operation_id, str) or not ID_RE.fullmatch(operation_id):
            raise ProtocolError
        for key in ("runtime_id", "session_id"):
            bounded_text(request.get(key))
        bounded_text(request.get("leaf_id"), nullable=True)
        if 'restore_proof' in request:
            proof = request['restore_proof']
            if (not isinstance(proof, dict) or set(proof) != RESTORE_PROOF_KEYS or
                    not ID_RE.fullmatch(str(proof['target_task'])) or
                    any(not isinstance(proof[k], str) or not re.fullmatch('[0-9a-f]{64}', proof[k])
                        for k in ('session_sha256', 'expected_hash', 'source_hash',
                                  'target_tree_sha256', 'profile_hash')) or
                    not isinstance(proof['version'], str) or not re.fullmatch(
                        r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', proof['version'])):
                raise ProtocolError
        return operation_id

    def prepare_restore(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request) != RESTART_KEYS or request.get('action') != 'prepare_restore':
            raise ProtocolError
        self.validate_restart_request({**request, 'action': 'restart'})
        with self.lock:
            if self.restart_active:
                raise ProtocolError
            snapshot = self.snapshot()
            if (any(snapshot[key] != request[key] for key in IDENTITY_KEYS) or
                    not snapshot['idle'] or snapshot['pending'] or snapshot['busy']):
                raise ProtocolError
            if self.restore_capture is not None:
                if self.restore_capture.operation_id != request['operation_id']:
                    raise ProtocolError
                try:
                    self.restore_capture.verify(snapshot)
                except ValueError:
                    raise ProtocolError from None
                return self.restore_capture.descriptor()
            expected = {key: snapshot[key] for key in IDENTITY_KEYS}
            lease_started = time.monotonic()
            prepared = self.extension_request({'action': 'prepare', 'operation_id': request['operation_id'],
                                               'expected': expected})
            if prepared != snapshot:
                self.cancel(request['operation_id'])
                raise ProtocolError
            capture = None
            try:
                sessions = image_module('runtime_session')
                capture = sessions.SessionCapture(self.runtime_dir, prepared, request['operation_id'])
                # The extension lease began before the reply/capture reads.
                # Neither slow capture creation nor retries may extend it.
                capture.deadline = min(capture.deadline, lease_started + sessions.LEASE_SECONDS)
                capture.fence(prepared)
                remaining = capture.deadline - time.monotonic()
                if remaining <= 0:
                    raise ProtocolError
            except (OSError, ValueError):
                if capture is not None:
                    capture.close()
                self.cancel(request['operation_id'])
                raise ProtocolError from None
            except ProtocolError:
                if capture is not None:
                    capture.close()
                self.cancel(request['operation_id'])
                raise
            self.restore_capture = capture
            operation_id = request['operation_id']
            def expire():
                with self.lock:
                    if self.restore_capture is not None and self.restore_capture.operation_id == operation_id:
                        self.cancel_restore(operation_id)
            self.restore_timer = threading.Timer(remaining, expire)
            self.restore_timer.daemon = True
            self.restore_timer.start()
            return self.restore_capture.descriptor()

    def cancel_restore(self, operation_id: str) -> None:
        with self.lock:
            if self.restore_capture is None:
                return
            if self.restore_capture.operation_id != operation_id:
                raise ProtocolError
            if self.restore_timer is not None:
                self.restore_timer.cancel()
                self.restore_timer = None
            self.restore_capture.close()
            self.restore_capture = None
            self.cancel(operation_id)

    def verify_restore_proof(self, request: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any] | None:
        proof = request.get('restore_proof')
        if proof is None:
            # Equal version labels are not measured compatibility evidence.
            # All live restarts require the private Gate restore handshake.
            raise ProtocolError
        self.validate_restart_request(request)
        capture = self.restore_capture
        if capture is None or capture.operation_id != request['operation_id'] or self.source_identity is None:
            raise ProtocolError
        try:
            capture.verify(snapshot)
            identity = image_module('runtime_identity')
            if (proof['session_sha256'] != capture.sha256 or
                    proof['expected_hash'] != content_digest(capture.snapshot) or
                    proof['source_hash'] != content_digest(self.source_identity) or
                    identity.measure_package(self.source_identity['executable']) != self.source_identity):
                raise ProtocolError
            target = Path('/home/node/.local/.pi-releases') / proof['target_task']
            selected = identity.measure_package(self.original_argv[0])
            if (target.resolve(strict=True) != target or
                    not Path(selected['executable']).is_relative_to(target) or
                    selected['version'] != proof['version'] or
                    identity.tree_digest(target) != proof['target_tree_sha256']):
                raise ProtocolError
            capture.fence(snapshot)
            return {'identity': copy.deepcopy(selected), 'target': str(target),
                    'tree_sha256': proof['target_tree_sha256']}
        except (OSError, ValueError):
            raise ProtocolError from None

    def check_restart(self, request: dict[str, Any]) -> tuple[dict[str, Any], str, list[str], dict[str, Any] | None]:
        if self.terminal_profile:
            raise ProtocolError('terminal_profile_unaudited')
        # Refuse unknown, ambiguous, or equals-form argv before preparing or
        # sending any signal to the current child.
        restart_prefix(self.original_argv)
        self.require_running()
        snapshot = self.snapshot()
        self.require_running()
        expected = {key: request[key] for key in IDENTITY_KEYS}
        actual = {key: snapshot[key] for key in IDENTITY_KEYS}
        if expected != actual:
            raise ProtocolError
        if not snapshot["idle"] or snapshot["pending"] or snapshot["busy"]:
            raise ProtocolError
        selection = self.verify_restore_proof(request, snapshot)
        session_file = Path(snapshot["session_file"])
        cwd = Path(snapshot["cwd"])
        if not session_file.is_file() or not session_file.is_absolute():
            raise ProtocolError
        if not cwd.is_dir() or not cwd.is_absolute():
            raise ProtocolError
        expected_version = selection['identity']['version'] if selection is not None else self.installed_version()
        self.require_running()
        try:
            if selection is not None:
                capture = self.restore_capture
                if capture is None or capture.operation_id != request['operation_id']:
                    raise ProtocolError
                capture.fence(snapshot)
            prepared = self.extension_request({
                "action": "prepare",
                "operation_id": request["operation_id"],
                "expected": expected,
            })
            self.require_running()
            if any(prepared[key] != snapshot[key] for key in SNAPSHOT_KEYS):
                raise ProtocolError
        except (OSError, ProtocolError, TimeoutError, ValueError):
            if not self.stop_event.is_set():
                self.cancel(request["operation_id"])
            raise ProtocolError from None
        argv = restart_argv(self.original_argv, prepared)
        if selection is not None:
            argv[0] = selection['identity']['executable']
        return prepared, expected_version, argv, selection

    def cancel(self, operation_id: str) -> None:
        try:
            self.extension_request({"action": "cancel", "operation_id": operation_id})
        except (OSError, ProtocolError, TimeoutError):
            pass

    def accept_restart(self, request: Any) -> tuple[dict[str, Any], bool]:
        requested_operation_id = self.validate_restart_request(request)
        with self.lock:
            self.require_running()
            current_operation = copy.deepcopy(self.operation)
            if current_operation is not None:
                if current_operation["operation_id"] == requested_operation_id:
                    repeated_identity = {
                        "runtime_id": request["runtime_id"],
                        "session_id": request["session_id"],
                        "leaf_id": request["leaf_id"],
                    }
                    original_identity = {
                        "runtime_id": current_operation["old_runtime_id"],
                        "session_id": current_operation["session_id"],
                        "leaf_id": current_operation["leaf_id"],
                    }
                    if repeated_identity != original_identity:
                        raise ProtocolError
                    return ({
                        "operation_id": current_operation["operation_id"],
                        "status": current_operation["status"],
                        "stage": current_operation["stage"],
                    }, False)
                if current_operation["status"] == "running":
                    raise ProtocolError
            operation_id = request["operation_id"]
            operation = {
                "operation_id": operation_id,
                "status": "running",
                "stage": "checking",
                "old_runtime_id": request["runtime_id"],
                "session_id": request["session_id"],
                "leaf_id": request["leaf_id"],
            }
            self.operation = operation
            self.operation_request = copy.deepcopy(request)
            self.operation_worker_started = False
            self.restart_active = True
            self.checking_deadline = time.monotonic() + 15.0
            if request.get('restore_proof') is not None and self.restore_capture is not None:
                self.checking_deadline = min(self.checking_deadline, self.restore_capture.deadline)
        return ({"operation_id": operation_id, "status": "running", "stage": "checking"}, True)

    def start_reserved_restart(self, operation_id: str) -> None:
        with self.lock:
            if (
                self.stop_event.is_set()
                or self.operation is None
                or self.operation["operation_id"] != operation_id
                or self.operation["status"] != "running"
                or self.operation_worker_started
                or self.operation_request is None
            ):
                return
            request = copy.deepcopy(self.operation_request)
            self.operation_worker_started = True
        thread = threading.Thread(
            target=self.perform_restart,
            args=(request,),
            name="pi-restart",
            daemon=True,
        )
        thread.start()

    def fail_unacknowledged_restart(self, operation_id: str) -> None:
        with self.lock:
            if (
                self.operation is not None
                and self.operation["operation_id"] == operation_id
                and not self.operation_worker_started
            ):
                self.operation.update(status="failed", stage="acknowledgement_failed")
                self.restart_active = False

    def set_operation(self, **changes: Any) -> None:
        with self.lock:
            if self.operation is not None and not self.stop_event.is_set():
                self.operation.update(changes)

    def finish_operation(self, status: str, stage: str, **changes: Any) -> None:
        with self.lock:
            if self.stop_event.is_set():
                status, stage = "failed", "shutdown"
            if self.operation is not None:
                self.operation.update(status=status, stage=stage, **changes)
            self.restart_active = False
            if self.restore_capture is not None:
                self.cancel_restore(self.restore_capture.operation_id)

    def perform_restart(self, request: dict[str, Any]) -> None:
        if self.restart_cancelled():
            return
        operation_id = request["operation_id"]
        checking_deadline = self.checking_deadline
        if checking_deadline is None:
            checking_deadline = time.monotonic() + 15.0
        if time.monotonic() >= checking_deadline:
            self.finish_operation("failed", "checking_timeout")
            return
        try:
            prepared, expected_version, argv, selection = self.check_restart(request)
        except (OSError, ProtocolError, TimeoutError, subprocess.SubprocessError):
            self.finish_operation("failed", "checking_rejected")
            return

        if self.restart_cancelled():
            return
        if time.monotonic() >= checking_deadline:
            self.cancel(operation_id)
            self.finish_operation("failed", "checking_timeout")
            return

        self.set_operation(
            stage="prepared",
            old_version=prepared["version"],
            expected_version=expected_version,
        )
        with self.lock:
            if self.restart_cancelled():
                return
            child = self.child
        if child is None or child.poll() is not None:
            self.cancel(operation_id)
            self.finish_operation("failed", "child_unavailable")
            return
        self.set_operation(stage="stopping")
        try:
            with self.lock:
                # Complete all history/source/target hashing BEFORE the last
                # live observation. Input taints synchronously during hashing,
                # even when the barrier drops delivery to the parser.
                if selection is not None:
                    if self.verify_restore_proof(request, prepared) != selection:
                        raise ProtocolError
                fresh = self.snapshot()
                if fresh != prepared:
                    raise ProtocolError
                if selection is not None:
                    capture = self.restore_capture
                    if capture is None or capture.operation_id != operation_id:
                        raise ProtocolError
                    capture.fence(fresh)
                # Only short metadata/clock checks follow the live snapshot.
                # The checking window never extends the original freeze lease.
                if time.monotonic() >= checking_deadline:
                    self.cancel(operation_id)
                    self.finish_operation("failed", "checking_timeout")
                    return
                if self.restart_cancelled():
                    return
                child.send_signal(signal.SIGTERM)
            child.wait(timeout=self.stop_timeout)
        except subprocess.TimeoutExpired:
            if not self.stop_event.is_set():
                self.cancel(operation_id)
            self.finish_operation("recovery_required", "stopping_timeout")
            return
        except (OSError, ProtocolError, ValueError):
            self.finish_operation("failed", "stopping_failed")
            return

        if self.restart_cancelled():
            return
        self.set_operation(stage="starting")
        spawn_deadline = time.monotonic() + 10.0
        try:
            if self.restart_cancelled():
                return
            self.sync_models_bounded(max(0.001, spawn_deadline - time.monotonic()))
            if self.restart_cancelled():
                return
            if time.monotonic() >= spawn_deadline:
                raise TimeoutError
            new_child = self.spawn(argv, prepared["cwd"], selection=selection)
            if self.restart_cancelled():
                return
            if time.monotonic() >= spawn_deadline:
                self.finish_operation("recovery_required", "starting_overhead_timeout")
                return
        except (TimeoutError, subprocess.TimeoutExpired):
            self.finish_operation("recovery_required", "starting_overhead_timeout")
            return
        except (OSError, ProtocolError, subprocess.SubprocessError):
            self.finish_operation("failed", "starting_failed")
            return

        self.set_operation(stage="verifying")
        deadline = time.monotonic() + self.start_timeout
        last_new_snapshot: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if self.restart_cancelled():
                return
            if new_child.poll() is not None:
                self.finish_operation("failed", "starting_failed")
                return
            try:
                candidate = self.snapshot()
            except (OSError, ProtocolError, TimeoutError):
                self.stop_event.wait(0.03)
                continue
            if self.restart_cancelled():
                return
            last_new_snapshot = candidate
            if time.monotonic() >= deadline:
                break
            changes = {
                "new_runtime_id": candidate["runtime_id"],
                "new_version": candidate["version"],
            }
            self.set_operation(**changes)
            matches = (
                candidate["runtime_id"] != prepared["runtime_id"]
                and candidate["session_id"] == prepared["session_id"]
                and candidate["leaf_id"] == prepared["leaf_id"]
                and candidate["session_file"] == prepared["session_file"]
                and candidate["cwd"] == prepared["cwd"]
                and candidate["version"] == expected_version
                and all(candidate[key] == prepared[key] for key in ('provider', 'model', 'thinking'))
            )
            if matches:
                self.finish_operation("succeeded", "complete", **changes)
            else:
                self.finish_operation("failed", "readiness_mismatch", **changes)
            return
        changes = {}
        if last_new_snapshot is not None:
            changes = {
                "new_runtime_id": last_new_snapshot["runtime_id"],
                "new_version": last_new_snapshot["version"],
            }
        self.finish_operation("failed", "readiness_timeout", **changes)

    def sync_models_bounded(self, timeout: float) -> None:
        # This disposable helper may time out; the Pi child is never force-killed.
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().with_name("pi_model_sync.py"))],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=timeout, check=False,
        )
        if result.returncode != 0:
            raise ProtocolError

    def handle_request(self, request: Any) -> tuple[dict[str, Any], bool, str | None]:
        if not isinstance(request, dict):
            raise ProtocolError
        if request == {"action": "status"}:
            return self.status(), False, None
        if request.get('action') == 'prepare_restore':
            return self.prepare_restore(request), False, None
        if (set(request) == {'action', 'run_id', 'operation_id'} and request.get('action') == 'cancel_restore'
                and request.get('run_id') == self.run_id and ID_RE.fullmatch(str(request.get('operation_id')))):
            self.cancel_restore(request['operation_id'])
            return {'cancelled': True}, False, None
        if request.get("action") == "restart":
            result, dispatch = self.accept_restart(request)
            return result, dispatch, result["operation_id"] if dispatch else None
        raise ProtocolError

    def serve(self) -> None:
        assert self.server is not None
        while not self.stop_event.is_set():
            try:
                connection, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                connection.settimeout(2)
                dispatch = False
                operation_id: str | None = None
                try:
                    request = read_message(connection)
                    result, dispatch, operation_id = self.handle_request(request)
                    reply = {"ok": True, "result": result}
                    encoded = compact_json(reply)
                except (OSError, ProtocolError, TimeoutError, subprocess.SubprocessError):
                    reply = {"ok": False, "error": "request rejected"}
                    encoded = compact_json(reply)
                try:
                    connection.sendall(encoded)
                except OSError:
                    if dispatch and operation_id is not None:
                        self.fail_unacknowledged_restart(operation_id)
                    continue
                if dispatch and operation_id is not None:
                    self.start_reserved_restart(operation_id)

    def forward_signal(self, signum: int, _frame: Any) -> None:
        with self.lock:
            self.shutdown_signal = self.shutdown_signal or signum
            self.stop_event.set()
            if self.operation is not None and self.operation["status"] == "running":
                self.finish_operation("failed", "shutdown")
            self.forward_shutdown_locked()

    @staticmethod
    def keep_supervisor_on_interrupt(_signum: int, _frame: Any) -> None:
        # The foreground terminal already delivers SIGINT to the Pi child.
        # Keeping the parent alive preserves its private control socket.
        return

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self.forward_signal)
        signal.signal(signal.SIGHUP, self.forward_signal)
        signal.signal(signal.SIGINT, self.keep_supervisor_on_interrupt)
        try:
            self.prepare_runtime()
            try:
                self.spawn(self.original_argv, self.initial_cwd)
            except ProtocolError:
                if self.stop_event.is_set():
                    return 0
                raise
            while True:
                with self.lock:
                    child = self.child
                    restart_active = self.restart_active
                    spawning = self.spawning
                    stopping = self.stop_event.is_set()
                if child is None:
                    return 1
                return_code = child.poll()
                if return_code is not None and not spawning and (stopping or not restart_active):
                    return return_code
                time.sleep(0.03)
        finally:
            self.stop_event.set()
            if self.restore_capture is not None:
                self.cancel_restore(self.restore_capture.operation_id)
            if self.server is not None:
                self.server.close()
            if self.server_thread is not None:
                self.server_thread.join(timeout=1)
            self.control_socket.unlink(missing_ok=True)


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stop-timeout", type=float, default=DEFAULT_STOP_TIMEOUT)
    parser.add_argument("--start-timeout", type=float, default=DEFAULT_START_TIMEOUT)
    parser.add_argument("child", nargs=argparse.REMAINDER)
    arguments = parser.parse_args(argv)
    if arguments.child[:1] == ["--"]:
        arguments.child = arguments.child[1:]
    if arguments.stop_timeout <= 0 or arguments.start_timeout <= 0 or not arguments.child:
        raise ProtocolError
    return arguments


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
        supervisor = PiSupervisor(arguments.child, arguments.stop_timeout, arguments.start_timeout)
        return supervisor.run()
    except (OSError, ProtocolError, ValueError):
        print("pi-supervisor: startup rejected", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

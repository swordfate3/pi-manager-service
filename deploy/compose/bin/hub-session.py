#!/usr/bin/env python3
"""Issue and revoke one private Pi Web Hub capability for a launcher."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys


HUB_CONTAINER = "pi-stack-hub"
HUB_CLI = "/opt/pi-manager/dist/hub/pi-web-hub.mjs"
RUN_ID = re.compile(r"[0-9a-f]{32}")
TOKEN = re.compile(r"[0-9a-f]{64}")


def stack_root() -> Path:
    configured = os.environ.get("PI_STACK_ROOT")
    candidate = Path(configured) if configured else Path(__file__).resolve().parents[2]
    if not candidate.is_absolute() or candidate.resolve() != candidate:
        raise ValueError("PI_STACK_ROOT is not canonical")
    return candidate


ROOT = stack_root()
CHAT_CONFIG = ROOT / "data/hub/chat.json"
RUNTIME = ROOT / "data/hub/chat-runtime"
LAUNCHES = ROOT / "data/hub/launches"


def private_directory(directory: Path, *, create: bool = False) -> None:
    if create:
        directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    info = directory.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ValueError("Unsafe private directory")


def read_private(file: Path) -> bytes:
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
            or info.st_size > 8192
        ):
            raise ValueError("Unsafe private file")
        raw = stream.read(8193)
    if len(raw) > 8192:
        raise ValueError("Oversized private file")
    return raw


def write_private(file: Path, value: object) -> None:
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.write("\n")


def cli(command: str, *arguments: str) -> dict:
    common = [HUB_CLI, command, "--config", str(CHAT_CONFIG), *arguments]
    if os.environ.get("PI_STACK_IN_HUB") == "1":
        argv = ["node", *common]
    else:
        argv = ["docker", "exec", "--user", "1000:1000", HUB_CONTAINER, "node", *common]
    completed = subprocess.run(argv, capture_output=True, check=True, timeout=20)
    if len(completed.stdout) > 8192:
        raise ValueError("Oversized Hub response")
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise ValueError("Invalid Hub response")
    return value


def check_workspace(workspace: str) -> Path:
    project = Path(workspace)
    if not project.is_absolute() or project.resolve() != project:
        raise ValueError("Workspace must be canonical")
    if project == ROOT or project.is_relative_to(ROOT) or ROOT.is_relative_to(project):
        raise ValueError("Workspace overlaps Pi stack")
    return project


def validate_run_id(value: object) -> str:
    if not isinstance(value, str) or RUN_ID.fullmatch(value) is None:
        raise ValueError("Invalid run ID")
    return value


def erase_run(directory: Path) -> None:
    for name in ("credential.json", "launch.json"):
        (directory / name).unlink(missing_ok=True)
    directory.rmdir()


def find_run(run_id: str) -> Path | None:
    private_directory(LAUNCHES)
    for directory in LAUNCHES.iterdir():
        if RUN_ID.fullmatch(directory.name) is None:
            continue
        try:
            private_directory(directory)
            launch = json.loads(read_private(directory / "launch.json"))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(launch, dict) and launch.get("run_id") == run_id:
            return directory
    return None


def open_run(workspace: str, pid: int) -> dict:
    project = check_workspace(workspace)
    if pid <= 0:
        raise ValueError("Invalid launcher PID")
    private_directory(LAUNCHES)
    private_directory(RUNTIME)
    if not CHAT_CONFIG.is_file() or CHAT_CONFIG.is_symlink():
        raise ValueError("Missing Hub config")

    directory = LAUNCHES / f"stage-{secrets.token_hex(16)}"
    private_directory(directory, create=True)
    credential = directory / "credential.json"
    issued_credential = credential
    run_id: str | None = None
    try:
        label = re.sub(r"[\x00-\x1f\x7f]", "_", project.name)[:85] or "workspace"
        issued = cli("issue", "--output", str(credential), "--label", label)
        run_id = validate_run_id(issued.get("runId"))
        final_directory = LAUNCHES / run_id
        directory.rename(final_directory)
        directory = final_directory
        credential = directory / "credential.json"
        # Record the public identity immediately. If a later credential check
        # fails while revoke is unavailable, an administrator can still retry.
        write_private(
            directory / "launch.json",
            {"run_id": run_id, "workspace": str(project), "pid": pid},
        )
        expected_socket = str(RUNTIME / "registry.sock")
        if issued.get("credentialFile") != str(issued_credential) or issued.get("socketPath") != expected_socket:
            raise ValueError("Incompatible Hub configuration")
        capability = json.loads(read_private(credential))
        if (
            not isinstance(capability, dict)
            or capability.get("run_id") != run_id
            or not isinstance(capability.get("token"), str)
            or TOKEN.fullmatch(capability["token"]) is None
        ):
            raise ValueError("Invalid credential")
        return {"run_id": run_id, "credential_file": str(credential)}
    except Exception:
        revoked = False
        if run_id is not None:
            try:
                revoked = cli("revoke", "--run-id", run_id).get("revoked") is True
            except Exception:
                revoked = False
        if run_id is None or revoked:
            credential.unlink(missing_ok=True)
            (directory / "launch.json").unlink(missing_ok=True)
            directory.rmdir()
        raise


def close_run(run_id: str) -> None:
    run_id = validate_run_id(run_id)
    directory = find_run(run_id)
    reply = cli("revoke", "--run-id", run_id)
    if reply.get("revoked") is not True:
        raise ValueError("Revocation failed")
    if directory is not None:
        erase_run(directory)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    opening = commands.add_parser("open")
    opening.add_argument("--workspace", required=True)
    opening.add_argument("--pid", required=True, type=int)
    checking = commands.add_parser("check-workspace")
    checking.add_argument("--workspace", required=True)
    closing = commands.add_parser("close")
    closing.add_argument("run_id")
    args = parser.parse_args()
    try:
        if args.command == "open":
            result = open_run(args.workspace, args.pid)
        elif args.command == "check-workspace":
            check_workspace(args.workspace)
            result = {"safe_workspace": True}
        else:
            close_run(args.run_id)
            result = {"closed": True}
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception:
        print("hub-session: operation failed; check stack paths, Hub health, and private permissions", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

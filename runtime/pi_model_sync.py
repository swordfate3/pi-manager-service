#!/usr/bin/env python3
"""Synchronize the fixed CC Switch and persistent Pi model configuration."""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import sys


def warning(message: str) -> None:
    print(f"pi-entrypoint: warning: {message}", file=sys.stderr)


def valid_json(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8") as stream:
            json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return True


def atomic_copy(source: Path, target: Path) -> None:
    data = source.read_bytes()
    temporary = target.with_name(
        f"{target.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
    )
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def sync_models_config() -> None:
    models_dir = os.environ.get("PI_CC_SWITCH_MODELS_DIR", "")
    if not models_dir:
        return

    home = os.environ.get("HOME", "/home/node")
    pi_agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", f"{home}/.pi/agent"))
    external_models = Path(models_dir) / "models.json"
    pi_models = pi_agent_dir / "models.json"

    try:
        pi_agent_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        warning("could not prepare Pi model configuration directory")
        return

    if external_models.is_file():
        if not valid_json(external_models):
            warning("ignoring invalid CC Switch models.json")
            return
        try:
            atomic_copy(external_models, pi_models)
        except OSError:
            warning("could not copy CC Switch models.json")
        return

    if not pi_models.is_file():
        return
    if not valid_json(pi_models):
        warning("existing Pi models.json is invalid; leaving it unchanged")
        return
    try:
        atomic_copy(pi_models, external_models)
    except OSError:
        warning("could not initialize CC Switch models.json")


def main() -> int:
    sync_models_config()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

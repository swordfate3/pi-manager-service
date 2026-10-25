#!/usr/bin/env python3
"""Classify whether a Pi argv is eligible for the managed interactive TUI."""

from __future__ import annotations

import sys


DIRECT_COMMANDS = {
    "install", "remove", "uninstall", "update", "list", "config", "auth",
    "mcp", "help",
}
DIRECT_FLAGS = {
    "--help", "-h", "--version", "-v", "--print", "-p", "--export",
    "--list-models", "--no-session", "--no-extensions", "-ne",
}
VALUE_FLAGS = {
    "--provider", "--model", "--api-key", "--system-prompt",
    "--append-system-prompt", "--name", "-n", "--session-dir", "--models",
    "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension",
    "-e", "--skill", "--prompt-template", "--theme", "--use-theme",
    "--tui-mode", "--session", "--session-id", "--fork",
}


def managed_eligible(argv: list[str]) -> bool:
    """Return true only for argv that represents a normal interactive launch."""
    if argv[:1] and argv[0] in DIRECT_COMMANDS:
        return False

    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--":
            break
        if argument in DIRECT_FLAGS:
            return False
        if argument == "--mode" or argument.startswith("--mode="):
            return False
        if argument in VALUE_FLAGS:
            index += 2
            continue
        index += 1
    return True


def main(argv: list[str] | None = None) -> int:
    return 0 if managed_eligible(sys.argv[1:] if argv is None else argv) else 1


if __name__ == "__main__":
    raise SystemExit(main())

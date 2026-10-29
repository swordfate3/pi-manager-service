#!/usr/bin/env bash

# Source this after PI_STACK_ROOT is canonical and before Docker is invoked.
# The host UUID is durable stack state; an existing value is never regenerated.
pi_scoped_memory_host_identity() {
    local state_file host_id host_root generated temporary

    [[ -n "${PI_STACK_ROOT:-}" && "$PI_STACK_ROOT" == /* ]] || {
        printf 'host-identity: PI_STACK_ROOT must be an absolute canonical path\n' >&2
        return 1
    }
    host_root="$(pwd -P)" || return 1
    state_file="$PI_STACK_ROOT/data/memory/host-id"
    mkdir -p -m 700 -- "${state_file%/*}" || return 1

    if [[ ! -e "$state_file" && ! -L "$state_file" ]]; then
        generated="$(< /proc/sys/kernel/random/uuid)" || return 1
        temporary="$(mktemp "${state_file%/*}/.host-id.XXXXXXXX")" || return 1
        chmod 600 -- "$temporary" || { rm -f -- "$temporary"; return 1; }
        if ! printf '%s\n' "$generated" > "$temporary"; then
            rm -f -- "$temporary"
            return 1
        fi
        # Do not replace another concurrent launcher's winner.
        ln -T -- "$temporary" "$state_file" 2>/dev/null || :
        rm -f -- "$temporary" || return 1
    fi

    [[ -f "$state_file" && ! -L "$state_file" && -O "$state_file" ]] || {
        printf 'host-identity: invalid memory host ID file\n' >&2
        return 1
    }
    IFS= read -r host_id < "$state_file" || return 1
    [[ "$host_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || {
        printf 'host-identity: invalid memory host ID\n' >&2
        return 1
    }

    export PI_SCOPED_MEMORY_WORKSPACE_ID="host:$host_id:$host_root"
    export PI_SCOPED_MEMORY_WORKSPACE_ROOT=/workspace
}

pi_scoped_memory_host_identity

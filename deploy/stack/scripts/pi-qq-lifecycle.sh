#!/usr/bin/env bash

# Shared QQ screenshot lifecycle for pi-pirun instances.
# This file is sourced by the launcher and intentionally performs no work at
# source time. The caller supplies the PI_QQ_* variables before entering.

PI_QQ_SOURCE_DIR="${PI_QQ_SOURCE_DIR:-}"
PI_QQ_ATTACHMENTS_DIR="${PI_QQ_ATTACHMENTS_DIR:-}"
PI_QQ_BRIDGE="${PI_QQ_BRIDGE:-}"
PI_QQ_WORKSPACE_CANONICAL="${PI_QQ_WORKSPACE_CANONICAL:-${PWD:-}}"
PI_QQ_BOOT_ID_FILE="${PI_QQ_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
PI_QQ_BOOT_ID="${PI_QQ_BOOT_ID:-}"
PI_QQ_CLEANUP_ATTACHMENTS="${PI_QQ_CLEANUP_ATTACHMENTS:-0}"

if [[ -z "$PI_QQ_BOOT_ID" && -r "$PI_QQ_BOOT_ID_FILE" ]]; then
    PI_QQ_BOOT_ID="$(< "$PI_QQ_BOOT_ID_FILE")"
fi

if [[ -z "${PI_QQ_LIFECYCLE_KEY:-}" ]]; then
    PI_QQ_LIFECYCLE_KEY="$(printf '%s\n%s\n' "$PI_QQ_WORKSPACE_CANONICAL" "$PI_QQ_ATTACHMENTS_DIR" | sha256sum | cut -c1-16)"
fi

# Existing terminal launches keep their exact locks during migration. Compose
# exposes only these owned legacy paths, never all of host /tmp. New launches
# use one stack-owned directory shared with the administrative workbench.
PI_QQ_RUNTIME_DIR="${PI_QQ_RUNTIME_DIR:-/tmp}"
if [[ -d "/tmp/pi-qq-bridge-$PI_QQ_LIFECYCLE_KEY.lifecycle" ]]; then
    PI_QQ_RUNTIME_DIR=/tmp
fi
mkdir -p -- "$PI_QQ_RUNTIME_DIR"
PI_QQ_LOCK_FILE="${PI_QQ_LOCK_FILE:-$PI_QQ_RUNTIME_DIR/pi-qq-bridge-$PI_QQ_LIFECYCLE_KEY.lock}"
PI_QQ_LOG_FILE="${PI_QQ_LOG_FILE:-$PI_QQ_RUNTIME_DIR/pi-qq-bridge-$PI_QQ_LIFECYCLE_KEY.log}"
PI_QQ_LIFECYCLE_DIR="${PI_QQ_LIFECYCLE_DIR:-$PI_QQ_RUNTIME_DIR/pi-qq-bridge-$PI_QQ_LIFECYCLE_KEY.lifecycle}"
PI_QQ_LIFECYCLE_LOCK="${PI_QQ_LIFECYCLE_LOCK:-$PI_QQ_LIFECYCLE_DIR/lifecycle.lock}"
PI_QQ_BRIDGE_OWNER_FILE="${PI_QQ_BRIDGE_OWNER_FILE:-$PI_QQ_LIFECYCLE_DIR/bridge.owner}"

PI_QQ_SESSION_FILE="${PI_QQ_SESSION_FILE:-}"
PI_QQ_SESSION_TEMP_FILE="${PI_QQ_SESSION_TEMP_FILE:-}"
PI_QQ_LIFECYCLE_FD="${PI_QQ_LIFECYCLE_FD:-}"
PI_QQ_LIFECYCLE_LOCK_HELD="${PI_QQ_LIFECYCLE_LOCK_HELD:-0}"
PI_QQ_BRIDGE_PID="${PI_QQ_BRIDGE_PID:-}"
PI_QQ_BRIDGE_START_TIME="${PI_QQ_BRIDGE_START_TIME:-}"
PI_QQ_BRIDGE_BOOT_ID="${PI_QQ_BRIDGE_BOOT_ID:-}"

process_start_time() {
    local process_pid="$1"

    [[ "$process_pid" =~ ^[0-9]+$ ]] || return 1
    [[ -r "/proc/$process_pid/stat" ]] || return 1
    awk '{sub(/^.*\) /, ""); print $20}' "/proc/$process_pid/stat" 2>/dev/null
}

process_state() {
    local process_pid="$1"

    [[ "$process_pid" =~ ^[0-9]+$ ]] || return 1
    [[ -r "/proc/$process_pid/stat" ]] || return 1
    awk '{sub(/^.*\) /, ""); print $1}' "/proc/$process_pid/stat" 2>/dev/null
}

process_identity_matches() {
    local process_pid="$1"
    local process_start="$2"
    local expected_boot="$3"
    local actual_start actual_boot state

    [[ "$process_pid" =~ ^[0-9]+$ ]] || return 1
    [[ "$process_start" =~ ^[0-9]+$ ]] || return 1
    [[ -n "$expected_boot" ]] || return 1

    actual_start="$(process_start_time "$process_pid")" || return 1
    [[ "$actual_start" == "$process_start" ]] || return 1

    if [[ "$expected_boot" != "-" ]]; then
        [[ -r "$PI_QQ_BOOT_ID_FILE" ]] || return 1
        actual_boot="$(< "$PI_QQ_BOOT_ID_FILE")" || return 1
        [[ "$actual_boot" == "$expected_boot" ]] || return 1
    fi

    state="$(process_state "$process_pid")" || return 1
    [[ "$state" != "Z" && "$state" != "X" ]]
}

process_identity_matches_file() {
    local identity_file="$1"
    local process_pid process_start expected_boot

    [[ -f "$identity_file" ]] || return 1
    IFS=$'\t' read -r process_pid process_start expected_boot < "$identity_file" || return 1
    process_identity_matches "$process_pid" "$process_start" "$expected_boot"
}

acquire_lifecycle_lock() {
    if (( PI_QQ_LIFECYCLE_LOCK_HELD )); then
        return 0
    fi

    mkdir -p -- "$PI_QQ_LIFECYCLE_DIR" || return 1
    if ! exec {PI_QQ_LIFECYCLE_FD}>"$PI_QQ_LIFECYCLE_LOCK"; then
        PI_QQ_LIFECYCLE_FD=""
        return 1
    fi
    if ! flock -x "$PI_QQ_LIFECYCLE_FD"; then
        exec {PI_QQ_LIFECYCLE_FD}>&-
        PI_QQ_LIFECYCLE_FD=""
        return 1
    fi
    PI_QQ_LIFECYCLE_LOCK_HELD=1
}

release_lifecycle_lock() {
    if (( ! PI_QQ_LIFECYCLE_LOCK_HELD )); then
        return 0
    fi

    flock -u "$PI_QQ_LIFECYCLE_FD" 2>/dev/null || true
    exec {PI_QQ_LIFECYCLE_FD}>&-
    PI_QQ_LIFECYCLE_FD=""
    PI_QQ_LIFECYCLE_LOCK_HELD=0
}

cleanup_stale_sessions() {
    local session_file
    local -a session_files=()

    [[ -d "$PI_QQ_LIFECYCLE_DIR" ]] || return 0

    shopt -s nullglob
    session_files=("$PI_QQ_LIFECYCLE_DIR"/session.*)
    shopt -u nullglob

    for session_file in "${session_files[@]}"; do
        [[ -f "$session_file" ]] || continue
        if ! process_identity_matches_file "$session_file"; then
            rm -f -- "$session_file" || true
        fi
    done
}

has_active_sessions() {
    local session_file
    local -a session_files=()

    [[ -d "$PI_QQ_LIFECYCLE_DIR" ]] || return 1
    shopt -s nullglob
    session_files=("$PI_QQ_LIFECYCLE_DIR"/session.*)
    shopt -u nullglob

    for session_file in "${session_files[@]}"; do
        [[ -f "$session_file" ]] && return 0
    done
    return 1
}

has_other_active_sessions() {
    local session_file
    local -a session_files=()

    [[ -d "$PI_QQ_LIFECYCLE_DIR" ]] || return 1
    shopt -s nullglob
    session_files=("$PI_QQ_LIFECYCLE_DIR"/session.*)
    shopt -u nullglob

    for session_file in "${session_files[@]}"; do
        if [[ -f "$session_file" && "$session_file" != "$PI_QQ_SESSION_FILE" ]]; then
            return 0
        fi
    done
    return 1
}

create_session_marker() {
    local start_time temporary_file marker_suffix

    mkdir -p -- "$PI_QQ_LIFECYCLE_DIR" || return 1
    start_time="$(process_start_time "$$")" || return 1
    [[ "$start_time" =~ ^[0-9]+$ ]] || return 1

    temporary_file="$(mktemp "$PI_QQ_LIFECYCLE_DIR/.session.XXXXXX")" || return 1
    PI_QQ_SESSION_TEMP_FILE="$temporary_file"
    marker_suffix="${temporary_file##*.session.}"
    PI_QQ_SESSION_FILE="$PI_QQ_LIFECYCLE_DIR/session.$marker_suffix"
    if ! printf '%s\t%s\t%s\n' "$$" "$start_time" "$PI_QQ_BOOT_ID" > "$temporary_file"; then
        rm -f -- "$temporary_file" "$PI_QQ_SESSION_FILE" || true
        PI_QQ_SESSION_TEMP_FILE=""
        PI_QQ_SESSION_FILE=""
        return 1
    fi
    chmod 600 -- "$temporary_file" 2>/dev/null || true
    if ! mv -f -- "$temporary_file" "$PI_QQ_SESSION_FILE"; then
        rm -f -- "$temporary_file" "$PI_QQ_SESSION_FILE" || true
        PI_QQ_SESSION_TEMP_FILE=""
        PI_QQ_SESSION_FILE=""
        return 1
    fi
    PI_QQ_SESSION_TEMP_FILE=""
}

remove_own_session_marker() {
    if [[ -n "$PI_QQ_SESSION_TEMP_FILE" ]]; then
        rm -f -- "$PI_QQ_SESSION_TEMP_FILE" || true
        PI_QQ_SESSION_TEMP_FILE=""
    fi
    if [[ -n "$PI_QQ_SESSION_FILE" ]]; then
        rm -f -- "$PI_QQ_SESSION_FILE" || true
        PI_QQ_SESSION_FILE=""
    fi
}

record_process_identity() {
    local process_pid="$1"
    local target_file="$2"
    local start_time=""
    local temporary_file
    local attempt

    for (( attempt = 0; attempt < 100; attempt++ )); do
        if start_time="$(process_start_time "$process_pid")" && [[ "$start_time" =~ ^[0-9]+$ ]]; then
            break
        fi
        sleep 0.01
    done
    [[ "$start_time" =~ ^[0-9]+$ ]] || return 1

    PI_QQ_BRIDGE_PID="$process_pid"
    PI_QQ_BRIDGE_START_TIME="$start_time"
    PI_QQ_BRIDGE_BOOT_ID="$PI_QQ_BOOT_ID"

    temporary_file="$(mktemp "$PI_QQ_LIFECYCLE_DIR/.bridge-owner.XXXXXX")" || return 1
    if ! printf '%s\t%s\t%s\n' "$process_pid" "$start_time" "$PI_QQ_BOOT_ID" > "$temporary_file"; then
        rm -f -- "$temporary_file" || true
        return 1
    fi
    chmod 600 -- "$temporary_file" 2>/dev/null || true
    mv -f -- "$temporary_file" "$target_file"
}

bridge_owner_is_alive() {
    process_identity_matches_file "$PI_QQ_BRIDGE_OWNER_FILE"
}

stop_shared_bridge() {
    local bridge_pid=""
    local bridge_start=""
    local bridge_boot=""
    local attempt

    if [[ -f "$PI_QQ_BRIDGE_OWNER_FILE" ]] && process_identity_matches_file "$PI_QQ_BRIDGE_OWNER_FILE"; then
        IFS=$'\t' read -r bridge_pid bridge_start bridge_boot < "$PI_QQ_BRIDGE_OWNER_FILE" || bridge_pid=""
    elif [[ "$PI_QQ_BRIDGE_PID" =~ ^[0-9]+$ ]] \
        && [[ "$PI_QQ_BRIDGE_START_TIME" =~ ^[0-9]+$ ]] \
        && process_identity_matches "$PI_QQ_BRIDGE_PID" "$PI_QQ_BRIDGE_START_TIME" "$PI_QQ_BRIDGE_BOOT_ID"; then
        bridge_pid="$PI_QQ_BRIDGE_PID"
        bridge_start="$PI_QQ_BRIDGE_START_TIME"
        bridge_boot="$PI_QQ_BRIDGE_BOOT_ID"
    fi

    if [[ "$bridge_pid" =~ ^[0-9]+$ ]] \
        && [[ "$bridge_start" =~ ^[0-9]+$ ]] \
        && process_identity_matches "$bridge_pid" "$bridge_start" "$bridge_boot"; then
        kill "$bridge_pid" 2>/dev/null || true
        for (( attempt = 0; attempt < 100; attempt++ )); do
            if ! process_identity_matches "$bridge_pid" "$bridge_start" "$bridge_boot"; then
                break
            fi
            sleep 0.01
        done
        if process_identity_matches "$bridge_pid" "$bridge_start" "$bridge_boot"; then
            kill -KILL "$bridge_pid" 2>/dev/null || true
        fi
        wait "$bridge_pid" 2>/dev/null || true
    fi

    rm -f -- "$PI_QQ_BRIDGE_OWNER_FILE" || true
    PI_QQ_BRIDGE_PID=""
    PI_QQ_BRIDGE_START_TIME=""
    PI_QQ_BRIDGE_BOOT_ID=""
}

start_shared_bridge() {
    local bridge_pid
    local bridge_path
    local bridge_path_env

    bridge_path="${PI_QQ_BRIDGE:-}"
    [[ -x "$bridge_path" ]] || return 0
    if bridge_owner_is_alive; then
        return 0
    fi
    rm -f -- "$PI_QQ_BRIDGE_OWNER_FILE" || true
    bridge_path_env="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

    nohup env -i \
        PATH="$bridge_path_env" \
        PI_QQ_SOURCE_DIR="$PI_QQ_SOURCE_DIR" \
        PI_QQ_ATTACHMENTS_DIR="$PI_QQ_ATTACHMENTS_DIR" \
        PI_QQ_LOCK_FILE="$PI_QQ_LOCK_FILE" \
        PI_QQ_WORKSPACE_KEY="${PI_QQ_WORKSPACE_KEY:-}" \
        "$bridge_path" \
        > "$PI_QQ_LOG_FILE" 2>&1 < /dev/null &
    bridge_pid=$!

    if ! record_process_identity "$bridge_pid" "$PI_QQ_BRIDGE_OWNER_FILE"; then
        if [[ "$PI_QQ_BRIDGE_START_TIME" =~ ^[0-9]+$ ]] \
            && process_identity_matches "$bridge_pid" "$PI_QQ_BRIDGE_START_TIME" "$PI_QQ_BRIDGE_BOOT_ID"; then
            kill "$bridge_pid" 2>/dev/null || true
        fi
        wait "$bridge_pid" 2>/dev/null || true
        rm -f -- "$PI_QQ_BRIDGE_OWNER_FILE" || true
    fi
    PI_QQ_BRIDGE_PID=""
    PI_QQ_BRIDGE_START_TIME=""
    PI_QQ_BRIDGE_BOOT_ID=""
}

remove_default_attachments() {
    if [[ "$PI_QQ_CLEANUP_ATTACHMENTS" == 1 ]] \
        && [[ -d "$PI_QQ_ATTACHMENTS_DIR" ]] \
        && [[ ! -L "$PI_QQ_ATTACHMENTS_DIR" ]]; then
        rm -rf -- "$PI_QQ_ATTACHMENTS_DIR" || true
    fi
}

pi_qq_lifecycle_enter() {
    if ! create_session_marker; then
        return 1
    fi

    if ! acquire_lifecycle_lock; then
        remove_own_session_marker
        return 1
    fi

    cleanup_stale_sessions
    if ! has_other_active_sessions; then
        stop_shared_bridge
        remove_default_attachments
    fi
    if ! mkdir -p -- "$PI_QQ_ATTACHMENTS_DIR"; then
        release_lifecycle_lock
        remove_own_session_marker
        return 1
    fi
    start_shared_bridge || true
    release_lifecycle_lock
}

pi_qq_lifecycle_leave() {
    local exit_status="${1:-$?}"
    local cleanup_lock_acquired=0

    if (( PI_QQ_LIFECYCLE_LOCK_HELD )); then
        cleanup_lock_acquired=1
    elif [[ -n "$PI_QQ_SESSION_FILE" || -n "$PI_QQ_SESSION_TEMP_FILE" ]] \
        && acquire_lifecycle_lock; then
        cleanup_lock_acquired=1
    fi

    if (( cleanup_lock_acquired )); then
        remove_own_session_marker
        cleanup_stale_sessions
        if ! has_active_sessions; then
            stop_shared_bridge
            remove_default_attachments
        fi
        release_lifecycle_lock
    else
        remove_own_session_marker
    fi

    return "$exit_status"
}

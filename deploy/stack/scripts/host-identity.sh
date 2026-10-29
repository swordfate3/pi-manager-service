#!/usr/bin/env bash
# SOURCE this on the Linux/WSL HOST before the launcher's docker run.
# No launcher parsing, Docker socket, credentials or project-local identity file.
# Add the two --env options documented below to that same docker run.
pi_scoped_memory_host_identity() {
  local state_file host_id host_root config_root
  host_root=$(pwd -P) || return
  config_root=$(cd -- "${PI_PIRUN_CONFIG_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P) || return
  # Keep identity beside the host deployment, not in the project or image.
  # A dedicated override isolates tests without changing XDG state for other apps.
  state_file="${PI_SCOPED_MEMORY_HOST_ID_FILE:-$config_root/state/pi-scoped-memory/host-id}"
  mkdir -p -m 700 -- "${state_file%/*}" || return
  if [[ ! -e "$state_file" ]]; then
    local generated temporary
    generated=$(cat /proc/sys/kernel/random/uuid) || return
    temporary=$(mktemp "${state_file%/*}/.host-id.XXXXXXXX") || return
    if ! printf '%s\n' "$generated" > "$temporary"; then
      unlink -- "$temporary"
      return 1
    fi
    # Publish a complete file without replacing another launcher's winner.
    ln -T -- "$temporary" "$state_file" 2>/dev/null || :
    unlink -- "$temporary" || return
  fi
  [[ -f "$state_file" && ! -L "$state_file" ]] || { printf 'Invalid memory host ID file\n' >&2; return 1; }
  IFS= read -r host_id < "$state_file" || return
  [[ "$host_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || { printf 'Invalid memory host ID\n' >&2; return 1; }
  export PI_SCOPED_MEMORY_WORKSPACE_ID="host:$host_id:$host_root"
  export PI_SCOPED_MEMORY_WORKSPACE_ROOT=/workspace
}
pi_scoped_memory_host_identity
# In the existing docker run, before IMAGE (not forwarded to pi):
# --env PI_SCOPED_MEMORY_WORKSPACE_ID --env PI_SCOPED_MEMORY_WORKSPACE_ROOT
# The source bound to /workspace MUST equal pwd -P from above.

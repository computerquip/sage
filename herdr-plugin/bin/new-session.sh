#!/usr/bin/env bash
# Herdr plugin action: "new-sandboxed-session".
#
# Creates a fresh git worktree (new branch) as its own herdr workspace, then
# launches the sage sandboxed pi agent inside it.
#
# Runtime env herdr injects (see https://herdr.dev/docs/plugins/):
#   HERDR_BIN_PATH        - path to the running herdr binary (use this, not
#                           bare `herdr`, for portability across platforms)
#   HERDR_PLUGIN_ROOT     - this plugin's directory (sage/herdr-plugin when
#                           linked locally via `herdr plugin link`)
#   HERDR_WORKSPACE_ID    - workspace the action was invoked from, if any
#   HERDR_PLUGIN_CONTEXT_JSON - full invocation context as JSON
set -euo pipefail

# sage/ repo root: default assumes this plugin lives at sage/herdr-plugin
# (true for local dev via `herdr plugin link ./herdr-plugin`). Override with
# SAGE_HOME if the plugin is installed/linked from elsewhere.
PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
export SAGE_HOME="${SAGE_HOME:-$(CDPATH= cd -- "$PLUGIN_ROOT/.." && pwd)}"

exec "$SAGE_HOME/bin/sage"

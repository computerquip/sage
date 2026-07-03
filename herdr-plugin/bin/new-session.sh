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

HERDR="${HERDR_BIN_PATH:-herdr}"

# sage/ repo root: default assumes this plugin lives at sage/herdr-plugin
# (true for local dev via `herdr plugin link ./herdr-plugin`). Override with
# SAGE_HOME if the plugin is installed/linked from elsewhere.
PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
SAGE_HOME="${SAGE_HOME:-$(CDPATH= cd -- "$PLUGIN_ROOT/.." && pwd)}"

BRANCH="sage/$(date +%Y%m%d-%H%M%S)"

echo "sage: creating worktree on branch $BRANCH" >&2

WS_JSON=$("$HERDR" worktree create --branch "$BRANCH" --no-focus --json)

# NOTE: the exact field name for the created workspace id has not been
# verified against a live herdr install (see plan doc, "CLI field names").
# Try the most likely candidates in order before giving up.
WS_ID=$(printf '%s' "$WS_JSON" | jq -r '.id // .workspace_id // .workspace.id // empty')

if [ -z "$WS_ID" ]; then
  echo "sage: could not extract workspace id from 'worktree create --json' output:" >&2
  echo "$WS_JSON" >&2
  echo "sage: inspect the JSON above and fix the jq filter in $0" >&2
  exit 1
fi

echo "sage: launching sandboxed pi agent in workspace $WS_ID" >&2

exec "$HERDR" agent start sage \
  --workspace "$WS_ID" \
  -- "$SAGE_HOME/bin/sage"

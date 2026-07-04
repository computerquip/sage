#!/usr/bin/env sh
# Install the user-facing `sage` command for this checkout.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
TARGET="$BIN_DIR/sage"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install: required command not found on PATH: $1" >&2
    missing=true
  fi
}

missing=false
need_cmd git
need_cmd jq
need_cmd curl
need_cmd tar
need_cmd herdr
need_cmd pi
need_cmd node
need_cmd pnpm

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "install: required command not found on PATH: sha256sum or shasum" >&2
  missing=true
fi

if [ "$missing" = true ]; then
  echo "install: install missing prerequisites, then rerun ./install.sh" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

chmod +x "$SCRIPT_DIR/bin/sage" "$SCRIPT_DIR/bin/sage-session" "$SCRIPT_DIR/image/build.sh" "$SCRIPT_DIR/image/package-release.sh"

if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  if [ "${SAGE_INSTALL_OVERWRITE:-}" = "1" ]; then
    BACKUP="$TARGET.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$TARGET" "$BACKUP"
    echo "install: moved existing $TARGET to $BACKUP"
  else
    echo "install: refusing to replace non-symlink $TARGET" >&2
    echo "install: rerun with SAGE_INSTALL_OVERWRITE=1 to move it aside" >&2
    exit 1
  fi
fi

ln -sfn "$SCRIPT_DIR/bin/sage-session" "$TARGET"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "install: installing Node dependencies with pnpm"
  (cd "$SCRIPT_DIR" && pnpm install)
fi

cat <<EOF
installed: $TARGET -> $SCRIPT_DIR/bin/sage-session

Next steps:
  1. Ensure $BIN_DIR is on PATH.
  2. Install the guest image:
       sage install-image
     Or build it locally:
       $SCRIPT_DIR/image/build.sh
  3. Start a session from a git repo:
       sage
  4. List live sessions:
       sage list
EOF

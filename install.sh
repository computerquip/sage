#!/usr/bin/env sh
# Install the user-facing `sage` command for this checkout.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
SAGE_TARGET="$BIN_DIR/sage"
SAGE_SESSION_TARGET="$BIN_DIR/sage-session"

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

chmod +x "$SCRIPT_DIR/bin/sage" "$SCRIPT_DIR/bin/sage-pi" "$SCRIPT_DIR/bin/sage-session" "$SCRIPT_DIR/image/build.sh" "$SCRIPT_DIR/image/package-release.sh"

install_link() {
  target="$1"
  source="$2"

  if [ -e "$target" ] && [ ! -L "$target" ]; then
    if [ "${SAGE_INSTALL_OVERWRITE:-}" = "1" ]; then
      BACKUP="$target.bak.$(date +%Y%m%d-%H%M%S)"
      mv "$target" "$BACKUP"
      echo "install: moved existing $target to $BACKUP"
    else
      echo "install: refusing to replace non-symlink $target" >&2
      echo "install: rerun with SAGE_INSTALL_OVERWRITE=1 to move it aside" >&2
      exit 1
    fi
  fi

  ln -sfn "$source" "$target"
}

install_link "$SAGE_TARGET" "$SCRIPT_DIR/bin/sage"

if [ -e "$SAGE_SESSION_TARGET" ] && [ ! -L "$SAGE_SESSION_TARGET" ]; then
  if [ "${SAGE_INSTALL_OVERWRITE:-}" = "1" ]; then
    BACKUP="$SAGE_SESSION_TARGET.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$SAGE_SESSION_TARGET" "$BACKUP"
    echo "install: moved existing $SAGE_SESSION_TARGET to $BACKUP"
    ln -sfn "$SAGE_TARGET" "$SAGE_SESSION_TARGET"
  else
    echo "install: leaving existing non-symlink $SAGE_SESSION_TARGET alone" >&2
  fi
else
  ln -sfn "$SAGE_TARGET" "$SAGE_SESSION_TARGET"
fi

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "install: installing Node dependencies with pnpm"
  (cd "$SCRIPT_DIR" && pnpm install)
fi

cat <<EOF
installed: $SAGE_TARGET -> $SCRIPT_DIR/bin/sage
compat:   $SAGE_SESSION_TARGET -> $SAGE_TARGET

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

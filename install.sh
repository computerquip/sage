#!/usr/bin/env sh
# Install the user-facing `sage` command for this checkout.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
SAGE_TARGET="$BIN_DIR/sage"

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

chmod +x "$SCRIPT_DIR/bin/sage" "$SCRIPT_DIR/image/build.sh" "$SCRIPT_DIR/image/package-release.sh"

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

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "install: installing Node dependencies with pnpm"
  (cd "$SCRIPT_DIR" && pnpm install)
fi

if [ "${SAGE_SKIP_PI_PACKAGE_INSTALL:-}" != "1" ]; then
  echo "install: installing Sage Pi packages"
  "$SCRIPT_DIR/bin/sage" install-pi-packages
else
  echo "install: skipping Sage Pi package install"
fi

cat <<EOF
installed: $SAGE_TARGET -> $SCRIPT_DIR/bin/sage

Next steps:
  1. Ensure $BIN_DIR is on PATH.
  2. Sage Pi packages were installed unless SAGE_SKIP_PI_PACKAGE_INSTALL=1 was set.
     Re-run package install with:
       sage install-pi-packages
  3. Install the guest image:
       sage install-image
     Or build it locally:
       $SCRIPT_DIR/image/build.sh
  4. Start a session from a git repo:
       sage
  5. List live sessions:
       sage list
EOF

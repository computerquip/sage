#!/usr/bin/env sh
# Builds the sage custom gondolin guest image (git/node/python/rust baked in).
#
# Usage:
#   ./image/build.sh [output-dir]
#
# Requires: gondolin CLI on PATH, plus host build tools (lz4, cpio,
# e2fsprogs). Docker/Podman are only needed for OCI/cross-arch builds.
#
# The "arch" field in build-config.json MUST match the host architecture
# (check with `uname -m`) or the resulting VM will not boot.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR="${1:-$REPO_ROOT/.gondolin-image}"

if ! command -v gondolin >/dev/null 2>&1; then
  echo "error: 'gondolin' CLI not found on PATH" >&2
  exit 1
fi

echo "Building sage guest image -> $OUTPUT_DIR"
gondolin build \
  --config "$SCRIPT_DIR/build-config.json" \
  --output "$OUTPUT_DIR"

echo "Done. Verify the toolchain with:"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- git --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- node --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- python3 --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- rustc --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- cargo --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec -- pnpm --version"

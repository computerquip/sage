#!/usr/bin/env sh
# Build the sage-fff helper in an Alpine container so the binary matches the
# guest userspace without requiring Cargo to run inside Gondolin's rootfs chroot.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${SAGE_FFF_BUILD_IMAGE:-alpine:3.23}
RUNTIME=${SAGE_CONTAINER_RUNTIME:-podman}

if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "error: container runtime '$RUNTIME' not found" >&2
  exit 1
fi

mkdir -p "$SCRIPT_DIR/dist"

"$RUNTIME" run --rm \
  -v "$SCRIPT_DIR:/src" \
  -w /src \
  "$IMAGE" \
  sh -lc '
    set -eu
    apk add --no-cache build-base cargo rust >/dev/null
    cargo build --release
    cp target/release/sage-fff dist/sage-fff
    chmod 0755 dist/sage-fff
  '

#!/usr/bin/env sh
# Package a built gondolin image for upload to a GitHub Release.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
if [ "$#" -gt 0 ]; then
  IMAGE_DIR="$1"
elif [ -n "${SAGE_IMAGE_DIR:-}" ]; then
  IMAGE_DIR="$SAGE_IMAGE_DIR"
elif [ -n "${SAGE_CACHE_DIR:-}" ]; then
  IMAGE_DIR="$SAGE_CACHE_DIR/gondolin-image"
elif [ -n "${XDG_CACHE_HOME:-}" ]; then
  IMAGE_DIR="$XDG_CACHE_HOME/sage/gondolin-image"
else
  IMAGE_DIR="$HOME/.cache/sage/gondolin-image"
fi
OUT_DIR="${2:-$REPO_ROOT/dist}"

case "$(uname -m)" in
  x86_64|amd64)
    ARCH=x86_64
    ;;
  aarch64|arm64)
    ARCH=aarch64
    ;;
  *)
    echo "package-release: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [ ! -f "$IMAGE_DIR/manifest.json" ] || [ ! -f "$IMAGE_DIR/rootfs.ext4" ]; then
  echo "package-release: $IMAGE_DIR does not look like a built gondolin image" >&2
  echo "package-release: run ./image/build.sh first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

ASSET="sage-gondolin-image-$ARCH.tar.gz"
OUT="$OUT_DIR/$ASSET"

echo "Packaging $IMAGE_DIR -> $OUT"
tar -C "$IMAGE_DIR" -czf "$OUT" .

(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$ASSET" > "$ASSET.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$ASSET" > "$ASSET.sha256"
  else
    echo "package-release: required command not found on PATH: sha256sum or shasum" >&2
    exit 127
  fi
)

echo "Created:"
echo "  $OUT"
echo "  $OUT.sha256"
echo
echo "Upload both files to a GitHub Release, then users can run:"
echo "  sage install-image"

#!/usr/bin/env sh
# Builds the sage custom gondolin guest image (git/node/python/rust/C++/QEMU tools baked in).
#
# Usage:
#   ./image/build.sh [output-dir]
#
# Requires: gondolin CLI on PATH and Podman for the containerized post-build
# step.
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

node --input-type=module - "$OUTPUT_DIR" <<'EOF'
import fs from "node:fs";
import path from "node:path";

const outputDir = process.argv[2];
const manifestPath = path.join(outputDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const keptAssets = new Set(["kernel", "initramfs", "rootfs"]);

for (const [key, relPath] of Object.entries(manifest.assets ?? {})) {
  if (!keptAssets.has(key) && typeof relPath === "string") {
    fs.rmSync(path.join(outputDir, relPath), { force: true });
  }
}

for (const key of Object.keys(manifest.assets ?? {})) {
  if (!keptAssets.has(key)) delete manifest.assets[key];
}

for (const key of Object.keys(manifest.checksums ?? {})) {
  if (!keptAssets.has(key)) delete manifest.checksums[key];
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
EOF

echo "Done. Verify the toolchain with:"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- git --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- node --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- pi --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- gondolin help"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- python3 --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- rustc --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- cargo --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- pnpm --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- cmake --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- ninja --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- clang --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- conan --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- qemu-system-x86_64 --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- qemu-img --version"
echo "  GONDOLIN_GUEST_DIR=$OUTPUT_DIR gondolin exec --vmm qemu -- jq --version"

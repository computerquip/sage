#!/bin/sh
set -eu

PLAYWRIGHT_VERSION=1.49.0
PATCHRIGHT_VERSION=1.49.0
CRAWL4AI_VERSION=0.9.0

link_driver_node() {
  package_name="$1"
  driver_dir="$(python3 - "$package_name" <<'PY'
import importlib
import pathlib
import sys

module = importlib.import_module(sys.argv[1])
print(pathlib.Path(module.__file__).parent / "driver")
PY
)"
  rm -f "$driver_dir/node"
  ln -s /usr/bin/node "$driver_dir/node"
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

pip install --break-system-packages \
  "git+https://github.com/microsoft/playwright-python.git@v${PLAYWRIGHT_VERSION}"
link_driver_node playwright

pip download \
  --no-deps \
  --dest "$tmp_dir" \
  --platform manylinux1_x86_64 \
  --python-version 312 \
  --implementation py \
  --abi none \
  --only-binary=:all: \
  "patchright==${PATCHRIGHT_VERSION}"
cp \
  "$tmp_dir/patchright-${PATCHRIGHT_VERSION}-py3-none-manylinux1_x86_64.whl" \
  "$tmp_dir/patchright-${PATCHRIGHT_VERSION}-py3-none-any.whl"
pip install --break-system-packages --no-deps \
  "$tmp_dir/patchright-${PATCHRIGHT_VERSION}-py3-none-any.whl"
link_driver_node patchright

pip install --break-system-packages "crawl4ai==${CRAWL4AI_VERSION}"

# sage

herdr manages sandboxed agent sessions; each session runs `pi` on the host
with read/write/edit/bash/`!` tool calls routed into a disposable
[gondolin](https://gondolin.dev) QEMU VM. Sage also provides `process_list`
and `process_signal` tools for structured VM process inspection, plus
VM-backed `file_search` and `content_search` tools for bounded local file
search, backed by a guest-installed `sage-fff` wrapper around FFF. Web access
is delegated to
[`pi-web-access`](https://github.com/nicobailon/pi-web-access), which registers
`web_search` for discovery/current information and `fetch_content` for exact
HTTP(S) page contents. `sage install-pi-packages` installs host-side Pi
packages so package skills load alongside extensions. Override package sources
with `SAGE_WEB_ACCESS_PACKAGE` or `SAGE_CONTEXT_MODE_PACKAGE`; set a package
variable empty to skip installing that package. Sage also uses
[`context-mode`](https://github.com/mksglu/context-mode) with
`npm:context-mode@1.0.169` for context memory and `ctx_*` tools. Because every
local filesystem and process action executes inside the sandbox, pi can be
run fully auto-approved.

See the design doc for the full rationale, architecture, and network model:
`~/.local/share/kilo/plans/sage-sandboxed-agent.md`.

## Status

Toolchain installed and the custom guest image builds and boots
successfully (x86_64, AlmaLinux host, QEMU/KVM backend). The image includes git,
SSH, jq, QEMU tooling,
Node/npm/pnpm, pi/gondolin CLIs, Python/pip/uv, Rust/cargo, GCC/G++,
Clang/LLVM/lld, CMake, Ninja, Conan, pkgconf, gdb, and autotools/libtool. A
live `pi` session routes filesystem/shell tool calls, structured file and
process inspection, and file/content search through the VM. Web discovery and
content extraction are provided by `pi-web-access`; context memory is provided
by `context-mode`.

Known open items (see plan doc "Risks / open questions" for more):

- `image/build-config.json` sets `"arch": "x86_64"` (matches this authoring
  machine). **Re-check `uname -m` on whatever machine actually runs
  `gondolin build`** — a mismatched arch means the VM won't boot.
- Sage uses Gondolin's QEMU backend with the `q35` machine type, KVM
  acceleration, host CPU model, 1 vCPU, and 1G RAM. Gondolin launches QEMU
  with `-nodefaults` and an explicit virtio device set, which keeps the VM
  close to a minimal VM on hosts whose QEMU packages do not provide the
  `microvm` machine type.
- gondolin's built-in rootfs init mounts a fresh `tmpfs` over `/root` (and
  `/tmp`, `/var/tmp`, `/var/cache`, `/var/log`) on every VM boot for a clean
  ephemeral home per session. Anything baked into `/root` during
  `image/build.sh` (e.g. a `rustup`-installed toolchain under
  `/root/.cargo`) is invisible at runtime. Install language toolchains via
  apk packages instead (see `rust`/`cargo` in `build-config.json`) or point
  `CARGO_HOME`/`RUSTUP_HOME` outside `/root`.
- `image/build.sh` uses Gondolin's Podman container build path so
  `postBuild.commands` can run without `sudo`. Rootless Podman must be usable
  on the host.
- `image/build.sh` first compiles `tools/sage-fff` in an Alpine container and
  copies the resulting binary into the guest image as `/usr/local/bin/sage-fff`.
- `context-mode` depends on `better-sqlite3`. If Pi/npm reports blocked install
  scripts for `context-mode` or `better-sqlite3`, its SQLite-backed memory may
  not work until those package scripts are approved or rebuilt in the Pi
  package cache.

## Prerequisites

- Host support for QEMU/KVM.
- Node.js ≥ 23.6.0.
- pnpm, git, jq, curl.
- [herdr](https://herdr.dev) (`curl -fsSL https://herdr.dev/install.sh | sh`)
  + `herdr integration install pi`.
- [pi](https://github.com/earendil-works) installed and on `PATH`.
- Image builds: rootless Podman usable by the current user. The build runs
  inside a container because `postBuild.commands` need chroot-like privileges.
- A running **ssh-agent** with `SSH_AUTH_SOCK` set and your git key loaded,
  plus the target git host(s) in `~/.ssh/known_hosts` (for SSH-git egress).
  Without this, HTTP(S) tool calls still work but SSH git remotes won't.

## Layout

```
sage/
├─ packages/pi-sage-sandbox/   # pi extension: routes tools into gondolin
│  ├─ index.ts                 # extension entry point
│  └─ src/
│     ├─ paths.ts               # toGuestPath / shQuote
│     ├─ gondolin-ops.ts        # read/write/edit/bash op adapters
│     ├─ file-search.ts         # VM-backed path/tree search
│     ├─ content-search.ts      # VM-backed content search
│     └─ config.ts              # image dir + network policy resolution
├─ tools/sage-fff/              # Rust FFF JSON CLI installed in the guest image
├─ image/
│  ├─ build-config.json        # gondolin custom image build config
│  └─ build.sh                 # wrapper around `gondolin build`
├─ herdr-plugin/
│  ├─ herdr-plugin.toml        # manifest: "new-session" action
│  └─ bin/new-session.sh       # worktree create + launch sandboxed pi
└─ bin/sage                    # user-facing session manager and internal agent launcher
```

## Setup

1. Install the `sage` command:

   ```sh
   ./install.sh
   ```

   This links `~/.local/bin/sage` to `bin/sage` in this checkout and installs
   Node dependencies if `node_modules` is absent. It also installs Sage's Pi
   packages into Pi settings so package extensions and skills are both loaded.
   Set `SAGE_SKIP_PI_PACKAGE_INSTALL=1` to skip that part. Ensure
   `~/.local/bin` is on `PATH`.

   To install or refresh only the Pi packages:

   ```sh
   sage install-pi-packages
   ```

2. Install workspace deps manually if you skipped `install.sh`:

   ```sh
   pnpm install
   ```

3. Install the prebuilt guest image from GitHub Releases:

   ```sh
   sage install-image
   ```

   By default this downloads:

   ```text
   https://github.com/computerquip/sage/releases/latest/download/sage-gondolin-image-<arch>.tar.gz
   https://github.com/computerquip/sage/releases/latest/download/sage-gondolin-image-<arch>.tar.gz.sha256
   ```

   Override with `SAGE_RELEASE_REPO`, `SAGE_IMAGE_VERSION`,
   `SAGE_IMAGE_URL`, or `SAGE_IMAGE_SHA256_URL`.

4. Or build the custom guest image locally (first compiles `sage-fff`, then
   bakes in git/node/python/rust/C++, pi/gondolin, jq, QEMU tooling, and the
   search helper):

   ```sh
   ./image/build.sh
   ```

   Verify the image boots through Sage's QEMU options:

   ```sh
   ./bin/sage --no-attach
   ```

   Raw `gondolin exec --vmm qemu` uses Gondolin's default QEMU machine type,
   which may not boot on hosts where Sage's `q35` override is required.

5. Try it in any git repo:

   ```sh
   cd /path/to/some/project
   sage
   ```

   This creates a Herdr worktree on a `sage/<timestamp>` branch, starts a
   sandboxed pi agent inside that worktree, boots a gondolin VM, mounts the
   worktree read-write at `/workspace`, and routes pi tools into the VM.

6. List, attach, resume, or remove Sage sessions:

   ```sh
   sage list          # live + stopped Sage worktrees for this repo
   sage history       # alias for sage list
   sage attach        # attach newest; starts it first if stopped
   sage attach 2      # attach/resume by list index
   sage resume 2      # alias for sage attach 2
   sage --no-attach   # create/start and print attach command
   sage remove 2      # remove a Sage worktree by list index
   sage remove        # remove the newest Sage worktree
   ```

7. Bring work back from a Sage worktree:

   ```sh
   sage status        # status + diffstat for the newest Sage worktree
   sage diff          # full diff of newest Sage worktree against current branch
   sage diff --stat 2 # diffstat for the worktree at sage list index 2
   sage merge 2       # commit pending Sage edits, then merge branch into cwd
   sage merge --remove 2 # merge, then remove the Sage worktree
   sage push 2        # commit pending Sage edits, then push its branch to origin
   ```

   `sage merge` refuses to run if the current checkout has uncommitted
   changes, so local work is not mixed with agent output by accident. Set
   `SAGE_BASE_REF` when `sage diff` should compare against something other
   than the current branch.

8. Wire up the herdr plugin for local dev:

   ```sh
   herdr plugin link ./herdr-plugin
   herdr plugin action list --plugin sage.sandbox
   herdr plugin action invoke sage.sandbox.new-session
   ```

   This creates a new git worktree on a `sage/<timestamp>` branch as its own
   herdr workspace, then starts a sandboxed pi agent inside it (visible in the
   herdr sidebar via `herdr integration install pi`).

## Network egress model

gondolin does not give the guest a real network stack — the host mediates
every outbound connection. Sage's policy:

| Traffic | Policy |
| --- | --- |
| HTTP/HTTPS search/fetch | wide open (`SAGE_HTTP_ALLOWED_HOSTS`, defaults to `*`) |
| SSH-git | allowlist only (`SAGE_SSH_HOSTS`, defaults to `github.com`), authenticated via host ssh-agent — keys never enter the guest |
| Raw TCP | off by default; add case-by-case later if a task needs it |

Env vars (all optional):

- `SAGE_IMAGE_DIR` — path to the built gondolin image (default:
  `${XDG_CACHE_HOME:-~/.cache}/sage/gondolin-image`; repo-local
  `.gondolin-image` is still used as a fallback for local development).
- `SAGE_IMAGE_INSTALL_DIR` — where `sage install-image` writes the downloaded
  image (default: `${XDG_CACHE_HOME:-~/.cache}/sage/gondolin-image`).
- `SAGE_CACHE_DIR` — Sage cache directory used to derive the default image
  path (default: `${XDG_CACHE_HOME:-~/.cache}/sage`).
- `SAGE_RELEASE_REPO` — GitHub repo containing image release assets (default:
  `computerquip/sage`).
- `SAGE_IMAGE_VERSION` — GitHub release tag to download (default: `latest`).
- `SAGE_IMAGE_URL` / `SAGE_IMAGE_SHA256_URL` — explicit download URL
  overrides.
- `SAGE_CONTEXT_MODE_PACKAGE` — Pi package source for context memory (default
  `npm:context-mode@1.0.169`; empty skips `sage install-pi-packages`).
- `SAGE_WEB_ACCESS_PACKAGE` — Pi package source for web tools (default
  `npm:pi-web-access@0.13.0`; empty skips `sage install-pi-packages`).
- `SAGE_HTTP_ALLOWED_HOSTS` — comma-separated HTTP/HTTPS allowlist (default
  `*`).
- `SAGE_SSH_HOSTS` — comma-separated SSH-git allowlist (default
  `github.com`).
- `SAGE_HOME` — repo root, auto-detected from script location if unset.
- `SAGE_AGENT_NAME` — Herdr agent name override (default:
  `sage-<timestamp>`).
- `SAGE_QEMU_MACHINE_TYPE` — QEMU machine-type override (default `q35`; use
  `microvm` on hosts that support it).
- `SAGE_QEMU_ACCEL` — QEMU accelerator override (default `kvm`).
- `SAGE_QEMU_CPU` — QEMU CPU model override (default `host`).
- `SAGE_QEMU_APPEND` — kernel cmdline override (default:
  `console=ttyS0 panic=1 reboot=k pci=lastbus=0`).
- `SAGE_VM_CPUS` — VM vCPU count (default `1`).
- `SAGE_VM_MEMORY` — Gondolin VM memory size (default `1G`).

## Tearing down a session

```sh
herdr worktree remove --workspace <workspace_id> [--force]
```

This runs `git worktree remove` on the checkout; it never deletes the branch.

## Merging work back

The worktree is a normal git branch checkout — merge it like any other
branch (`git merge sage/<timestamp>`, or open a PR) once the sandboxed agent
is done.

## Publishing an image release

Build and package the image:

```sh
./image/build.sh
./image/package-release.sh
```

`image/build.sh` writes to Sage's default image cache unless you pass an
explicit output directory. `image/package-release.sh` packages that same image
by default.

This creates:

```text
dist/sage-gondolin-image-<arch>.tar.gz
dist/sage-gondolin-image-<arch>.tar.gz.sha256
```

Upload both files to a GitHub Release. `sage install-image` downloads the
matching architecture asset and verifies the SHA256 file before replacing the
local image directory.

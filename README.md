# sage

herdr manages sandboxed agent sessions; each session runs `pi` on the host
with every tool call (read/write/edit/bash/`!`) routed into a disposable
[gondolin](https://gondolin.dev) micro-VM. Because every dangerous action
executes inside the sandbox, pi can be run fully auto-approved.

See the design doc for the full rationale, architecture, and network model:
`~/.local/share/kilo/plans/sage-sandboxed-agent.md`.

## Status

Toolchain installed and the custom guest image builds and boots
successfully (x86_64, AlmaLinux host, nested KVM acceleration via
`--vmm qemu`). Verified inside the guest: `git`, `node`, `python3`, `rustc`,
`cargo`, `pnpm` all resolve and run. A live `pi` session with tool calls
routed into the VM was previously verified against the Kilo pi provider
(see git history); it has not yet been re-run on this host (no provider
auth configured here).

Known open items (see plan doc "Risks / open questions" for more):

- `herdr-plugin/bin/new-session.sh` guesses the JSON field name returned by
  `herdr worktree create --json` (tries `.id`, `.workspace_id`,
  `.workspace.id`). Run it once against your installed herdr and fix the `jq`
  filter if none of those match.
- `image/build-config.json` sets `"arch": "x86_64"` (matches this authoring
  machine). **Re-check `uname -m` on whatever machine actually runs
  `gondolin build`** — a mismatched arch means the VM won't boot.
- RHEL/AlmaLinux's `qemu-kvm` package ships no `microvm` machine type (only
  `pc`/`q35`), so `gondolin`'s default machine-type selection breaks on
  these hosts even with KVM available — set
  `SAGE_QEMU_MACHINE_TYPE=q35`.
- gondolin's built-in rootfs init mounts a fresh `tmpfs` over `/root` (and
  `/tmp`, `/var/tmp`, `/var/cache`, `/var/log`) on every VM boot for a clean
  ephemeral home per session. Anything baked into `/root` during
  `image/build.sh` (e.g. a `rustup`-installed toolchain under
  `/root/.cargo`) is invisible at runtime. Install language toolchains via
  apk packages instead (see `rust`/`cargo` in `build-config.json`) or point
  `CARGO_HOME`/`RUSTUP_HOME` outside `/root`.
- `image/build.sh` requires either root privileges (to chroot for
  `postBuild.commands`) or a container runtime (`container.force: true` +
  `container.runtime: "podman"` in the config) — run it via `sudo` or set
  those fields, since gondolin only auto-detects `docker`/`podman` and
  otherwise expects root.

## Prerequisites

- QEMU (via your package manager).
- Node.js ≥ 23.6.0.
- pnpm, git, jq, curl.
- [herdr](https://herdr.dev) (`curl -fsSL https://herdr.dev/install.sh | sh`)
  + `herdr integration install pi`.
- [pi](https://github.com/earendil-works) installed and on `PATH`.
- Image build tools: `lz4`, `cpio`, `e2fsprogs` (Docker/Podman only needed for
  OCI/cross-arch builds).
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
│     └─ config.ts              # image dir + network policy resolution
├─ image/
│  ├─ build-config.json        # gondolin custom image build config
│  └─ build.sh                 # wrapper around `gondolin build`
├─ herdr-plugin/
│  ├─ herdr-plugin.toml        # manifest: "new-session" action
│  └─ bin/new-session.sh       # worktree create + launch sandboxed pi
└─ bin/sage                    # thin launcher (standalone or via plugin)
```

## Setup

1. Install the `sage` command:

   ```sh
   ./install.sh
   ```

   This links `~/.local/bin/sage` to `bin/sage-session` in this checkout and
   installs Node dependencies if `node_modules` is absent. Ensure
   `~/.local/bin` is on `PATH`.

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

4. Or build the custom guest image locally (bakes in git/node/python/rust):

   ```sh
   ./image/build.sh
   ```

   Verify the toolchain resolves inside the guest:

   ```sh
   GONDOLIN_GUEST_DIR=.gondolin-image gondolin exec -- git --version
   GONDOLIN_GUEST_DIR=.gondolin-image gondolin exec -- node --version
   GONDOLIN_GUEST_DIR=.gondolin-image gondolin exec -- rustc --version
   GONDOLIN_GUEST_DIR=.gondolin-image gondolin exec -- cargo --version
   ```

5. Try it in any git repo:

   ```sh
   cd /path/to/some/project
   sage
   ```

   This creates a Herdr worktree on a `sage/<timestamp>` branch, starts a
   sandboxed pi agent inside that worktree, boots a gondolin VM, mounts the
   worktree read-write at `/workspace`, and routes pi tools into the VM.

6. List live Sage sessions:

   ```sh
   sage list
   herdr agent attach <name-or-target>
   ```

7. Wire up the herdr plugin for local dev:

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
| HTTP/HTTPS | wide open (`SAGE_HTTP_ALLOWED_HOSTS`, defaults to `*`) |
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
- `SAGE_HTTP_ALLOWED_HOSTS` — comma-separated HTTP/HTTPS allowlist (default
  `*`).
- `SAGE_SSH_HOSTS` — comma-separated SSH-git allowlist (default
  `github.com`).
- `SAGE_HOME` — repo root, auto-detected from script location if unset.
- `SAGE_AGENT_NAME` — Herdr agent name override (default:
  `sage-<timestamp>`).
- `SAGE_QEMU_MACHINE_TYPE` — QEMU machine-type override. `bin/sage-session`
  defaults this to `q35`; unset or override it if your host supports
  gondolin's default machine type.

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

This creates:

```text
dist/sage-gondolin-image-<arch>.tar.gz
dist/sage-gondolin-image-<arch>.tar.gz.sha256
```

Upload both files to a GitHub Release. `sage install-image` downloads the
matching architecture asset and verifies the SHA256 file before replacing the
local image directory.

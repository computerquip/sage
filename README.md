# sage

herdr manages sandboxed agent sessions; each session runs `pi` on the host
with every tool call (read/write/edit/bash/`!`) routed into a disposable
[gondolin](https://gondolin.dev) micro-VM. Because every dangerous action
executes inside the sandbox, pi can be run fully auto-approved.

See the design doc for the full rationale, architecture, and network model:
`~/.local/share/kilo/plans/sage-sandboxed-agent.md`.

## Status

This is a from-scratch scaffold. It has **not** been run end-to-end yet — the
build/dev machine used to author it does not have `pnpm`, `herdr`, `pi`,
`gondolin`, or QEMU installed. Everything here is structurally complete and
syntax-checked (JSON validated, shell scripts passed `bash -n`, TypeScript
passed `node --experimental-strip-types --check`), but treat Phase 1–5 below
as unverified until run against a real toolchain.

Known open items (see plan doc "Risks / open questions" for more):

- `@earendil-works/pi-coding-agent` and `@earendil-works/gondolin` are
  declared as `"*"` in `packages/pi-sage-sandbox/package.json` — pin real
  versions once you know where these packages are published (npm registry
  name/scope was not confirmed).
- `herdr-plugin/bin/new-session.sh` guesses the JSON field name returned by
  `herdr worktree create --json` (tries `.id`, `.workspace_id`,
  `.workspace.id`). Run it once against your installed herdr and fix the `jq`
  filter if none of those match.
- `image/build-config.json` sets `"arch": "x86_64"` (matches this authoring
  machine). **Re-check `uname -m` on whatever machine actually runs
  `gondolin build`** — a mismatched arch means the VM won't boot.

## Prerequisites

- QEMU (via your package manager).
- Node.js ≥ 23.6.0.
- pnpm, git.
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

1. Install workspace deps:

   ```sh
   pnpm install
   ```

2. Build the custom guest image once (bakes in git/node/python/rust):

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

3. Try it standalone in any repo:

   ```sh
   cd /path/to/some/project
   /path/to/sage/bin/sage
   ```

   This boots a gondolin VM, mounts the current directory read-write at
   `/workspace`, and starts `pi` with tools routed into the VM.

4. Wire up the herdr plugin for local dev:

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
  `<repo>/.gondolin-image`).
- `SAGE_HTTP_ALLOWED_HOSTS` — comma-separated HTTP/HTTPS allowlist (default
  `*`).
- `SAGE_SSH_HOSTS` — comma-separated SSH-git allowlist (default
  `github.com`).
- `SAGE_HOME` — repo root, auto-detected from script location if unset.

## Tearing down a session

```sh
herdr worktree remove --workspace <workspace_id> [--force]
```

This runs `git worktree remove` on the checkout; it never deletes the branch.

## Merging work back

The worktree is a normal git branch checkout — merge it like any other
branch (`git merge sage/<timestamp>`, or open a PR) once the sandboxed agent
is done.

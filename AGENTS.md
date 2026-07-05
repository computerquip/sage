# Agent Notes For This Repo

This repo builds Sage: a Herdr + pi + Gondolin setup for sandboxed coding
agents. Future agents should read this first to avoid rediscovering the same
architecture.

## Mental Model

- `bin/sage` is the user-facing CLI and the internal launcher. Normal users run
  `sage`; Herdr creates a separate git worktree on a `sage/<timestamp>` branch,
  starts `pi`, and invokes `bin/sage __agent ...` inside that worktree.
- `packages/pi-sage-sandbox/index.ts` is the pi extension entry point. It
  registers tools and routes read/write/edit/bash/user `!` operations into a
  Gondolin QEMU VM.
- The guest sees the project at `/workspace`. That is a mount of the host Sage
  worktree path. Edits under `/workspace` persist to the worktree; VM-local
  state outside the mount is ephemeral.
- Sage intentionally uses Gondolin's QEMU backend with `q35`, KVM, host CPU, 1
  vCPU, and `1G` memory by default. Avoid reintroducing krun unless the user
  explicitly asks for a new experiment.
- `sage-session` and `sage-pi` were deprecated/removed. Do not add them back;
  `sage` and `sage __agent` are the supported entry points.

## Important Files

- `bin/sage`: session lifecycle, Herdr worktree integration, image install,
  and handoff commands (`status`, `diff`, `merge`, `push`, `remove`). It also
  has `install-pi-packages`, which installs `@spences10/pi-context` and
  `pi-web-access` into Pi's package cache. Sage launches Pi with global
  extension/skill discovery disabled, then explicitly loads the Sage extension,
  the installed `@spences10/pi-context` extension, and the installed
  `pi-web-access` extension/skills by path. Do not re-enable global package
  discovery to pick up these tools; that can reintroduce unrelated host-side
  packages.
- `packages/pi-sage-sandbox/src/config.ts`: image path, QEMU options, VM memory
  and CPU defaults, HTTP/SSH egress policy.
- `packages/pi-sage-sandbox/src/gondolin-ops.ts`: adapters for pi's filesystem
  and shell tools.
- `packages/pi-sage-sandbox/src/paths.ts`: host path to `/workspace` mapping.
- `packages/pi-sage-sandbox/src/file-search.ts`: VM-backed path search and
  bounded tree inspection.
- `packages/pi-sage-sandbox/src/content-search.ts`: VM-backed bounded file
  content search.
- `tools/sage-fff`: Rust JSON CLI around FFF, installed into the guest image
  and used by `file_search` / `content_search`.
- `tools/sage-fff/build-alpine.sh`: builds the `sage-fff` binary in an Alpine
  container before `image/build.sh` runs Gondolin image assembly. Do not move
  this compile back into `postBuild.commands`; Gondolin's APK extractor/chroot
  path has not reliably exposed `rustc` there.
- `packages/pi-sage-sandbox/src/process-tools.ts`: VM process listing and
  signaling tools.
- `packages/pi-sage-sandbox/src/instructions.ts`: prompt text injected into
  Sage pi sessions so agents understand the VM/worktree model.
- `image/build-config.json`, `image/build.sh`, `image/package-release.sh`:
  custom Gondolin image build and release packaging.
- `install.sh`: installs/links the host `sage` command.

## Session Handoff Workflow

Agent edits happen in a separate Sage worktree/branch, not directly in the
user's original checkout. The host user can bring work back with:

```sh
sage list
sage status [target]
sage diff [target]
sage merge [target]
sage merge --remove [target]
sage push [target]
```

`target` defaults to `latest` and can be a `sage list` index, Sage branch/name,
workspace id, pane id, or worktree path. `sage merge` commits pending changes
inside the Sage worktree before merging the Sage branch into the user's current
branch. It refuses to merge if the user's current checkout is dirty.

## Tool And VM Details

- VM-backed tools are `read`, `write`, `edit`, `bash`, user `!`,
  `file_search`, `content_search`, `process_list`, and `process_signal`. Use
  them for exact file bytes, path/tree inspection, content search, mutations,
  shell commands, builds, tests, and VM process inspection.
- Host-side artifact tools are `context_search`, `context_get`,
  `context_export`, `context_list`, `context_stats`, and `context_purge` from
  the explicitly loaded `@spences10/pi-context` package. These are an overflow
  sidecar for large VM tool outputs. They search/retrieve already-captured
  artifacts; they do not execute commands or inspect live local files.
  `pi-context` requires Node >= 24.15.0 because it uses native `node:sqlite`.
- Host-side web tools are `web_search` and `fetch_content` from the explicitly
  loaded `pi-web-access` package. Use them for web access only.
- Sage routing takes precedence when package guidance overlaps. Use VM-backed
  tools for exact bytes, mutations, builds, tests, shell side effects, local
  search, and bounded local inspection.
- Sage launches Pi with built-in tools disabled. Do not re-enable host-side
  `find`, `grep`, `ls`, or package-based local file search in Sage sessions
  unless the user explicitly changes the sandboxing model.
- Use `file_search` for FFF fuzzy path search, glob search, and bounded tree
  inspection. Use `content_search` for local content search. Both execute
  inside the VM through the guest `sage-fff` binary; cold VM sessions rebuild
  their in-memory search index on first use.
- Sage registers `@spences10/pi-context` for artifact sidecar tooling. Large
  text outputs from VM tools can be stored in a Sage-scoped SQLite DB. Use
  `context_search` for snippets, `context_get` for focused chunks, and
  `context_export` when broad/full output should be processed from a file
  rather than loaded into chat.
- The sidecar is not durable memory and is not an execution layer. In smoke
  testing, a 69 KiB synthetic `bash` result was replaced with a
  `[context-sidecar]` receipt, split into 18 chunks, found by
  `context_search`, and retrieved by `context_get` with neighboring chunks.
- Sage registers `pi-web-access` for web tooling. Use `web_search` for URL
  discovery/current information and `fetch_content` for exact page contents.
- Prefer `read` when exact file text is needed for quoting or editing. Prefer
  `file_search` and `content_search` for bounded local exploration before
  reading large files. Actual edits still use `read` plus `edit`/`write`.
- HTTP/HTTPS egress is host mediated and defaults to open via
  `SAGE_HTTP_ALLOWED_HOSTS=*`.
- SSH git egress only works when the host has a valid `SSH_AUTH_SOCK` and the
  destination is in `SAGE_SSH_HOSTS` (default `github.com`). If no host
  `SSH_AUTH_SOCK` exists, that is not a Sage bug; SSH git is simply disabled.
- Do not assume `/root`, `/tmp`, package caches, background services, or other
  VM-local state will survive. Deliverable work belongs under `/workspace`.

## Validation

Useful checks that have worked in this repo:

```sh
sh -n bin/sage
./bin/sage --help
./bin/sage install-pi-packages
node --check packages/pi-sage-sandbox/index.ts
node --check packages/pi-sage-sandbox/src/instructions.ts
git diff --check
```

The workspace has not consistently had `typescript` installed, so `pnpm exec
tsc -p packages/pi-sage-sandbox/tsconfig.json` may fail with `tsc` missing.
Use it when available, but do not assume it exists.

The host has also not consistently had Rust installed. `tools/sage-fff` is
compiled by `tools/sage-fff/build-alpine.sh` in an Alpine container before
Gondolin assembles the image; use host-side Cargo checks when available, but do
not assume `cargo` exists.

Commands that talk to the real Herdr server, such as `./bin/sage list`,
`./bin/sage status latest`, or `./bin/sage diff --stat latest`, may need to run
outside the sandbox.

When package behavior changes, update the GitHub release notes for the current
installable release (`gh release edit v0.2.0 --repo computerquip/sage --notes-file ...`)
so users see the host-side package requirements alongside the image assets.

## Editing Guidance

- Prefer extending existing helpers over adding new parallel concepts. In
  particular, session resolution in `bin/sage` already supports `latest`,
  numeric list indices, names, branches, pane ids, workspace ids, and paths.
- Keep shell code POSIX `sh` compatible; `bin/sage` uses `#!/usr/bin/env sh`.
- Avoid sudo-based image build assumptions. The current build path is rootless
  Podman through Gondolin's custom image flow.
- If changing session instructions, update `src/instructions.ts` and remember
  they are appended during `before_agent_start` after the CWD line is rewritten
  to `/workspace`.

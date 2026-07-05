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
  has `install-pi-packages`, which registers `pi-fff`, `context-mode`, and
  `pi-web-access` as real Pi packages so package skills load. Do not load these
  packages with `pi -e npm:...`; that only loads extension resources and skips
  package skills. Override install sources with `SAGE_FILE_SEARCH_PACKAGE`,
  `SAGE_CONTEXT_MODE_PACKAGE`, or `SAGE_WEB_ACCESS_PACKAGE`; set any variable
  to an empty string to skip that package install. Sage sets
  `PI_FFF_MODE=override` at runtime unless the environment already provides a
  different `PI_FFF_MODE`.
- `packages/pi-sage-sandbox/src/config.ts`: image path, QEMU options, VM memory
  and CPU defaults, HTTP/SSH egress policy.
- `packages/pi-sage-sandbox/src/gondolin-ops.ts`: adapters for pi's filesystem
  and shell tools.
- `packages/pi-sage-sandbox/src/paths.ts`: host path to `/workspace` mapping.
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
  `process_list`, and `process_signal`. Use them for exact file bytes,
  mutations, shell commands, builds, tests, and VM process inspection.
- Host-side Pi package tools are `find`, `grep`, `multi_grep`, `ctx_*`,
  `web_search`, and `fetch_content`. Use them for fast worktree search,
  context-memory workflows, and web access; they do not inspect VM-local state.
- Sage routing takes precedence when package guidance overlaps. Use VM-backed
  tools for exact bytes, mutations, builds, tests, and shell side effects. Use
  `ctx_*` tools for derived facts, summaries, indexed docs, noisy output, and
  memory/search workflows.
- Sage registers `pi-fff` for file and content search in override mode by
  default. Use FFF-backed `find` for fuzzy path search, `grep` for content
  search, and `multi_grep` for OR-logic multi-pattern content search.
- Sage registers `pi-web-access` for web tooling. Use `web_search` for URL
  discovery/current information and `fetch_content` for exact page contents.
- Sage registers `context-mode` for context memory and `ctx_*` tooling. It
  depends on `better-sqlite3`; if Pi/npm blocks package install scripts, the
  extension may load but SQLite-backed memory may be degraded until scripts are
  approved or rebuilt.
- Prefer `read` when exact file text is needed for quoting or editing. Prefer
  `ctx_execute_file` when deriving facts from a large file without loading its
  exact bytes into the conversation. If context-mode wording says
  "Read/edit files -> ctx_execute_file", treat that as analysis-only; actual
  edits still use `read` plus `edit`/`write`.
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

Commands that talk to the real Herdr server, such as `./bin/sage list`,
`./bin/sage status latest`, or `./bin/sage diff --stat latest`, may need to run
outside the sandbox.

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

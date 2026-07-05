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
  vCPU, and `256M` memory by default. Avoid reintroducing krun unless the user
  explicitly asks for a new experiment.
- `sage-session` and `sage-pi` were deprecated/removed. Do not add them back;
  `sage` and `sage __agent` are the supported entry points.

## Important Files

- `bin/sage`: session lifecycle, Herdr worktree integration, image install,
  and handoff commands (`status`, `diff`, `merge`, `push`, `remove`).
- `packages/pi-sage-sandbox/src/config.ts`: image path, QEMU options, VM memory
  and CPU defaults, HTTP/SSH egress policy.
- `packages/pi-sage-sandbox/src/gondolin-ops.ts`: adapters for pi's filesystem
  and shell tools.
- `packages/pi-sage-sandbox/src/paths.ts`: host path to `/workspace` mapping.
- `packages/pi-sage-sandbox/src/file-search.ts`: structured file search and
  bounded tree tool.
- `packages/pi-sage-sandbox/src/provider-web-search.ts`: injects
  OpenAI-hosted web search into supported OpenAI Responses requests.
- `packages/pi-sage-sandbox/src/web-fetch.ts`: structured HTTP(S) page
  fetching through the VM.
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

- Read/write/edit/bash and user `!` commands in pi sessions execute in the
  Gondolin VM. Process tools inspect VM processes, not host processes.
- Sage does not register a local search-engine scraper. URL discovery/current
  information can use OpenAI-hosted `web_search` when the active provider is
  OpenAI Responses. `web_fetch` is available for exact page contents through
  the VM and is the intended place for future crawl4ai-backed retrieval work.
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
node --check packages/pi-sage-sandbox/index.ts
node --check packages/pi-sage-sandbox/src/instructions.ts
node --check packages/pi-sage-sandbox/src/provider-web-search.ts
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

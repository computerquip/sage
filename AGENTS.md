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
  state outside the mount is checkpointed on session shutdown and restored on
  reattach when checkpointing is enabled.
- The guest also sees a per-session host-backed scratch directory at
  `/scratch`. Use it for temporary files, extracted archives, logs, downloads,
  generated fixtures, and bulky intermediates that should not be merged back.
  `sage remove` deletes Sage's automatic scratch directory.
- Sage intentionally uses Gondolin's QEMU backend with `q35`, KVM, host CPU, 1
  vCPU, and `1G` memory by default. Avoid reintroducing krun unless the user
  explicitly asks for a new experiment.
- Sage uses one Gondolin disk checkpoint per Sage session by default. The
  checkpoint path is passed as `SAGE_VM_CHECKPOINT`, defaults under
  `${SAGE_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/sage}/vm-checkpoints`, is
  resumed on reattach, and is removed by `sage remove`.
- `sage-session` and `sage-pi` were deprecated/removed. Do not add them back;
  `sage` and `sage __agent` are the supported entry points.

## Important Files

- `bin/sage`: session lifecycle, Herdr worktree integration, image install,
  and handoff commands (`status`, `diff`, `merge`, `push`, `remove`). It also
  has `install-pi-packages`, which installs `@spences10/pi-context` and
  `pi-web-access` into Pi's package cache. Sage launches Pi with global
  extension/skill discovery disabled, then explicitly loads the Sage extension,
  the in-repo `pi-sage-memory` extension, the installed `@spences10/pi-context`
  extension, and the installed `pi-web-access` extension/skills by path. Do not
  re-enable global package discovery to pick up these tools; that can
  reintroduce unrelated host-side packages.
- `packages/pi-sage-sandbox/src/config.ts`: image path, scratch mount path,
  QEMU options, VM memory and CPU defaults, HTTP/SSH egress policy.
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
- `packages/pi-sage-memory/index.ts`: host-side durable memory tools backed by
  Mem0. This is not VM-routed because durable memory is shared agent state, not
  sandbox file/process state. Mem0's TypeScript package currently does not
  expose the Python package's native FastEmbed provider; Sage uses Mem0's
  `langchain` embedder adapter with a small local object that implements
  `embedQuery` and `embedDocuments` by calling `fastembed`.
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
- VM-backed file tools intentionally allow only `/workspace` and `/scratch`.
  `/workspace` is deliverable git work; `/scratch` is session scratch. Use
  `bash` for other VM-local paths such as `/tmp` or `/root`.
- The overridden `read`, `write`, `edit`, and `bash` tools carry Sage-specific
  descriptions/prompt guidance in `packages/pi-sage-sandbox/index.ts`. Keep
  that metadata aligned with this file and `src/instructions.ts`; tool routing
  should be obvious from the tool picker itself, not only from the session
  prompt.
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
  inside the VM through the guest `sage-fff` binary and can search either
  `/workspace` or `/scratch`; cold VM sessions rebuild their in-memory search
  index on first use.
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
- Sage registers `pi-sage-memory` for durable memory. Tools are
  `memory_status`, `memory_add`, `memory_search`, `memory_get`, and
  `memory_delete`. Memory is host-side by design because it is shared agent
  state, not sandbox filesystem/process state. Do not store secrets,
  credentials, private keys, or transient command output.
- Durable memory embeddings are local-only through FastEmbed via Mem0's
  `langchain` embedder adapter. The default model is
  FastEmbed's default `BAAI/bge-small-en-v1.5` / `fast-bge-small-en-v1.5` at
  384 dimensions; if changing it, update `SAGE_MEMORY_EMBED_MODEL` and
  `SAGE_MEMORY_EMBED_DIMENSION` together. Normal `memory_add` uses
  `infer=false` and stores the supplied fact directly. `memory_add infer=true`
  is intentionally disabled until Sage has a local LLM policy for memory
  extraction. Do not add hosted embedding fallbacks; fail loudly when
  FastEmbed or the local model is unavailable.
- The FastEmbed model is downloaded on first use into
  `SAGE_MEMORY_FASTEMBED_CACHE_DIR` (default under the Sage cache directory).
  First-use `memory_add`/`memory_search` therefore needs network access unless
  the model is already cached. If initialization fails, Sage clears the cached
  FastEmbed promise so a later tool call can retry after the cache/network issue
  is fixed.
- `fastembed` depends on `onnxruntime-node`; `pnpm-workspace.yaml` must keep
  `allowBuilds.onnxruntime-node: true`. The code sets FastEmbed's execution
  provider to CPU even though the upstream postinstall may download ONNX runtime
  assets that mention CUDA/TensorRT.
- Prefer `read` when exact file text is needed for quoting or editing. Prefer
  `file_search` and `content_search` for bounded local exploration before
  reading large files. Actual edits still use `read` plus `edit`/`write`.
- HTTP/HTTPS egress is host mediated and defaults to open via
  `SAGE_HTTP_ALLOWED_HOSTS=*`.
- SSH git egress only works when the host has a valid `SSH_AUTH_SOCK` and the
  destination is in `SAGE_SSH_HOSTS` (default `github.com`). If no host
  `SSH_AUTH_SOCK` exists, that is not a Sage bug; SSH git is simply disabled.
- `/root`, `/tmp`, package caches, background services, and other VM-local state
  should survive stop/reattach through the per-session checkpoint. Still treat
  that state as disposable session-local convenience: `sage remove` deletes it,
  and deliverable work belongs under `/workspace`.
- Use `/scratch` instead of `/tmp` when the agent needs a real file-tool-visible
  temp directory or a host-backed session artifact area.

## Validation

Useful checks that have worked in this repo:

```sh
sh -n bin/sage
./bin/sage --help
./bin/sage install-pi-packages
node --check packages/pi-sage-sandbox/index.ts
node --check packages/pi-sage-sandbox/src/instructions.ts
pnpm exec tsc -p packages/pi-sage-sandbox/tsconfig.json
pnpm exec tsc -p packages/pi-sage-memory/tsconfig.json
git diff --check
```

`typescript` and `@types/node` are root dev dependencies, so the TypeScript
check should work after `pnpm install`.

Durable memory smoke test:

```sh
env SAGE_MEMORY_DIR=/tmp/sage-memory-smoke \
  SAGE_MEMORY_FASTEMBED_CACHE_DIR=/tmp/sage-memory-fastembed-cache \
  node -e 'const tools=[]; const mod=await import("./packages/pi-sage-memory/index.ts"); mod.default({registerTool:t=>tools.push(t)}); const call=async(name,params)=>{ const tool=tools.find(t=>t.name===name); const result=await tool.execute(name,params,undefined,undefined,{}); console.log(`--- ${name} ---`); console.log(result.content[0].text); }; await call("memory_add",{text:"Sage memory smoke test fact.",scope:"global"}); await call("memory_search",{query:"Sage memory smoke",scope:"global",topK:3});'
```

Run this outside the network sandbox or with a pre-populated
`SAGE_MEMORY_FASTEMBED_CACHE_DIR` when testing a fresh cache.

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

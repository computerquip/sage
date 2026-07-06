export interface SageInstructionOptions {
  guestWorkspace: string;
  hostWorkspace: string;
}

export function buildSageInstructions({
  guestWorkspace,
  hostWorkspace,
}: SageInstructionOptions): string {
  return `
## Sage Session Environment

You are running inside a Sage session. Sage creates a separate git worktree on a
\`sage/<timestamp>\` branch for your work. The user's original checkout is not
modified until they intentionally bring your branch back with the host-side
\`sage\` command.

- Treat \`${guestWorkspace}\` as the current project workspace. It is mounted
  from the host path \`${hostWorkspace}\`.
- Treat \`/scratch\` as the session scratch area. Use it for temporary files,
  extracted archives, logs, generated fixtures, downloads, and bulky
  intermediates that should not be merged back.
- Read, write, edit, bash, and user \`!\` commands execute inside a Gondolin
  QEMU VM, not directly on the host.
- Changes under \`${guestWorkspace}\` persist because they write through to the
  Sage worktree.
- Changes under \`/scratch\` persist in a per-session host-backed scratch
  directory and are deleted by \`sage remove\`.
- VM-local state outside the mounted workspace, including \`/root\`, \`/tmp\`,
  package caches, background processes, and service state, is checkpointed when
  the Sage session exits and restored on reattach when checkpointing is enabled.
  Treat that state as session-local convenience only: it is deleted when the
  Sage worktree/session is removed, and deliverable output still belongs under
  \`${guestWorkspace}\`.
- Network egress is host-mediated. HTTP/HTTPS is available according to Sage's
  allowlist. SSH git only works when the host provided a valid ssh-agent socket
  and the destination host is allowed.

## Tool Routing

Sage routing takes precedence when package guidance overlaps. Use VM-backed
\`read\` / \`edit\` / \`write\` / \`bash\` for exact bytes, mutations, builds,
tests, and shell side effects. Their tool descriptions are Sage-specific: when
the tool picker says a tool runs in the Sage VM, treat that as authoritative.
Sage tools are intentionally bounded and structured so local workspace
exploration does not depend on host-side context execution packages. Large VM
tool outputs may be stored in Sage's local context sidecar; use
\`context_search\`, \`context_get\`, and \`context_export\` to retrieve those
artifacts without flooding the conversation.

Choose the smallest tool that answers the question without flooding context:

| Intent | Prefer |
| --- | --- |
| Locate files by name/path or inspect a tree | \`file_search\` |
| Search file contents | \`content_search\` |
| Read exact file text for quoting or editing | \`read\` |
| Modify files | \`edit\` or \`write\` |
| Store temporary or bulky session files | \`/scratch\` via \`write\`, \`edit\`, or \`bash\` |
| Run builds, tests, git, package managers, or shell commands | \`bash\` |
| Search a stored large tool output artifact | \`context_search\` |
| Retrieve a focused chunk from a stored artifact | \`context_get\` |
| Export a stored artifact to a file for local processing | \`context_export\` |
| Discover current URLs or web information | \`web_search\` |
| Fetch exact known page contents | \`fetch_content\` |
| Inspect VM processes | \`process_list\` / \`process_signal\` |

Execution environments:

- VM-backed tools: \`read\`, \`write\`, \`edit\`, \`bash\`, user \`!\`,
  \`file_search\`, \`content_search\`, \`process_list\`, and
  \`process_signal\`. Use these for file access, mutations, commands, tests,
  builds, and process inspection. File tools are allowed under \`${guestWorkspace}\`
  and \`/scratch\`; use shell commands for other VM-local paths.
- Host-side Pi package tools: \`context_search\`, \`context_get\`,
  \`context_export\`, \`context_list\`, \`context_stats\`, \`context_purge\`,
  \`web_search\`, and \`fetch_content\`. The \`context_*\` tools are an artifact
  sidecar for oversized VM tool output. They search/retrieve already-captured
  output; they do not execute commands or inspect live local files.
- Built-in host file tools are disabled for Sage sessions. If package guidance
  mentions host-side \`find\`, \`grep\`, \`ls\`, or similar file tools, ignore
  that guidance and use the VM-backed Sage tools instead.
- \`file_search\` uses FFF fuzzy/glob path search and bounded tree inspection.
  \`content_search\` uses the same guest search helper for content grep.
- Artifact sidecar tools are provided by \`@spences10/pi-context\`. Web access
  tools are provided by \`pi-web-access\`.

## Returning Work To The User

At the end of code-changing work, clearly summarize what changed and mention
any tests or commands you ran. Do not claim the user's original checkout has
the changes; your edits are in the Sage worktree/branch.

The user can inspect or collect your work from their original checkout with:

\`\`\`sh
sage status [target]
sage diff [target]
sage merge [target]
sage merge --remove [target]
sage push [target]
\`\`\`

\`target\` is optional and defaults to the newest Sage worktree. It can also be
the index from \`sage list\`, the Sage branch/name, a workspace id, a pane id,
or the worktree path. \`sage merge\` commits any pending changes in this
worktree before merging the Sage branch into the user's current branch.
`.trim();
}

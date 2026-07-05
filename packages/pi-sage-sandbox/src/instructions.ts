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
- Read, write, edit, bash, and user \`!\` commands execute inside a Gondolin
  QEMU VM, not directly on the host.
- Changes under \`${guestWorkspace}\` persist because they write through to the
  Sage worktree. VM-local state outside the mounted workspace, including
  \`/root\`, \`/tmp\`, package caches, background processes, and service state,
  is ephemeral and should not be treated as deliverable output.
- Use structured tools when they fit: \`file_search\` for path searches/trees,
  provider-native web search for URL discovery/current information,
  \`web_fetch\` for exact HTTP(S) page contents, and \`process_list\` /
  \`process_signal\` for VM processes. Sage does not register a local
  \`web_search\` scraper tool. The process tools inspect the VM, not the host.
- Network egress is host-mediated. HTTP/HTTPS is available according to Sage's
  allowlist. SSH git only works when the host provided a valid ssh-agent socket
  and the destination host is allowed.

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

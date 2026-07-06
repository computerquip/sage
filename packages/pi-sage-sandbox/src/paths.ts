/**
 * Path helpers shared by the gondolin tool-operation adapters.
 *
 * Ported near-verbatim from gondolin's reference extension
 * (host/examples/pi-gondolin.ts in earendil-works/gondolin).
 */

import path from "node:path";

import { GUEST_SCRATCH, GUEST_WORKSPACE } from "./config.js";

/** POSIX single-quote shell escaping: wraps in quotes, escapes embedded quotes. */
export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Maps an absolute host path (as pi tools pass them) into the guest's
 * `/workspace`-relative path. Throws if the path escapes the mounted cwd.
 *
 * Also accepts paths that are already guest-style (`/workspace` or
 * `/workspace/...`, `/scratch` or `/scratch/...`) and passes them through
 * unchanged. This is required
 * because `before_agent_start` rewrites the system prompt's "Current
 * working directory" line to say `/workspace`, so models routinely echo
 * that back as an absolute path for tool calls (e.g. `read` with
 * `path: "/workspace/README.md"`) instead of a host-relative path. Without
 * this passthrough, those calls fail with a spurious "path escapes
 * workspace" error even though the path is valid.
 */
export function toGuestPath(localCwd: string, localPath: string): string {
  if (localPath === GUEST_WORKSPACE || localPath.startsWith(GUEST_WORKSPACE + "/")) {
    return localPath;
  }
  if (localPath === GUEST_SCRATCH || localPath.startsWith(GUEST_SCRATCH + "/")) {
    return localPath;
  }

  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace or scratch: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest.
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

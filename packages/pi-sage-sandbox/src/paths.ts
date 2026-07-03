/**
 * Path helpers shared by the gondolin tool-operation adapters.
 *
 * Ported near-verbatim from gondolin's reference extension
 * (host/examples/pi-gondolin.ts in earendil-works/gondolin).
 */

import path from "node:path";

import { GUEST_WORKSPACE } from "./config.js";

/** POSIX single-quote shell escaping: wraps in quotes, escapes embedded quotes. */
export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Maps an absolute host path (as pi tools pass them) into the guest's
 * `/workspace`-relative path. Throws if the path escapes the mounted cwd.
 */
export function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest.
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

/**
 * Sage sandbox configuration.
 *
 * Centralizes the gondolin image location and the network egress policy so
 * `index.ts` stays focused on wiring pi's tool surface to the VM.
 *
 * See ../../../.local/share/kilo/plans/sage-sandboxed-agent.md ("Network
 * egress model") for the rationale behind each setting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GUEST_WORKSPACE = "/workspace";

/**
 * Directory containing the built gondolin image (manifest.json + kernel +
 * initramfs + rootfs.ext4). Defaults to `.gondolin-image` at the sage repo
 * root; override with SAGE_IMAGE_DIR once `image/build.sh` has been run.
 *
 * If unset AND the directory doesn't exist, gondolin falls back to its
 * built-in default image (useful for Phase 1 bring-up before the custom
 * image is built).
 */
export function resolveImageDir(): string | undefined {
  const configured = process.env.SAGE_IMAGE_DIR;
  if (configured) return path.resolve(configured);

  // sage/packages/pi-sage-sandbox/src/config.ts -> sage/.gondolin-image
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const defaultDir = path.join(repoRoot, ".gondolin-image");
  return fs.existsSync(defaultDir) ? defaultDir : undefined;
}

/** HTTP/HTTPS egress: wide open by default (curl, npm/pip/cargo, https git). */
export function resolveAllowedHttpHosts(): string[] {
  const raw = process.env.SAGE_HTTP_ALLOWED_HOSTS;
  if (!raw) return ["*"];
  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}

/**
 * SSH-git egress allowlist. No wildcard support upstream — hosts must be
 * enumerated. Defaults to github.com; extend via SAGE_SSH_HOSTS
 * (comma-separated) for gitlab.com, bitbucket.org, self-hosted, etc.
 */
export function resolveSshAllowedHosts(): string[] {
  const raw = process.env.SAGE_SSH_HOSTS ?? "github.com";
  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}

export function resolveSshAgentPath(): string | undefined {
  return process.env.SSH_AUTH_SOCK;
}

export function resolveKnownHostsFile(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

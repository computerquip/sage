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
 * initramfs + rootfs.ext4). Defaults to the user cache, then falls back to
 * `.gondolin-image` at the sage repo root for local development. Override
 * with SAGE_IMAGE_DIR.
 *
 * If unset AND the directory doesn't exist, gondolin falls back to its
 * built-in default image (useful for Phase 1 bring-up before the custom
 * image is built).
 */
export function resolveImageDir(): string | undefined {
  const configured = process.env.SAGE_IMAGE_DIR;
  if (configured) {
    const resolved = path.resolve(configured);
    return fs.existsSync(resolved) ? resolved : undefined;
  }

  const cacheDir = process.env.SAGE_CACHE_DIR
    ? path.join(process.env.SAGE_CACHE_DIR, "gondolin-image")
    : path.join(
        process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
        "sage",
        "gondolin-image",
      );
  if (fs.existsSync(cacheDir)) return cacheDir;

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
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock) return undefined;

  try {
    return fs.statSync(sock).isSocket() ? sock : undefined;
  } catch {
    return undefined;
  }
}

export function resolveKnownHostsFile(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

/** QEMU machine type override. */
export function resolveQemuMachineType(): string | undefined {
  return process.env.SAGE_QEMU_MACHINE_TYPE || "q35";
}

/**
 * Gondolin VM memory size for Sage sessions. Keep the default small so nested
 * sessions remain practical on low-memory hosts.
 */
export function resolveVmMemory(): string {
  return process.env.SAGE_VM_MEMORY || "256M";
}

export function resolveQemuAccel(): string {
  return process.env.SAGE_QEMU_ACCEL || "kvm";
}

export function resolveQemuCpu(): string {
  return process.env.SAGE_QEMU_CPU || "host";
}

export function resolveVmCpus(): number {
  const raw = process.env.SAGE_VM_CPUS || "1";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Unsupported SAGE_VM_CPUS=${raw}; expected a positive integer`);
  }
  const cpus = Number.parseInt(raw, 10);
  if (cpus < 1) {
    throw new Error(`Unsupported SAGE_VM_CPUS=${raw}; expected a positive integer`);
  }
  return cpus;
}

export function resolveQemuAppend(): string {
  return process.env.SAGE_QEMU_APPEND || "console=ttyS0 panic=1 reboot=k pci=lastbus=0";
}

export function resolveBedrockAgentCoreGatewayUrl(): string | undefined {
  const raw =
    process.env.SAGE_BEDROCK_AGENTCORE_GATEWAY_URL ||
    process.env.SAGE_AGENTCORE_GATEWAY_URL;
  if (!raw) return undefined;

  const url = new URL(raw);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/mcp";
  }
  return url.toString();
}

export function resolveBedrockAgentCoreAccessToken(): string | undefined {
  return (
    process.env.SAGE_BEDROCK_AGENTCORE_ACCESS_TOKEN ||
    process.env.SAGE_AGENTCORE_ACCESS_TOKEN
  );
}

export function resolveBedrockAgentCoreTokenEndpoint(): string | undefined {
  return (
    process.env.SAGE_BEDROCK_AGENTCORE_TOKEN_ENDPOINT ||
    process.env.SAGE_AGENTCORE_TOKEN_ENDPOINT
  );
}

export function resolveBedrockAgentCoreClientId(): string | undefined {
  return (
    process.env.SAGE_BEDROCK_AGENTCORE_CLIENT_ID ||
    process.env.SAGE_AGENTCORE_CLIENT_ID
  );
}

export function resolveBedrockAgentCoreClientSecret(): string | undefined {
  return (
    process.env.SAGE_BEDROCK_AGENTCORE_CLIENT_SECRET ||
    process.env.SAGE_AGENTCORE_CLIENT_SECRET
  );
}

export function resolveBedrockAgentCoreWebSearchToolName(): string {
  return (
    process.env.SAGE_BEDROCK_AGENTCORE_WEB_SEARCH_TOOL ||
    process.env.SAGE_AGENTCORE_WEB_SEARCH_TOOL ||
    "web-search-tool___WebSearch"
  );
}

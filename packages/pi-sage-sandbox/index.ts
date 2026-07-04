/**
 * Sage sandbox extension for pi.
 *
 * Routes pi's read/write/edit/bash tools (and user `!` commands) into a
 * disposable gondolin micro-VM, so the agent can be run fully auto-approved
 * on the host while every filesystem/process action actually happens inside
 * the sandbox.
 *
 * Based on gondolin's reference extension
 * (host/examples/pi-gondolin.ts in earendil-works/gondolin), extended with:
 *   - a custom prebuilt guest image (git/node/python/rust toolchain baked in)
 *   - open HTTP/HTTPS egress
 *   - SSH-git egress to an allowlist, authenticated via the host ssh-agent
 *
 * See sage's plan doc for the full rationale:
 *   ~/.local/share/kilo/plans/sage-sandboxed-agent.md
 *
 * Usage:
 *   pi -e /abs/path/to/sage/packages/pi-sage-sandbox/index.ts
 * or register it in ~/.pi/agent/settings.json under "extensions".
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";

import {
  GUEST_WORKSPACE,
  resolveAllowedHttpHosts,
  resolveImageDir,
  resolveKnownHostsFile,
  resolveMachineType,
  resolveSshAgentPath,
  resolveSshAllowedHosts,
} from "./src/config.js";
import {
  createGondolinBashOps,
  createGondolinEditOps,
  createGondolinReadOps,
  createGondolinWriteOps,
} from "./src/gondolin-ops.js";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      const imagePath = resolveImageDir();
      const { httpHooks, env } = createHttpHooks({
        allowedHosts: resolveAllowedHttpHosts(),
      });
      const sshHosts = resolveSshAllowedHosts();
      const sshAgent = resolveSshAgentPath();

      const machineType = resolveMachineType();
      const created = await VM.create({
        sandbox:
          imagePath || machineType
            ? { ...(imagePath ? { imagePath } : {}), ...(machineType ? { machineType } : {}) }
            : undefined,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
        httpHooks,
        env,
        // synthetic/per-host DNS is required for SSH (and TCP) egress host
        // attribution; HTTP policy still works fine under it.
        dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
        ssh: sshAgent
          ? {
              allowedHosts: sshHosts,
              agent: sshAgent,
              knownHostsFile: resolveKnownHostsFile(),
            }
          : undefined,
      });

      if (!sshAgent) {
        ctx?.ui.notify(
          "SSH_AUTH_SOCK missing or stale on host — SSH-git egress disabled for this VM (HTTPS git still works).",
          "warning",
        );
      }

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing qemu, bad image, etc.)
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Run user `!` commands inside the VM too.
  pi.on("user_bash", (_event, _ctx) => {
    if (!vm) return;
    return { operations: createGondolinBashOps(vm, localCwd) };
  });

  // Replace the CWD line in the system prompt so the model sees /workspace.
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}

/**
 * Sage sandbox extension for pi.
 *
 * Routes pi's read/write/edit/bash tools (and user `!` commands) into a
 * disposable gondolin QEMU VM, so the agent can be run fully auto-approved
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
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import {
  createHttpHooks,
  RealFSProvider,
  VM,
  VmCheckpoint,
  type VMOptions,
} from "@earendil-works/gondolin";

import {
  GUEST_SCRATCH,
  GUEST_WORKSPACE,
  resolveAllowedHttpHosts,
  resolveImageDir,
  resolveKnownHostsFile,
  resolveQemuAccel,
  resolveQemuAppend,
  resolveQemuCpu,
  resolveQemuMachineType,
  resolveScratchDir,
  resolveSshAgentPath,
  resolveSshAllowedHosts,
  resolveVmCpus,
  resolveVmMemory,
} from "./src/config.js";
import {
  createGondolinBashOps,
  createGondolinEditOps,
  createGondolinReadOps,
  createGondolinWriteOps,
} from "./src/gondolin-ops.js";
import { createContentSearchTool } from "./src/content-search.js";
import { createFileSearchTool } from "./src/file-search.js";
import {
  createProcessListTool,
  createProcessSignalTool,
} from "./src/process-tools.js";
import { buildSageInstructions } from "./src/instructions.js";

function withSageGuidance<T extends ToolDefinition>(
  tool: T,
  guidance: {
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
  },
): T {
  return {
    ...tool,
    description: guidance.description,
    promptSnippet: guidance.promptSnippet,
    promptGuidelines: [
      ...guidance.promptGuidelines,
      ...(tool.promptGuidelines ?? []),
    ],
  };
}

function checkpointsDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.SAGE_VM_CHECKPOINT_DISABLE ?? "");
}

function resolveCheckpointPath(): string | undefined {
  if (checkpointsDisabled()) return undefined;
  const configured = process.env.SAGE_VM_CHECKPOINT?.trim();
  if (!configured) return undefined;
  return path.resolve(configured);
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const checkpointPath = resolveCheckpointPath();

  const localRead = withSageGuidance(createReadTool(localCwd), {
    description:
      "Read exact file text from the Sage VM-mounted /workspace or /scratch paths, not from the host filesystem.",
    promptSnippet:
      "Read exact bytes from the Sage VM workspace or scratch mount after narrowing with file_search or content_search.",
    promptGuidelines: [
      "Use read only when exact text is needed for quoting, reasoning about nearby code, or preparing an edit.",
      "Use file_search for path discovery and content_search for workspace-wide text search before reading large files.",
      "Use /workspace for deliverable files and /scratch for session scratch files.",
    ],
  });
  const localWrite = withSageGuidance(createWriteTool(localCwd), {
    description:
      "Write file contents inside the Sage VM-mounted /workspace or /scratch paths.",
    promptSnippet:
      "Write complete file contents inside the Sage VM workspace or scratch mount.",
    promptGuidelines: [
      "Use write for new files or full-file replacement after reading enough context.",
      "Prefer edit for targeted changes to existing files.",
      "Use /workspace for files that should be merged back; use /scratch for temporary or bulky session artifacts.",
    ],
  });
  const localEdit = withSageGuidance(createEditTool(localCwd), {
    description:
      "Apply targeted text edits inside the Sage VM-mounted /workspace or /scratch paths.",
    promptSnippet:
      "Edit existing files inside the Sage VM workspace or scratch mount using exact surrounding text.",
    promptGuidelines: [
      "Use read first when an edit needs exact old text.",
      "If an edit fails, use read or content_search on the same path to find the current nearby text, then retry with a narrower exact replacement.",
      "Use /workspace for files that should be merged back; use /scratch for temporary or bulky session artifacts.",
    ],
  });
  const localBash = withSageGuidance(createBashTool(localCwd), {
    description:
      "Run shell commands inside the Sage Gondolin VM, not on the host; use for builds, tests, git, package managers, and local inspection.",
    promptSnippet:
      "Run commands inside the Sage VM workspace. Large output is handled by the context sidecar when available.",
    promptGuidelines: [
      "Use bash for builds, tests, git, package managers, and shell commands that need workspace side effects.",
      "Use file_search/content_search instead of ad hoc find/grep when structured bounded search is enough.",
      "Use /scratch for temporary files, extracted archives, logs, and large intermediate artifacts that should not be merged.",
      "If a command appears hung, inspect it with process_list and stop it with process_signal.",
      "When large output is stored by the context sidecar, use context_search/context_get/context_export to retrieve focused results.",
    ],
  });

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
      const scratchDir = resolveScratchDir();
      const mounts = {
        [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
        ...(scratchDir ? { [GUEST_SCRATCH]: new RealFSProvider(scratchDir) } : {}),
      };

      const machineType = resolveQemuMachineType();
      const sandbox =
        imagePath || machineType
          ? {
              ...(imagePath ? { imagePath } : {}),
              ...(machineType ? { machineType } : {}),
              accel: resolveQemuAccel(),
              append: resolveQemuAppend(),
              cpu: resolveQemuCpu(),
            }
          : undefined;
      const vmOptions: VMOptions = {
        memory: resolveVmMemory(),
        cpus: resolveVmCpus(),
        sandbox,
        vfs: {
          mounts,
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
      };
      let created: VM;
      if (checkpointPath && fs.existsSync(checkpointPath)) {
        try {
          ctx?.ui.setStatus(
            "gondolin",
            ctx.ui.theme.fg("accent", "Gondolin: resuming checkpoint"),
          );
          created = await VmCheckpoint.load(checkpointPath).resume<VM>(
            vmOptions,
          );
          ctx?.ui.notify(
            `Gondolin qemu VM resumed from checkpoint ${checkpointPath}`,
            "info",
          );
        } catch (error) {
          const failedPath = `${checkpointPath}.failed-${Date.now()}`;
          try {
            fs.renameSync(checkpointPath, failedPath);
          } catch {
            fs.rmSync(checkpointPath, { force: true });
          }
          ctx?.ui.notify(
            `Gondolin checkpoint resume failed; starting a fresh VM. Old checkpoint moved to ${failedPath}. ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
          created = await VM.create(vmOptions);
        }
      } else {
        created = await VM.create(vmOptions);
      }

      if (!sshAgent) {
        ctx?.ui.notify(
          "Host ssh-agent unavailable (SSH_AUTH_SOCK is unset, stale, or not a socket); SSH-git egress disabled for this VM (HTTPS git still works).",
          "warning",
        );
      }

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running via qemu (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        scratchDir
          ? `Gondolin qemu VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}; scratch ${scratchDir} mounted at ${GUEST_SCRATCH}`
          : `Gondolin qemu VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing QEMU/KVM support, bad image, etc.)
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    const activeVm = vm;
    vm = null;
    vmStarting = null;
    try {
      if (checkpointPath) {
        ctx.ui.setStatus(
          "gondolin",
          ctx.ui.theme.fg("muted", "Gondolin: checkpointing"),
        );
        await activeVm.checkpoint(checkpointPath);
        ctx.ui.notify(
          `Gondolin qemu VM checkpoint saved to ${checkpointPath}`,
          "info",
        );
      } else {
        ctx.ui.setStatus(
          "gondolin",
          ctx.ui.theme.fg("muted", "Gondolin: stopping"),
        );
        await activeVm.close();
      }
    } finally {
      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("muted", "Gondolin: stopped"),
      );
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

  pi.registerTool(createProcessListTool((ctx) => ensureVm(ctx)));
  pi.registerTool(createProcessSignalTool((ctx) => ensureVm(ctx)));
  pi.registerTool(createFileSearchTool((ctx) => ensureVm(ctx), localCwd));
  pi.registerTool(createContentSearchTool((ctx) => ensureVm(ctx), localCwd));

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
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd}; session scratch: ${GUEST_SCRATCH})`,
    );
    const sageInstructions = buildSageInstructions({
      guestWorkspace: GUEST_WORKSPACE,
      hostWorkspace: localCwd,
    });
    return { systemPrompt: `${modified}\n\n${sageInstructions}` };
  });
}

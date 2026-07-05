import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { shQuote } from "./paths.js";

type ProcessListParams = {
  query?: string;
  maxResults?: number;
  includeThreads?: boolean;
};

type ProcessSignalParams = {
  pid: number;
  signal?: "TERM" | "KILL" | "INT" | "HUP";
};

const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 500;

const processListParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Optional case-insensitive substring filter matched against pid, command, and cmdline.",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
      description: `Maximum process entries to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
    },
    includeThreads: {
      type: "boolean",
      description:
        "Include per-thread task entries when available. Defaults to false.",
    },
  },
  additionalProperties: false,
};

const processSignalParameters = {
  type: "object",
  properties: {
    pid: {
      type: "number",
      minimum: 2,
      description: "Process ID inside the Sage VM. PID 1 is intentionally refused.",
    },
    signal: {
      type: "string",
      enum: ["TERM", "KILL", "INT", "HUP"],
      description: "Signal to send. Defaults to TERM.",
    },
  },
  required: ["pid"],
  additionalProperties: false,
};

function maxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(Math.floor(value), MAX_MAX_RESULTS));
}

function buildProcessListScript(params: ProcessListParams): string {
  const nodeScript = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");

const params = JSON.parse(process.argv[1]);

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function statExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function parseStatus(status) {
  const out = {};
  for (const line of status.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return out;
}

function splitCmdline(raw) {
  return raw.split("\0").filter(Boolean);
}

async function readProcess(pid, tid = null) {
  const base = tid === null ? "/proc/" + pid : "/proc/" + pid + "/task/" + tid;
  const status = parseStatus(await readText(base + "/status"));
  if (!status.Name) return null;

  const cmdlineRaw = tid === null ? await readText(base + "/cmdline") : "";
  const cmdline = splitCmdline(cmdlineRaw);
  const comm = (await readText(base + "/comm")).trim() || status.Name;
  const cwd = tid === null
    ? await fs.readlink(base + "/cwd").catch(() => null)
    : null;

  return {
    pid: Number(pid),
    tid: tid === null ? undefined : Number(tid),
    ppid: Number(status.PPid ?? 0),
    state: status.State ?? "",
    name: status.Name,
    command: cmdline.length > 0 ? cmdline.join(" ") : comm,
    cmdline,
    cwd,
    userIds: status.Uid ? status.Uid.split(/\s+/).map(Number) : [],
    memoryKb: status.VmRSS ? Number(status.VmRSS.replace(/\D+/g, "")) : null,
  };
}

async function listProcesses() {
  const entries = [];
  const procEntries = await fs.readdir("/proc", { withFileTypes: true });
  const pids = procEntries
    .filter((entry) => entry.isDirectory() && /^[0-9]+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);

  for (const pid of pids) {
    const process = await readProcess(pid);
    if (process) entries.push(process);

    if (!params.includeThreads) continue;
    const taskDir = "/proc/" + pid + "/task";
    if (!(await statExists(taskDir))) continue;
    const tasks = await fs.readdir(taskDir).catch(() => []);
    for (const tid of tasks) {
      if (!/^[0-9]+$/.test(tid) || Number(tid) === pid) continue;
      const thread = await readProcess(pid, tid);
      if (thread) entries.push(thread);
    }
  }

  return entries;
}

const query = params.query.trim().toLowerCase();
const all = await listProcesses();
const filtered = query
  ? all.filter((process) =>
      String(process.pid).includes(query) ||
      String(process.tid ?? "").includes(query) ||
      process.name.toLowerCase().includes(query) ||
      process.command.toLowerCase().includes(query)
    )
  : all;

const results = filtered.slice(0, params.maxResults);
console.log(JSON.stringify({
  query: params.query || undefined,
  includeThreads: params.includeThreads,
  maxResults: params.maxResults,
  totalMatches: filtered.length,
  truncated: filtered.length > results.length,
  results,
}, null, 2));
`;

  return [
    "set -eu",
    "node --input-type=module -e " +
      shQuote(nodeScript) +
      " " +
      shQuote(
        JSON.stringify({
          query: params.query?.trim() ?? "",
          maxResults: maxResults(params.maxResults),
          includeThreads: params.includeThreads === true,
        }),
      ),
  ].join("\n");
}

function buildProcessSignalScript(params: ProcessSignalParams): string {
  const pid = Math.floor(params.pid);
  if (!Number.isFinite(pid) || pid < 2) {
    throw new Error("process_signal refuses PID 1 and invalid PIDs");
  }

  const signal = params.signal ?? "TERM";
  if (!["TERM", "KILL", "INT", "HUP"].includes(signal)) {
    throw new Error(`unsupported signal: ${signal}`);
  }

  const nodeScript = String.raw`
const fs = await import("node:fs/promises");
const params = JSON.parse(process.argv[1]);

function splitCmdline(raw) {
  return raw.split("\0").filter(Boolean);
}

const procDir = "/proc/" + params.pid;
const status = await fs.readFile(procDir + "/status", "utf8").catch(() => "");
if (!status) {
  console.log(JSON.stringify({
    pid: params.pid,
    signal: params.signal,
    sent: false,
    error: "process not found",
  }, null, 2));
  process.exit(1);
}

const name = /^Name:\s*(.+)$/m.exec(status)?.[1] ?? "";
const cmdline = splitCmdline(await fs.readFile(procDir + "/cmdline", "utf8").catch(() => ""));
process.kill(params.pid, "SIG" + params.signal);

console.log(JSON.stringify({
  pid: params.pid,
  signal: params.signal,
  sent: true,
  name,
  command: cmdline.length > 0 ? cmdline.join(" ") : name,
}, null, 2));
`;

  return [
    "set -eu",
    "node --input-type=module -e " +
      shQuote(nodeScript) +
      " " +
      shQuote(JSON.stringify({ pid, signal })),
  ].join("\n");
}

export function createProcessListTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "process_list",
    label: "process_list",
    description:
      "List processes inside the Sage VM as structured JSON, optionally filtered by query.",
    promptSnippet:
      "Inspect processes running inside the Sage VM without using ad hoc ps commands.",
    promptGuidelines: [
      "Use process_list to find running commands, hung jobs, or process IDs before signaling.",
      "Filter with query when looking for a specific command.",
    ],
    parameters: processListParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const vm = await vmProvider(ctx);
      const script = buildProcessListScript(params as ProcessListParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `process_list failed (${result.exitCode})`);
      }

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

export function createProcessSignalTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "process_signal",
    label: "process_signal",
    description:
      "Send TERM, KILL, INT, or HUP to a process inside the Sage VM. PID 1 is refused.",
    promptSnippet:
      "Signal a specific Sage VM process by PID after identifying it with process_list.",
    promptGuidelines: [
      "Use process_list first to identify the target PID.",
      "Prefer TERM before KILL unless immediate termination is required.",
    ],
    parameters: processSignalParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const vm = await vmProvider(ctx);
      const script = buildProcessSignalScript(params as ProcessSignalParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `process_signal failed (${result.exitCode})`);
      }

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

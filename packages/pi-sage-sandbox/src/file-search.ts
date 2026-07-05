import path from "node:path";

import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { GUEST_WORKSPACE } from "./config.js";
import { shQuote, toGuestPath } from "./paths.js";

type FileSearchParams = {
  mode: "tree" | "search";
  path?: string;
  query?: string;
  match?: "fuzzy" | "glob";
  type?: "any" | "file" | "directory";
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
};

const DEFAULT_TREE_DEPTH = 3;
const MAX_MAX_DEPTH = 25;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 1_000;

const fileSearchParameters = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["tree", "search"],
      description:
        "tree lists a bounded directory tree; search matches paths under the base path.",
    },
    path: {
      type: "string",
      description:
        "Workspace path to inspect. Defaults to /workspace. Relative paths are resolved under /workspace.",
    },
    query: {
      type: "string",
      description:
        "Search query. Required when mode=search. Interpreted according to match.",
    },
    match: {
      type: "string",
      enum: ["fuzzy", "glob"],
      description: "Search matching mode. Defaults to FFF fuzzy path search.",
    },
    type: {
      type: "string",
      enum: ["any", "file", "directory"],
      description: "Filter search/tree entries by type. Defaults to any.",
    },
    maxDepth: {
      type: "number",
      minimum: 0,
      maximum: MAX_MAX_DEPTH,
      description: `Maximum traversal depth for tree mode. Defaults to ${DEFAULT_TREE_DEPTH}.`,
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
      description: `Maximum entries to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
    },
    includeHidden: {
      type: "boolean",
      description:
        "Include dotfiles and dot-directories. Defaults to false, except the base path itself is always allowed.",
    },
  },
  required: ["mode"],
  additionalProperties: false,
};

function clampNumber(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.max(0, Math.min(Math.floor(value), maxValue));
}

export function resolveGuestBasePath(
  localCwd: string,
  rawPath: string | undefined,
): string {
  const value = rawPath?.trim();
  if (!value || value === ".") return GUEST_WORKSPACE;

  if (value === GUEST_WORKSPACE || value.startsWith(`${GUEST_WORKSPACE}/`)) {
    return value;
  }

  if (path.isAbsolute(value)) return toGuestPath(localCwd, value);

  const normalized = path.posix.normalize(`/${value}`).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return GUEST_WORKSPACE;
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`path escapes workspace: ${rawPath}`);
  }
  return path.posix.join(GUEST_WORKSPACE, normalized);
}

function buildFileSearchScript(
  localCwd: string,
  params: FileSearchParams,
): string {
  const mode = params.mode;
  if (mode !== "tree" && mode !== "search") {
    throw new Error(`unsupported file_search mode: ${String(mode)}`);
  }

  const basePath = resolveGuestBasePath(localCwd, params.path);
  const maxDepth = clampNumber(
    params.maxDepth,
    DEFAULT_TREE_DEPTH,
    MAX_MAX_DEPTH,
  );
  const maxResults = Math.max(
    1,
    clampNumber(params.maxResults, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS),
  );
  const query = params.query?.trim() ?? "";
  if (mode === "search" && !query) {
    throw new Error("file_search query is required when mode=search");
  }
  const args =
    mode === "tree"
      ? [
          "sage-fff",
          "--base",
          GUEST_WORKSPACE,
          "tree",
          "--path",
          basePath,
          "--max-depth",
          String(maxDepth),
          "--limit",
          String(maxResults),
          "--type",
          params.type ?? "any",
          ...(params.includeHidden === true ? ["--include-hidden"] : []),
        ]
      : [
          "sage-fff",
          "--base",
          GUEST_WORKSPACE,
          "find",
          "--query",
          query,
          "--path",
          guestConstraintPath(localCwd, params.path),
          "--mode",
          findMode(params),
          "--limit",
          String(maxResults),
        ];

  return [
    "set -eu",
    [
      "command -v sage-fff >/dev/null 2>&1 ||",
      "{ echo 'sage-fff is not installed in the Sage guest image; rebuild or reinstall the image.' >&2; exit 127; }",
    ].join(" "),
    args.map(shQuote).join(" "),
  ].join("\n");
}

function findMode(params: FileSearchParams): string {
  if (params.match === "glob" && params.type !== "directory") return "glob";
  if (params.type === "file") return "files";
  if (params.type === "directory") return "directories";
  return "mixed";
}

export function guestConstraintPath(
  localCwd: string,
  rawPath: string | undefined,
) {
  const guestPath = resolveGuestBasePath(localCwd, rawPath);
  if (guestPath === GUEST_WORKSPACE) return ".";
  if (guestPath.startsWith(`${GUEST_WORKSPACE}/`)) {
    return guestPath.slice(GUEST_WORKSPACE.length + 1);
  }
  return guestPath;
}

export function createFileSearchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
  localCwd: string,
): ToolDefinition {
  return {
    name: "file_search",
    label: "file_search",
    description:
      "Search workspace file paths or return a bounded directory tree through the Sage VM. Results are structured JSON.",
    promptSnippet:
      "Search workspace paths and inspect bounded directory trees without using host file tools.",
    promptGuidelines: [
      "Use mode=tree to inspect project layout before reading files.",
      "Use mode=search to find filenames or directories with FFF fuzzy search or glob search.",
      "Keep maxDepth and maxResults bounded; use follow-up searches for narrower areas.",
    ],
    parameters: fileSearchParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const vm = await vmProvider(ctx);
      const script = buildFileSearchScript(localCwd, params as FileSearchParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `file_search failed (${result.exitCode})`);
      }

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

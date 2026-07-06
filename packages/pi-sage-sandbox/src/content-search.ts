import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { GUEST_SCRATCH, GUEST_WORKSPACE } from "./config.js";
import { shQuote } from "./paths.js";
import { guestConstraintPath, resolveGuestBasePath } from "./file-search.js";

type ContentSearchParams = {
  query: string;
  path?: string;
  match?: "substring" | "regex";
  ignoreCase?: boolean;
  maxResults?: number;
  maxFileBytes?: number;
  contextLines?: number;
};

const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 10_000_000;
const MAX_MAX_FILE_BYTES = 50_000_000;
const MAX_CONTEXT_LINES = 5;

const contentSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Text or regular expression to search for inside files.",
    },
    path: {
      type: "string",
      description:
        "Workspace or scratch path to search. Defaults to /workspace. Relative paths are resolved under /workspace. Use /scratch for session scratch files.",
    },
    match: {
      type: "string",
      enum: ["substring", "regex"],
      description: "Content matching mode. Defaults to substring.",
    },
    ignoreCase: {
      type: "boolean",
      description:
        "Use smart-case matching when true. Defaults to true. Set false for case-sensitive matching.",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
      description: `Maximum matches to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
    },
    maxFileBytes: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_FILE_BYTES,
      description: `Skip files larger than this many bytes. Defaults to ${DEFAULT_MAX_FILE_BYTES}.`,
    },
    contextLines: {
      type: "number",
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description: `Include this many lines before and after each match. Defaults to 0; maximum ${MAX_CONTEXT_LINES}.`,
    },
  },
  required: ["query"],
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

function buildContentSearchScript(
  localCwd: string,
  params: ContentSearchParams,
): string {
  const query = params.query?.trim() ?? "";
  if (!query) throw new Error("content_search query is required");

  const maxResults = Math.max(
    1,
    clampNumber(params.maxResults, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS),
  );
  const maxFileBytes = Math.max(
    1,
    clampNumber(
      params.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      MAX_MAX_FILE_BYTES,
    ),
  );
  const contextLines = clampNumber(params.contextLines, 0, MAX_CONTEXT_LINES);
  const guestPath = resolveGuestBasePath(localCwd, params.path);
  const searchBase =
    guestPath === GUEST_SCRATCH || guestPath.startsWith(`${GUEST_SCRATCH}/`)
      ? GUEST_SCRATCH
      : GUEST_WORKSPACE;
  const args = [
    "sage-fff",
    "--base",
    searchBase,
    "grep",
    "--query",
    query,
    "--path",
    guestConstraintPath(localCwd, params.path, searchBase),
    "--mode",
    params.match === "regex" ? "regex" : "plain",
    "--limit",
    String(maxResults),
    "--smart-case",
    params.ignoreCase === false ? "false" : "true",
    "--max-file-bytes",
    String(maxFileBytes),
    "--context",
    String(contextLines),
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

export function createContentSearchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
  localCwd: string,
): ToolDefinition {
  return {
    name: "content_search",
    label: "content_search",
    description:
      "Search /workspace or /scratch file contents through the Sage VM. Results are structured JSON with path, line, column, and matched text.",
    promptSnippet:
      "Search /workspace or /scratch file contents without using host-side grep/find tools.",
    promptGuidelines: [
      "Use content_search for text searches across the workspace or a bounded subdirectory.",
      "Use path=/scratch to search session scratch artifacts.",
      "Narrow path and maxResults when possible.",
      "Use read after content_search when exact surrounding bytes are needed for editing.",
    ],
    parameters: contentSearchParameters as any,
    executionMode: "parallel",
    async execute(
      _id,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<undefined>> {
      const vm = await vmProvider(ctx);
      const script = buildContentSearchScript(
        localCwd,
        params as ContentSearchParams,
      );
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `content_search failed (${result.exitCode})`);
      }

      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: undefined,
      };
    },
  };
}

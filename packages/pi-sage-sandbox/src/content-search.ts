import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { shQuote } from "./paths.js";
import { resolveGuestBasePath } from "./file-search.js";

type ContentSearchParams = {
  query: string;
  path?: string;
  match?: "substring" | "regex";
  ignoreCase?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxResults?: number;
  maxFileBytes?: number;
  contextLines?: number;
};

const DEFAULT_MAX_DEPTH = 8;
const MAX_MAX_DEPTH = 25;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const MAX_MAX_FILE_BYTES = 5_000_000;
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
        "Workspace path to search. Defaults to /workspace. Relative paths are resolved under /workspace.",
    },
    match: {
      type: "string",
      enum: ["substring", "regex"],
      description: "Content matching mode. Defaults to substring.",
    },
    ignoreCase: {
      type: "boolean",
      description: "Match case-insensitively. Defaults to true.",
    },
    includeHidden: {
      type: "boolean",
      description:
        "Include dotfiles and dot-directories. Defaults to false, except the base path itself is always allowed.",
    },
    maxDepth: {
      type: "number",
      minimum: 0,
      maximum: MAX_MAX_DEPTH,
      description: `Maximum traversal depth. Defaults to ${DEFAULT_MAX_DEPTH}.`,
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

  const maxDepth = clampNumber(
    params.maxDepth,
    DEFAULT_MAX_DEPTH,
    MAX_MAX_DEPTH,
  );
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

  const nodeScript = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");

const params = JSON.parse(process.argv[1]);
const workspace = "/workspace";
const ignoredDirs = new Set([".git", "node_modules", ".hg", ".svn"]);
const ignoredFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function relativeName(fullPath) {
  const rel = path.posix.relative(workspace, toPosix(fullPath));
  return rel || ".";
}

function isHiddenName(name) {
  return name.startsWith(".") && name !== "." && name !== "..";
}

function shouldSkipDir(name) {
  if (ignoredDirs.has(name)) return true;
  return !params.includeHidden && isHiddenName(name);
}

function shouldSkipFile(name) {
  if (ignoredFiles.has(name)) return true;
  return !params.includeHidden && isHiddenName(name);
}

function makeMatcher() {
  if (params.match === "regex") {
    const flags = params.ignoreCase ? "iu" : "u";
    const re = new RegExp(params.query, flags);
    return (line) => {
      re.lastIndex = 0;
      const match = re.exec(line);
      return match ? { column: match.index + 1 } : null;
    };
  }

  const needle = params.ignoreCase ? params.query.toLowerCase() : params.query;
  return (line) => {
    const haystack = params.ignoreCase ? line.toLowerCase() : line;
    const index = haystack.indexOf(needle);
    return index === -1 ? null : { column: index + 1 };
  };
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function readSorted(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
}

async function searchFile(fullPath, matcher, results) {
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > params.maxFileBytes) return;

  const buffer = await fs.readFile(fullPath);
  if (looksBinary(buffer)) return;

  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const hit = matcher(lines[index]);
    if (!hit) continue;

    const beforeStart = Math.max(0, index - params.contextLines);
    const afterEnd = Math.min(lines.length, index + params.contextLines + 1);
    results.push({
      path: relativeName(fullPath),
      line: index + 1,
      column: hit.column,
      text: lines[index],
      before: params.contextLines ? lines.slice(beforeStart, index) : undefined,
      after: params.contextLines ? lines.slice(index + 1, afterEnd) : undefined,
    });
    if (results.length >= params.maxResults) return;
  }
}

async function walk(basePath) {
  const matcher = makeMatcher();
  const results = [];
  let truncated = false;

  async function visit(current, depth) {
    if (results.length >= params.maxResults) {
      truncated = true;
      return;
    }

    const stat = await fs.lstat(current);
    if (!stat.isDirectory()) {
      await searchFile(current, matcher, results);
      truncated = results.length >= params.maxResults;
      return;
    }

    let entries;
    try {
      entries = await readSorted(current);
    } catch (err) {
      results.push({
        path: relativeName(current),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const dirent of entries) {
      const fullPath = path.posix.join(toPosix(current), dirent.name);
      if (dirent.isDirectory()) {
        if (depth < params.maxDepth && !shouldSkipDir(dirent.name)) {
          await visit(fullPath, depth + 1);
        }
      } else if (dirent.isFile() && !shouldSkipFile(dirent.name)) {
        await searchFile(fullPath, matcher, results);
      }

      if (results.length >= params.maxResults) {
        truncated = true;
        return;
      }
    }
  }

  await visit(basePath, 0);
  return { results, truncated };
}

const { results, truncated } = await walk(params.basePath);
console.log(JSON.stringify({
  basePath: params.basePath,
  displayBasePath: relativeName(params.basePath),
  query: params.query,
  match: params.match,
  ignoreCase: params.ignoreCase,
  maxDepth: params.maxDepth,
  maxResults: params.maxResults,
  maxFileBytes: params.maxFileBytes,
  contextLines: params.contextLines,
  truncated,
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
          basePath: resolveGuestBasePath(localCwd, params.path),
          query,
          match: params.match ?? "substring",
          ignoreCase: params.ignoreCase !== false,
          includeHidden: params.includeHidden === true,
          maxDepth,
          maxResults,
          maxFileBytes,
          contextLines,
        }),
      ),
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
      "Search workspace file contents through the Sage VM. Results are structured JSON with path, line, column, and matched text.",
    promptSnippet:
      "Search file contents without using host-side grep/find tools.",
    promptGuidelines: [
      "Use content_search for text searches across the workspace or a bounded subdirectory.",
      "Narrow path, maxDepth, and maxResults when possible.",
      "Use read after content_search when exact surrounding bytes are needed for editing.",
    ],
    parameters: contentSearchParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
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

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

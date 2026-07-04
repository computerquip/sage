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
  match?: "substring" | "glob" | "regex";
  type?: "any" | "file" | "directory";
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
};

const DEFAULT_TREE_DEPTH = 3;
const DEFAULT_SEARCH_DEPTH = 8;
const MAX_MAX_DEPTH = 25;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 1_000;

const fileSearchParameters = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["tree", "search"],
      description: "tree lists a bounded directory tree; search matches paths under the base path.",
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
      enum: ["substring", "glob", "regex"],
      description: "Search matching mode. Defaults to substring.",
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
      description: `Maximum traversal depth. Defaults to ${DEFAULT_TREE_DEPTH} for tree and ${DEFAULT_SEARCH_DEPTH} for search.`,
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

function resolveGuestBasePath(localCwd: string, rawPath: string | undefined): string {
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
    mode === "tree" ? DEFAULT_TREE_DEPTH : DEFAULT_SEARCH_DEPTH,
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

  const nodeScript = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");

const params = JSON.parse(process.argv[1]);
const workspace = "/workspace";
const ignoredDirs = new Set([".git", "node_modules", ".hg", ".svn"]);

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

function entryType(dirent) {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

function typeAllowed(type) {
  return params.type === "any" || params.type === type;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(out, "i");
}

function makeMatcher() {
  if (params.mode !== "search") return () => true;
  if (params.match === "regex") {
    const re = new RegExp(params.query, "i");
    return (entry) => re.test(entry.path) || re.test(entry.name);
  }
  if (params.match === "glob") {
    const re = globToRegex(params.query);
    return (entry) => re.test(entry.path) || re.test(entry.name);
  }
  const needle = params.query.toLowerCase();
  return (entry) =>
    entry.path.toLowerCase().includes(needle) ||
    entry.name.toLowerCase().includes(needle);
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

async function walk(basePath) {
  const results = [];
  const matcher = makeMatcher();
  let truncated = false;

  async function visit(dir, depth) {
    if (results.length >= params.maxResults) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await readSorted(dir);
    } catch (err) {
      results.push({
        path: relativeName(dir),
        type: "error",
        depth,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const dirent of entries) {
      if (ignoredDirs.has(dirent.name)) continue;
      if (!params.includeHidden && isHiddenName(dirent.name)) continue;

      const fullPath = path.posix.join(toPosix(dir), dirent.name);
      const type = entryType(dirent);
      const entry = {
        path: relativeName(fullPath),
        name: dirent.name,
        type,
        depth,
      };

      if (typeAllowed(type) && matcher(entry)) {
        results.push(entry);
        if (results.length >= params.maxResults) {
          truncated = true;
          return;
        }
      }

      if (dirent.isDirectory() && depth < params.maxDepth && !shouldSkipDir(dirent.name)) {
        await visit(fullPath, depth + 1);
        if (results.length >= params.maxResults) return;
      }
    }
  }

  const stat = await fs.lstat(basePath);
  if (!stat.isDirectory()) {
    const entry = {
      path: relativeName(basePath),
      name: path.posix.basename(basePath),
      type: stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
      depth: 0,
    };
    return {
      results: typeAllowed(entry.type) && matcher(entry) ? [entry] : [],
      truncated: false,
    };
  }

  await visit(basePath, 0);
  return { results, truncated };
}

const { results, truncated } = await walk(params.basePath);
console.log(JSON.stringify({
  mode: params.mode,
  basePath: params.basePath,
  displayBasePath: relativeName(params.basePath),
  query: params.query || undefined,
  match: params.mode === "search" ? params.match : undefined,
  type: params.type,
  maxDepth: params.maxDepth,
  maxResults: params.maxResults,
  includeHidden: params.includeHidden,
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
          mode,
          basePath,
          query,
          match: params.match ?? "substring",
          type: params.type ?? "any",
          maxDepth,
          maxResults,
          includeHidden: params.includeHidden === true,
        }),
      ),
  ].join("\n");
}

export function createFileSearchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
  localCwd: string,
): ToolDefinition {
  return {
    name: "file_search",
    label: "file_search",
    description:
      "Search workspace files or return a bounded directory tree through the Sage VM. Results are structured JSON.",
    promptSnippet:
      "Search workspace paths and inspect bounded directory trees without using broad shell commands.",
    promptGuidelines: [
      "Use mode=tree to inspect project layout before reading files.",
      "Use mode=search to find filenames or directories by substring, glob, or regex.",
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

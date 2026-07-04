import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { shQuote } from "./paths.js";

type WebSearchParams = {
  query: string;
  maxResults?: number;
  site?: string;
  timeout?: number;
};

const DEFAULT_MAX_RESULTS = 8;
const MAX_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;

const webSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query.",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
      description: `Maximum search results to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
    },
    site: {
      type: "string",
      description:
        "Optional domain to restrict results to, equivalent to adding site:<domain> to the query.",
    },
    timeout: {
      type: "number",
      minimum: 1,
      maximum: MAX_TIMEOUT,
      description: `Request timeout in seconds. Defaults to ${DEFAULT_TIMEOUT}.`,
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
  return Math.max(1, Math.min(Math.floor(value), maxValue));
}

function normalizeSite(site: string | undefined): string | undefined {
  const trimmed = site?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9.-]+$/.test(trimmed)) {
    throw new Error(`invalid site: ${site}`);
  }
  return trimmed;
}

function buildSearchScript(params: WebSearchParams): string {
  const query = params.query.trim();
  if (!query) throw new Error("web_search query must not be empty");

  const site = normalizeSite(params.site);
  const fullQuery = site ? `${query} site:${site}` : query;
  const maxResults = clampNumber(
    params.maxResults,
    DEFAULT_MAX_RESULTS,
    MAX_MAX_RESULTS,
  );
  const timeout = clampNumber(params.timeout, DEFAULT_TIMEOUT, MAX_TIMEOUT);

  const nodeScript = String.raw`
const params = JSON.parse(process.argv[1]);
const searchUrl = new URL("https://html.duckduckgo.com/html/");
searchUrl.searchParams.set("q", params.query);

function decodeHtml(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, n) => named[n] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function resultUrl(rawHref) {
  const decoded = decodeHtml(rawHref);
  const url = new URL(decoded, "https://html.duckduckgo.com");
  const redirected = url.searchParams.get("uddg");
  return redirected ?? url.toString();
}

function resultBlocks(html) {
  const blocks = [];
  const re = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  for (const match of html.matchAll(re)) blocks.push(match[0]);
  return blocks;
}

function firstMatch(block, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(block);
    if (match) return match;
  }
  return null;
}

function parseResults(html, maxResults) {
  const results = [];
  const seen = new Set();

  for (const block of resultBlocks(html)) {
    const titleMatch = firstMatch(block, [
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
      /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    ]);
    if (!titleMatch) continue;

    const url = resultUrl(titleMatch[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const snippetMatch = firstMatch(block, [
      /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
      /<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ]);

    results.push({
      title: decodeHtml(titleMatch[2]),
      url,
      snippet: snippetMatch ? decodeHtml(snippetMatch[1]) : "",
    });

    if (results.length >= maxResults) break;
  }

  return results;
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), params.timeout * 1000);

try {
  const response = await fetch(searchUrl, {
    signal: controller.signal,
    headers: {
      "User-Agent": "sage-web-search/1.0",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  const html = await response.text();
  const results = parseResults(html, params.maxResults);
  console.log(JSON.stringify({
    query: params.originalQuery,
    effectiveQuery: params.query,
    source: "duckduckgo_html",
    status: response.status,
    results,
  }, null, 2));
} finally {
  clearTimeout(timeout);
}
`;

  return [
    "set -eu",
    "node --input-type=module -e " +
      shQuote(nodeScript) +
      " " +
      shQuote(
        JSON.stringify({
          originalQuery: query,
          query: fullQuery,
          maxResults,
          timeout,
        }),
      ),
  ].join("\n");
}

export function createWebSearchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web through the Sage VM network policy. Returns structured JSON search results with title, URL, and snippet.",
    promptSnippet:
      "Search the web for current docs, release notes, error messages, and other external references.",
    promptGuidelines: [
      "Use web_search when you need to discover relevant URLs before fetching them.",
      "Prefer specific queries; use site for domain-restricted searches.",
      "Use web_fetch on selected result URLs when exact page contents are needed.",
    ],
    parameters: webSearchParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const vm = await vmProvider(ctx);
      const script = buildSearchScript(params as WebSearchParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `web_search failed (${result.exitCode})`);
      }

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

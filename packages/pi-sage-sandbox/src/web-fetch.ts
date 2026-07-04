import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";

import { shQuote } from "./paths.js";

type WebFetchParams = {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeout?: number;
};

const DEFAULT_MAX_BYTES = 120_000;
const MAX_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;

const webFetchParameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "HTTP or HTTPS URL to fetch.",
    },
    method: {
      type: "string",
      enum: ["GET", "HEAD"],
      description: "HTTP method. Defaults to GET.",
    },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Optional request headers.",
    },
    maxBytes: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_BYTES,
      description: `Maximum response body bytes to return. Defaults to ${DEFAULT_MAX_BYTES}.`,
    },
    timeout: {
      type: "number",
      minimum: 1,
      maximum: MAX_TIMEOUT,
      description: `Request timeout in seconds. Defaults to ${DEFAULT_TIMEOUT}.`,
    },
  },
  required: ["url"],
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

function validateUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("web_fetch only supports http:// and https:// URLs");
  }
  return parsed;
}

function headerArgs(headers: Record<string, string> | undefined): string {
  if (!headers) return "";

  const args: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error(`invalid header name: ${name}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`invalid header value for ${name}: contains a newline`);
    }
    args.push("-H", `${name}: ${value}`);
  }
  return args.map(shQuote).join(" ");
}

function buildFetchScript(params: WebFetchParams): string {
  const parsedUrl = validateUrl(params.url);
  const method = params.method ?? "GET";
  const maxBytes = clampNumber(params.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const timeout = clampNumber(params.timeout, DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const headers = headerArgs(params.headers);
  const includeBody = method !== "HEAD";

  return [
    "set -eu",
    "tmp_dir=$(mktemp -d)",
    'trap \'rm -rf "$tmp_dir"\' EXIT HUP INT TERM',
    "headers_file=\"$tmp_dir/headers\"",
    "body_file=\"$tmp_dir/body\"",
    "curl_status=0",
    [
      "http_code=$(curl",
      "--location",
      "--silent",
      "--show-error",
      "--compressed",
      "--connect-timeout",
      shQuote(String(Math.min(timeout, 30))),
      "--max-time",
      shQuote(String(timeout)),
      "-X",
      shQuote(method),
      "-D",
      '"$headers_file"',
      "-o",
      '"$body_file"',
      "-w",
      shQuote("%{http_code}"),
      headers,
      shQuote(parsedUrl.toString()),
      ") || curl_status=$?",
    ].filter(Boolean).join(" "),
    'body_bytes=$(wc -c < "$body_file" | tr -d " ")',
    'printf "URL: %s\\n" ' + shQuote(parsedUrl.toString()),
    'printf "HTTP status: %s\\n" "$http_code"',
    'printf "Response bytes: %s\\n" "$body_bytes"',
    'if [ "$curl_status" -ne 0 ]; then printf "curl exit: %s\\n" "$curl_status"; fi',
    'printf "\\nHeaders:\\n"',
    'cat "$headers_file"',
    includeBody
      ? [
          'printf "\\nBody"',
          'if [ "$body_bytes" -gt ' + maxBytes + ' ]; then',
          '  printf " (truncated to ' + maxBytes + ' bytes)"',
          "fi",
          'printf ":\\n"',
          "head -c " + maxBytes + ' "$body_file"',
          'if [ "$body_bytes" -gt ' + maxBytes + ' ]; then',
          '  printf "\\n\\n[truncated: showing first ' + maxBytes + ' of %s bytes]\\n" "$body_bytes"',
          "fi",
        ].join("\n")
      : 'printf "\\nBody: omitted for HEAD request\\n"',
    'if [ "$curl_status" -ne 0 ]; then exit "$curl_status"; fi',
  ].join("\n");
}

export function createWebFetchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch an HTTP or HTTPS URL through the Sage VM network policy. Returns response metadata, headers, and a truncated response body.",
    promptSnippet:
      "Fetch HTTP/HTTPS URLs for docs, release notes, API metadata, and other web resources.",
    promptGuidelines: [
      "Use web_fetch when current external information or a URL's contents are needed.",
      "Prefer targeted URLs and keep maxBytes modest; use follow-up fetches for larger pages.",
    ],
    parameters: webFetchParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const vm = await vmProvider(ctx);
      const script = buildFetchScript(params as WebFetchParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `web_fetch failed (${result.exitCode})`);
      }

      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  };
}

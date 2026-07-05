import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import { shQuote } from "./paths.js";

type WebFetchParams = {
  url: string;
  method?: "GET" | "HEAD";
  format?: "auto" | "markdown" | "raw";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeout?: number;
};

type FetchResponse = {
  url: string;
  httpStatus: string;
  curlStatus: number;
  headers: string;
  bodyBase64: string;
  bodyBytes: number;
  shownBytes: number;
  truncated: boolean;
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
    format: {
      type: "string",
      enum: ["auto", "markdown", "raw"],
      description:
        "Response rendering mode. auto converts HTML pages to readable Markdown and returns raw text for other content. Defaults to auto.",
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
      description: `Maximum response body bytes to process and return. Defaults to ${DEFAULT_MAX_BYTES}.`,
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
  const emitJsonScript = String.raw`
const fs = await import("node:fs/promises");

const payload = {
  url: process.argv[1],
  httpStatus: process.argv[2],
  curlStatus: Number(process.argv[3]),
  headers: await fs.readFile(process.argv[4], "utf8").catch(() => ""),
  bodyBase64: "",
  bodyBytes: Number(process.argv[6]),
  shownBytes: 0,
  truncated: process.argv[7] === "true",
};

if (process.argv[8] === "true") {
  const body = await fs.readFile(process.argv[5]).catch(() => Buffer.alloc(0));
  payload.bodyBase64 = body.toString("base64");
  payload.shownBytes = body.length;
}

console.log(JSON.stringify(payload));
`;

  return [
    "set -eu",
    "tmp_dir=$(mktemp -d)",
    'trap \'rm -rf "$tmp_dir"\' EXIT HUP INT TERM',
    "headers_file=\"$tmp_dir/headers\"",
    "body_file=\"$tmp_dir/body\"",
    "shown_body_file=\"$tmp_dir/body.shown\"",
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
    includeBody
      ? [
          "head -c " + maxBytes + ' "$body_file" > "$shown_body_file"',
          'if [ "$body_bytes" -gt ' + maxBytes + ' ]; then',
          "  truncated=true",
          "else",
          "  truncated=false",
          "fi",
        ].join("\n")
      : 'truncated=false\n: > "$shown_body_file"',
    "node --input-type=module -e " +
      shQuote(emitJsonScript) +
      " " +
      [
        shQuote(parsedUrl.toString()),
        '"$http_code"',
        '"$curl_status"',
        '"$headers_file"',
        '"$shown_body_file"',
        '"$body_bytes"',
        '"$truncated"',
        includeBody ? "true" : "false",
      ].join(" "),
    'if [ "$curl_status" -ne 0 ]; then exit "$curl_status"; fi',
  ].join("\n");
}

function lastHeaderBlock(headers: string): string {
  return headers
    .replace(/\r\n/g, "\n")
    .split(/\n(?=HTTP\/[0-9.]+ \d+)/)
    .filter((block) => block.trim())
    .pop() ?? headers;
}

function headerValue(headers: string, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const line of lastHeaderBlock(headers).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === lowerName) {
      return line.slice(idx + 1).trim();
    }
  }
  return undefined;
}

function isProbablyText(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return (
    /^text\//i.test(contentType) ||
    /\b(json|xml|javascript|x-www-form-urlencoded)\b/i.test(contentType)
  );
}

function isHtml(contentType: string | undefined, url: string): boolean {
  if (contentType && /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    return true;
  }
  return /\.html?(?:[?#]|$)/i.test(url);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function decodeBody(response: FetchResponse): string {
  return Buffer.from(response.bodyBase64, "base64").toString("utf8");
}

function renderMarkdown(response: FetchResponse, body: string, maxBytes: number): string {
  const dom = new JSDOM(body, { url: response.url });
  const article = new Readability(dom.window.document).parse();
  const turndown = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });

  const html = article?.content || dom.window.document.body?.innerHTML || body;
  const markdown = turndown.turndown(html).trim();
  const title = article?.title || dom.window.document.title || response.url;
  const parts = [`# ${title}`];

  if (article?.byline) parts.push(`By ${article.byline}`);
  if (article?.excerpt) parts.push(article.excerpt);
  parts.push(markdown || "(no readable body)");

  const rendered = parts.join("\n\n");
  const truncated = truncateUtf8(rendered, maxBytes);
  return [
    "Readable Markdown:",
    truncated.text,
    truncated.truncated
      ? `\n[truncated: showing first ${maxBytes} bytes of readable Markdown]`
      : "",
  ].join("\n");
}

function renderRaw(response: FetchResponse, body: string, maxBytes: number): string {
  const rendered = truncateUtf8(body, maxBytes);
  return [
    "Body:",
    rendered.text || "(empty body)",
    response.truncated || rendered.truncated
      ? `\n[truncated: showing first ${Math.min(response.shownBytes, maxBytes)} of ${response.bodyBytes} response bytes]`
      : "",
  ].join("\n");
}

function renderFetchResponse(response: FetchResponse, params: WebFetchParams): string {
  const maxBytes = clampNumber(params.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const format = params.format ?? "auto";
  const contentType = headerValue(response.headers, "content-type");
  const body = decodeBody(response);
  const metadata = [
    `URL: ${response.url}`,
    `HTTP status: ${response.httpStatus}`,
    `Response bytes: ${response.bodyBytes}`,
    `Returned body bytes: ${response.shownBytes}`,
    contentType ? `Content-Type: ${contentType}` : undefined,
    response.curlStatus !== 0 ? `curl exit: ${response.curlStatus}` : undefined,
  ].filter(Boolean);

  if (!body) {
    return [
      metadata.join("\n"),
      "",
      "Headers:",
      response.headers.trim(),
      "",
      "Body: omitted or empty",
    ].join("\n");
  }

  let renderedBody: string;
  if (format !== "raw" && isHtml(contentType, response.url)) {
    try {
      renderedBody = renderMarkdown(response, body, maxBytes);
    } catch (err) {
      renderedBody = [
        `Readable Markdown: failed (${err instanceof Error ? err.message : String(err)})`,
        renderRaw(response, body, maxBytes),
      ].join("\n\n");
    }
  } else if (isProbablyText(contentType)) {
    renderedBody = renderRaw(response, body, maxBytes);
  } else {
    renderedBody = "Body: binary or unsupported content type; omitted";
  }

  return [
    metadata.join("\n"),
    "",
    "Headers:",
    response.headers.trim(),
    "",
    renderedBody,
  ].join("\n");
}

export function createWebFetchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch an HTTP or HTTPS URL through the Sage VM network policy. HTML pages are converted to readable Markdown with Mozilla Readability and Turndown.",
    promptSnippet:
      "Fetch HTTP/HTTPS URLs for docs, release notes, API metadata, and other web resources.",
    promptGuidelines: [
      "Use web_fetch when current external information or a URL's contents are needed.",
      "Prefer targeted URLs and keep maxBytes modest; use format=raw when exact response text is needed.",
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

      const response = JSON.parse(result.stdout) as FetchResponse;
      return {
        content: [
          {
            type: "text",
            text: renderFetchResponse(response, params as WebFetchParams),
          },
        ],
      };
    },
  };
}

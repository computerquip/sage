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
  engine?: "auto" | "crawl4ai" | "curl";
  format?: "auto" | "markdown" | "raw";
  headers?: Record<string, string>;
  cssSelector?: string;
  waitFor?: string;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  scanFullPage?: boolean;
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

type Crawl4AiResponse = {
  engine: "crawl4ai";
  url: string;
  finalUrl?: string;
  statusCode?: number;
  success: boolean;
  error?: string;
  markdown: string;
  htmlBytes?: number;
  links?: { internal?: number; external?: number };
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
    engine: {
      type: "string",
      enum: ["auto", "crawl4ai", "curl"],
      description:
        "Fetch engine. auto uses the reliable curl path by default. crawl4ai uses browser-rendered extraction when the VM has enough memory. curl preserves exact HTTP response text. Defaults to auto.",
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
    cssSelector: {
      type: "string",
      description:
        "Optional CSS selector for crawl4ai to focus extraction on a page region.",
    },
    waitFor: {
      type: "string",
      description:
        "Optional crawl4ai wait condition, such as css:.content or js:() => window.ready === true.",
    },
    waitUntil: {
      type: "string",
      enum: ["domcontentloaded", "load", "networkidle"],
      description:
        "Browser navigation readiness condition for crawl4ai. Defaults to domcontentloaded.",
    },
    scanFullPage: {
      type: "boolean",
      description:
        "Whether crawl4ai should scroll through the full page before extracting content. Defaults to false.",
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

function buildCurlFetchScript(params: WebFetchParams): string {
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

function buildCrawl4AiScript(params: WebFetchParams): string {
  const parsedUrl = validateUrl(params.url);
  const timeout = clampNumber(params.timeout, DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const maxBytes = clampNumber(params.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const payload = {
    url: parsedUrl.toString(),
    headers: params.headers ?? {},
    cssSelector: params.cssSelector,
    waitFor: params.waitFor,
    waitUntil: params.waitUntil ?? "domcontentloaded",
    scanFullPage: params.scanFullPage === true,
    timeoutMs: timeout * 1000,
    maxMarkdownBytes: maxBytes,
  };
  const pythonScript = String.raw`
import asyncio
import inspect
import json
import os
import sys

params = json.loads(sys.argv[1])

def filtered(cls, values):
    sig = inspect.signature(cls)
    return {key: value for key, value in values.items() if key in sig.parameters and value is not None}

def markdown_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    for attr in ("fit_markdown", "raw_markdown", "markdown"):
        item = getattr(value, attr, None)
        if isinstance(item, str) and item.strip():
            return item
    return str(value)

def truncate_utf8(value, max_bytes):
    data = value.encode("utf-8")
    if len(data) <= max_bytes:
        return value
    return data[:max_bytes].decode("utf-8", "ignore")

async def main():
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
    from crawl4ai.browser_manager import BrowserManager
    try:
        from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    except ImportError:
        from crawl4ai import DefaultMarkdownGenerator
    try:
        from crawl4ai.content_filter_strategy import PruningContentFilter
    except ImportError:
        from crawl4ai import PruningContentFilter

    original_build_browser_args = BrowserManager._build_browser_args

    def build_browser_args_with_system_chromium(self):
        browser_args = original_build_browser_args(self)
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
        if executable:
            browser_args.pop("channel", None)
            browser_args["executable_path"] = executable
        return browser_args

    BrowserManager._build_browser_args = build_browser_args_with_system_chromium

    browser_config = BrowserConfig(**filtered(BrowserConfig, {
        "browser_type": "chromium",
        "headless": True,
        "text_mode": True,
        "light_mode": True,
        "avoid_ads": True,
        "avoid_css": False,
        "verbose": False,
        "headers": params["headers"] or None,
        "extra_args": [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
        ],
    }))

    markdown_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(
            threshold=0.5,
            threshold_type="fixed",
            min_word_threshold=20,
        ),
        options={
            "body_width": 0,
            "ignore_images": True,
            "skip_internal_links": True,
        },
    )

    run_config = CrawlerRunConfig(**filtered(CrawlerRunConfig, {
        "markdown_generator": markdown_generator,
        "cache_mode": CacheMode.BYPASS,
        "word_count_threshold": 5,
        "css_selector": params.get("cssSelector"),
        "wait_for": params.get("waitFor"),
        "wait_until": params.get("waitUntil"),
        "page_timeout": params["timeoutMs"],
        "scan_full_page": params.get("scanFullPage", False),
        "remove_overlay_elements": True,
        "process_iframes": True,
        "exclude_social_media_links": True,
        "exclude_external_images": True,
        "verbose": False,
    }))

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=params["url"], config=run_config)

    links = getattr(result, "links", None) or {}
    html = getattr(result, "html", "") or ""
    output = {
        "engine": "crawl4ai",
        "url": params["url"],
        "finalUrl": getattr(result, "url", None),
        "statusCode": getattr(result, "status_code", None),
        "success": bool(getattr(result, "success", False)),
        "error": getattr(result, "error_message", None),
        "markdown": truncate_utf8(markdown_text(getattr(result, "markdown", "")), params["maxMarkdownBytes"]),
        "htmlBytes": len(html.encode("utf-8")),
        "links": {
            "internal": len(links.get("internal", []) or []),
            "external": len(links.get("external", []) or []),
        },
    }
    print(json.dumps(output))

asyncio.run(main())
`;

  return [
    "set -eu",
    "export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}",
    "export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium-browser}",
    "export CRAWL4AI_HOME=${CRAWL4AI_HOME:-/tmp/crawl4ai}",
    "python3 - " + shQuote(JSON.stringify(payload)) + " <<'PY'",
    pythonScript,
    "PY",
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

function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    return JSON.parse(line) as T;
  }
  return JSON.parse(trimmed) as T;
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

function renderCrawl4AiResponse(response: Crawl4AiResponse, params: WebFetchParams): string {
  const maxBytes = clampNumber(params.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const markdown = truncateUtf8(response.markdown || "", maxBytes);
  const metadata = [
    `URL: ${response.url}`,
    response.finalUrl && response.finalUrl !== response.url ? `Final URL: ${response.finalUrl}` : undefined,
    response.statusCode !== undefined ? `HTTP status: ${response.statusCode}` : undefined,
    `Fetch engine: ${response.engine}`,
    `Crawl success: ${response.success}`,
    response.htmlBytes !== undefined ? `HTML bytes: ${response.htmlBytes}` : undefined,
    response.links ? `Links: ${response.links.internal ?? 0} internal, ${response.links.external ?? 0} external` : undefined,
    response.error ? `Crawl error: ${response.error}` : undefined,
  ].filter(Boolean);

  return [
    metadata.join("\n"),
    "",
    "Crawl4AI Markdown:",
    markdown.text || "(no readable body)",
    markdown.truncated ? `\n[truncated: showing first ${maxBytes} bytes of Crawl4AI Markdown]` : "",
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

function shouldUseCrawl4Ai(params: WebFetchParams): boolean {
  const engine = params.engine ?? "auto";
  const format = params.format ?? "auto";
  const method = params.method ?? "GET";
  if (engine === "curl") return false;
  if (method !== "GET" || format === "raw") return false;
  return engine === "crawl4ai" || process.env.SAGE_WEB_FETCH_AUTO_CRAWL4AI === "1";
}

export function createWebFetchTool(
  vmProvider: (ctx?: ExtensionContext) => Promise<VM>,
): ToolDefinition {
  return {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch an HTTP or HTTPS URL through the Sage VM network policy. HTML pages are converted with curl plus Mozilla Readability/Turndown by default; engine=crawl4ai uses browser-rendered extraction when needed.",
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
      const fetchParams = params as WebFetchParams;
      const engine = fetchParams.engine ?? "auto";

      if ((fetchParams.method ?? "GET") === "HEAD" && engine === "crawl4ai") {
        throw new Error("web_fetch engine=crawl4ai only supports GET; use engine=curl for HEAD");
      }

      if ((fetchParams.format ?? "auto") === "raw" && engine === "crawl4ai") {
        throw new Error("web_fetch engine=crawl4ai does not provide exact raw response text; use engine=curl for format=raw");
      }

      if (shouldUseCrawl4Ai(fetchParams)) {
        const script = buildCrawl4AiScript(fetchParams);
        const result = await vm.exec(["/bin/bash", "-lc", script], { signal });
        if (result.ok) {
          const response = parseJsonOutput<Crawl4AiResponse>(result.stdout);
          if (response.success || response.markdown) {
            return {
              content: [
                {
                  type: "text",
                  text: renderCrawl4AiResponse(response, fetchParams),
                },
              ],
            };
          }
        }

        if (engine === "crawl4ai") {
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
          throw new Error(output || `web_fetch crawl4ai failed (${result.exitCode})`);
        }
      }

      const script = buildCurlFetchScript(fetchParams);
      const result = await vm.exec(["/bin/bash", "-lc", script], { signal });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (!result.ok) {
        throw new Error(output || `web_fetch failed (${result.exitCode})`);
      }

      const response = parseJsonOutput<FetchResponse>(result.stdout);
      return {
        content: [
          {
            type: "text",
            text: renderFetchResponse(response, fetchParams),
          },
        ],
      };
    },
  };
}

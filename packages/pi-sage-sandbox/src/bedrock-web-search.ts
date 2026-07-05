import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  resolveBedrockAgentCoreAccessToken,
  resolveBedrockAgentCoreClientId,
  resolveBedrockAgentCoreClientSecret,
  resolveBedrockAgentCoreGatewayUrl,
  resolveBedrockAgentCoreTokenEndpoint,
  resolveBedrockAgentCoreWebSearchToolName,
} from "./config.js";

type BedrockWebSearchParams = {
  query: string;
  maxResults?: number;
  timeout?: number;
};

type AccessTokenCache = {
  token: string;
  expiresAt: number;
};

const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 25;
const DEFAULT_TIMEOUT = 25;
const MAX_TIMEOUT = 60;

let tokenCache: AccessTokenCache | undefined;

const bedrockWebSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Web search query. Amazon Bedrock AgentCore accepts up to 200 characters.",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
      description: `Maximum search results to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
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

function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/g, " ");
  if (!query) throw new Error("web_search query must not be empty");
  if (query.length > 200) {
    throw new Error("web_search query must be 200 characters or fewer for Bedrock AgentCore Web Search");
  }
  return query;
}

async function getClientCredentialsToken(
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const tokenEndpoint = resolveBedrockAgentCoreTokenEndpoint();
  const clientId = resolveBedrockAgentCoreClientId();
  const clientSecret = resolveBedrockAgentCoreClientSecret();
  if (!tokenEndpoint || !clientId || !clientSecret) return undefined;

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AgentCore token request failed (${response.status}): ${text}`);
  }

  const json = JSON.parse(text);
  if (!json.access_token || typeof json.access_token !== "string") {
    throw new Error("AgentCore token response did not include access_token");
  }

  const expiresIn =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
      ? json.expires_in
      : 3600;
  tokenCache = {
    token: json.access_token,
    expiresAt: now + expiresIn * 1000,
  };
  return tokenCache.token;
}

async function resolveAccessToken(signal: AbortSignal | undefined): Promise<string> {
  const direct = resolveBedrockAgentCoreAccessToken();
  if (direct) return direct;

  const fromClientCredentials = await getClientCredentialsToken(signal);
  if (fromClientCredentials) return fromClientCredentials;

  throw new Error(
    "Bedrock AgentCore web search is not configured. Set SAGE_BEDROCK_AGENTCORE_GATEWAY_URL plus either SAGE_BEDROCK_AGENTCORE_ACCESS_TOKEN or SAGE_BEDROCK_AGENTCORE_TOKEN_ENDPOINT/SAGE_BEDROCK_AGENTCORE_CLIENT_ID/SAGE_BEDROCK_AGENTCORE_CLIENT_SECRET.",
  );
}

function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const json = JSON.parse(trimmed);
  if (json.error) {
    throw new Error(`AgentCore MCP error: ${JSON.stringify(json.error)}`);
  }
  const content = json.result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
}

function parseMcpResponse(body: string): string {
  const direct = parseMcpPayload(body);
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = parseMcpPayload(line.slice(6));
    if (parsed) return parsed;
  }

  throw new Error("AgentCore MCP response did not include text content");
}

function renderSearchText(text: string): string {
  try {
    const json = JSON.parse(text);
    return JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

async function callBedrockWebSearch(
  params: BedrockWebSearchParams,
  signal: AbortSignal | undefined,
): Promise<string> {
  const gatewayUrl = resolveBedrockAgentCoreGatewayUrl();
  if (!gatewayUrl) {
    throw new Error("Bedrock AgentCore web search is not configured. Set SAGE_BEDROCK_AGENTCORE_GATEWAY_URL.");
  }

  const token = await resolveAccessToken(signal);
  const query = normalizeQuery(params.query);
  const maxResults = clampNumber(
    params.maxResults,
    DEFAULT_MAX_RESULTS,
    MAX_MAX_RESULTS,
  );
  const timeout = clampNumber(params.timeout, DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sage-web-search",
        method: "tools/call",
        params: {
          name: resolveBedrockAgentCoreWebSearchToolName(),
          arguments: { query, maxResults },
        },
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`AgentCore web search failed (${response.status}): ${body}`);
    }

    return renderSearchText(parseMcpResponse(body));
  } finally {
    clearTimeout(timer);
  }
}

export function createBedrockWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the live web through Amazon Bedrock AgentCore Web Search. Requires a configured AgentCore Gateway Web Search connector.",
    promptSnippet:
      "Search the web for current docs, release notes, recent events, and other external references.",
    promptGuidelines: [
      "Use web_search when you need to discover current sources or URLs.",
      "Use web_fetch on selected result URLs when exact page contents are needed.",
      "Keep queries specific and under 200 characters.",
    ],
    parameters: bedrockWebSearchParameters as any,
    executionMode: "parallel",
    async execute(_id, params, signal): Promise<AgentToolResult> {
      const text = await callBedrockWebSearch(
        params as BedrockWebSearchParams,
        signal,
      );
      return { content: [{ type: "text", text }] };
    },
  };
}

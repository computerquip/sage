import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EmbeddingModel, ExecutionProvider, FlagEmbedding } from "fastembed";
import type { Memory as Mem0Memory, MemoryConfig } from "mem0ai/oss";

const DEFAULT_EMBED_MODEL = EmbeddingModel.BGESmallENV15;
const DEFAULT_EMBED_DIMENSION = 384;
const DEFAULT_EMBED_MAX_LENGTH = 512;
const DEFAULT_EMBED_BATCH_SIZE = 64;

type Scope = "global" | "session";

type MemoryRuntime = {
  memory: Mem0Memory;
  details: MemoryDetails;
};

type MemoryDetails = {
  embedModel: string;
  fastEmbedModel: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
  dimension: number;
  dbPath: string;
  fastEmbedCacheDir: string;
  historyDbPath: string;
};

type LangchainEmbeddingsLike = {
  batchSize: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
};

type LangchainMessageLike = {
  role?: string;
  content?: unknown;
  _getType?: () => string;
};

type LangchainModelLike = {
  modelId: string;
  invoke(messages: LangchainMessageLike[], options?: Record<string, unknown>): Promise<{
    content: string;
  }>;
};

type FastEmbedRuntime = {
  key: string;
  model: FlagEmbedding;
};

let runtime: MemoryRuntime | undefined;
let runtimeKey: string | undefined;
let fastEmbedRuntime: Promise<FastEmbedRuntime> | undefined;

process.env.MEM0_TELEMETRY = "false";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolEnv(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name] ?? "");
}

function numberEnv(name: string, fallback: number): number {
  const value = env(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function defaultCacheDir(): string {
  if (env("SAGE_CACHE_DIR")) return env("SAGE_CACHE_DIR")!;
  if (env("XDG_CACHE_HOME")) return path.join(env("XDG_CACHE_HOME")!, "sage");
  if (env("HOME")) return path.join(env("HOME")!, ".cache", "sage");
  return path.join(os.tmpdir(), "sage");
}

function memoryDir(): string {
  return path.resolve(env("SAGE_MEMORY_DIR") ?? path.join(defaultCacheDir(), "memory"));
}

function fastEmbedCacheDir(): string {
  return path.resolve(
    env("SAGE_MEMORY_FASTEMBED_CACHE_DIR") ??
      path.join(defaultCacheDir(), "memory", "fastembed"),
  );
}

function memoryScope(scope: Scope | undefined) {
  const userId = env("SAGE_MEMORY_USER_ID") ?? env("USER") ?? "default";
  const agentId = env("SAGE_MEMORY_AGENT_ID") ?? "sage";
  const result: { userId: string; agentId: string; runId?: string } = {
    userId,
    agentId,
  };
  if (scope === "session") {
    const runId = env("SAGE_SESSION_NAME");
    if (!runId) {
      throw new Error("scope=session requires SAGE_SESSION_NAME.");
    }
    result.runId = runId;
  }
  return result;
}

function searchFilters(scope: Scope | undefined) {
  const scoped = memoryScope(scope);
  return {
    user_id: scoped.userId,
    agent_id: scoped.agentId,
    ...(scoped.runId ? { run_id: scoped.runId } : {}),
  };
}

function modelCacheKey(ctx?: ExtensionContext): string {
  const model = ctx?.model;
  if (!model) return "none";
  return `${model.provider}/${model.id}/${model.api}`;
}

function runtimeCacheKey(ctx?: ExtensionContext): string {
  return JSON.stringify({
    memoryDir: memoryDir(),
    embedModel: env("SAGE_MEMORY_EMBED_MODEL"),
    embedDimension: env("SAGE_MEMORY_EMBED_DIMENSION"),
    fastEmbedCacheDir: fastEmbedCacheDir(),
    model: modelCacheKey(ctx),
  });
}

function fastEmbedModel(model: string): Exclude<EmbeddingModel, EmbeddingModel.CUSTOM> {
  switch (model) {
    case "fast-all-MiniLM-L6-v2":
    case "all-MiniLM-L6-v2":
    case "sentence-transformers/all-MiniLM-L6-v2":
      return EmbeddingModel.AllMiniLML6V2;
    case "fast-bge-small-en-v1.5":
    case "bge-small-en-v1.5":
    case "BAAI/bge-small-en-v1.5":
      return EmbeddingModel.BGESmallENV15;
    case "fast-bge-small-en":
    case "bge-small-en":
    case "BAAI/bge-small-en":
      return EmbeddingModel.BGESmallEN;
    case "fast-bge-base-en":
    case "bge-base-en":
    case "BAAI/bge-base-en":
      return EmbeddingModel.BGEBaseEN;
    case "fast-bge-base-en-v1.5":
    case "bge-base-en-v1.5":
    case "BAAI/bge-base-en-v1.5":
      return EmbeddingModel.BGEBaseENV15;
    default:
      throw new Error(
        `Unsupported SAGE_MEMORY_EMBED_MODEL: ${model}. ` +
          "Use BAAI/bge-small-en-v1.5, sentence-transformers/all-MiniLM-L6-v2, " +
          "or another model supported by fastembed-js and mapped by Sage.",
      );
  }
}

function memoryDetails(): MemoryDetails {
  const dir = memoryDir();
  const embedModel = env("SAGE_MEMORY_EMBED_MODEL") ?? DEFAULT_EMBED_MODEL;
  return {
    dbPath: path.join(dir, "vectors.db"),
    historyDbPath: path.join(dir, "history.db"),
    fastEmbedCacheDir: fastEmbedCacheDir(),
    embedModel,
    fastEmbedModel: fastEmbedModel(embedModel),
    dimension: numberEnv("SAGE_MEMORY_EMBED_DIMENSION", DEFAULT_EMBED_DIMENSION),
  };
}

function langchainRole(message: LangchainMessageLike): "system" | "user" | "assistant" {
  const role = message.role ?? message._getType?.() ?? "user";
  switch (role.toLowerCase()) {
    case "system":
      return "system";
    case "assistant":
    case "ai":
      return "assistant";
    case "human":
    case "user":
    default:
      return "user";
  }
}

function langchainContent(message: LangchainMessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

function piContextFromLangchain(messages: LangchainMessageLike[]): Context {
  let systemPrompt: string | undefined;
  const piMessages: Context["messages"] = [];

  for (const message of messages) {
    const role = langchainRole(message);
    const content = langchainContent(message);
    if (role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${content}` : content;
      continue;
    }
    if (role === "assistant") {
      piMessages.push({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-completions",
        provider: "sage-memory",
        model: "previous-assistant",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    piMessages.push({ role: "user", content, timestamp: Date.now() });
  }

  return { systemPrompt, messages: piMessages };
}

function assistantText(message: Awaited<ReturnType<typeof completeSimple>>): string {
  const parts = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
  return parts.join("");
}

async function resolvePiModelAuth(ctx: ExtensionContext, model: Model<Api>) {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Cannot use ${model.provider}/${model.id} for memory inference: ${auth.error}`);
  }
  return auth;
}

async function preflightInferenceModel(ctx?: ExtensionContext): Promise<Model<Api>> {
  const model = ctx?.model as Model<Api> | undefined;
  if (!ctx || !model) {
    throw new Error("memory_add infer=true requires an active Pi model.");
  }
  await resolvePiModelAuth(ctx, model);
  return model;
}

function piLangchainModel(ctx?: ExtensionContext): LangchainModelLike {
  const modelName = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-active-model";
  return {
    modelId: `sage-memory/${modelName}`,
    async invoke(messages, options = {}) {
      const model = await preflightInferenceModel(ctx);
      const auth = await resolvePiModelAuth(ctx!, model);
      const responseFormat = options.response_format
        ? { response_format: options.response_format }
        : {};
      const response = await completeSimple(model, piContextFromLangchain(messages), {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: ctx?.signal,
        maxTokens: numberEnv("SAGE_MEMORY_LLM_MAX_TOKENS", 2048),
        ...responseFormat,
      } as any);
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Pi model ${model.provider}/${model.id} failed.`);
      }
      return { content: assistantText(response) };
    },
  };
}

async function getFastEmbedRuntime(details: MemoryDetails): Promise<FastEmbedRuntime> {
  const key = JSON.stringify({
    model: details.fastEmbedModel,
    cacheDir: details.fastEmbedCacheDir,
  });
  if (!fastEmbedRuntime) {
    fs.mkdirSync(details.fastEmbedCacheDir, { recursive: true });
    fastEmbedRuntime = FlagEmbedding.init({
      model: details.fastEmbedModel,
      executionProviders: [ExecutionProvider.CPU],
      maxLength: DEFAULT_EMBED_MAX_LENGTH,
      cacheDir: details.fastEmbedCacheDir,
      showDownloadProgress: false,
    })
      .then((model) => ({ key, model }))
      .catch((error) => {
        fastEmbedRuntime = undefined;
        throw error;
      });
  }
  const current = await fastEmbedRuntime;
  if (current.key === key) return current;

  fastEmbedRuntime = undefined;
  return getFastEmbedRuntime(details);
}

function fastEmbedLangchainModel(details: MemoryDetails): LangchainEmbeddingsLike {
  return {
    batchSize: DEFAULT_EMBED_BATCH_SIZE,
    async embedQuery(text: string) {
      const { model } = await getFastEmbedRuntime(details);
      return model.queryEmbed(text);
    },
    async embedDocuments(texts: string[]) {
      const { model } = await getFastEmbedRuntime(details);
      const embeddings: number[][] = [];
      for await (const batch of model.passageEmbed(texts, DEFAULT_EMBED_BATCH_SIZE)) {
        embeddings.push(...batch);
      }
      return embeddings;
    },
  };
}

async function createRuntime(ctx?: ExtensionContext): Promise<MemoryRuntime> {
  const { Memory } = await import("mem0ai/oss");
  const details = memoryDetails();
  fs.mkdirSync(path.dirname(details.dbPath), { recursive: true });

  const config: Partial<MemoryConfig> = {
    embedder: {
      provider: "langchain",
      config: {
        model: fastEmbedLangchainModel(details),
        embeddingDims: details.dimension,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        dbPath: details.dbPath,
        collectionName: "sage",
        dimension: details.dimension,
      },
    },
    llm: {
      provider: "langchain",
      config: {
        model: piLangchainModel(ctx),
      },
    },
    historyStore: {
      provider: "sqlite",
      config: { historyDbPath: details.historyDbPath },
    },
  };

  return {
    memory: new Memory(config),
    details,
  };
}

async function getRuntime(_ctx?: ExtensionContext): Promise<MemoryRuntime> {
  if (boolEnv("SAGE_MEMORY_DISABLE")) {
    throw new Error("Sage durable memory is disabled by SAGE_MEMORY_DISABLE.");
  }
  const key = runtimeCacheKey(_ctx);
  if (!runtime || runtimeKey !== key) {
    runtime = await createRuntime(_ctx);
    runtimeKey = key;
  }
  return runtime;
}

function ok(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function fail(error: unknown): AgentToolResult<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Sage memory error: ${message}` }],
    details: { error: message },
  };
}

function formatResults(results: Array<{ id: string; memory: string; score?: number }>) {
  if (results.length === 0) return "No matching memories.";
  return results
    .map((item, index) => {
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      return `${index + 1}. ${item.id}${score}\n${item.memory}`;
    })
    .join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description:
      "Show Sage durable memory storage and local embedder configuration.",
    promptSnippet: "Check Sage durable memory configuration and local embedder status.",
    promptGuidelines: [
      "Use memory_status when memory tools report local FastEmbed or model configuration errors.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        if (boolEnv("SAGE_MEMORY_DISABLE")) {
          throw new Error("Sage durable memory is disabled by SAGE_MEMORY_DISABLE.");
        }
        const details = memoryDetails();
        const scope = memoryScope(undefined);
        const model = ctx?.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "none selected";
        return ok(
          [
            "provider: local",
            `embedder: fastembed/${details.embedModel}`,
            `dimension: ${details.dimension}`,
            `llm: ${model} (for memory_add infer=true)`,
            `vector_db: ${details.dbPath}`,
            `history_db: ${details.historyDbPath}`,
            `model_cache: ${details.fastEmbedCacheDir}`,
            `scope: user=${scope.userId} agent=${scope.agentId}`,
          ].join("\n"),
          { embedder: "fastembed", ...details, scope },
        );
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description:
      "Store a durable Sage memory fact or preference for future sessions.",
    promptSnippet:
      "Store stable user preferences, project facts, or workflow decisions in durable memory.",
    promptGuidelines: [
      "Only store information likely to be useful in future sessions.",
      "Do not store secrets, credentials, private keys, or one-off transient command output.",
      "Use scope=global for durable cross-session memory unless the user explicitly wants session-local memory.",
    ],
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Fact or preference to remember." },
        scope: {
          type: "string",
          enum: ["global", "session"],
          description: "Memory scope. Defaults to global.",
        },
        infer: {
          type: "boolean",
          description:
            "Infer concise memories with an LLM. Disabled by Sage; defaults to false.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Optional metadata stored with the memory.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      try {
        const rt = await getRuntime(ctx);
        const scope = (params.scope ?? "global") as Scope;
        const infer = params.infer ?? false;
        if (infer) {
          await preflightInferenceModel(ctx);
        }
        const result = await rt.memory.add(params.text, {
          ...memoryScope(scope),
          infer,
          metadata: params.metadata,
        });
        return ok(formatResults(result.results), result);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search Sage durable memory for relevant facts or preferences.",
    promptSnippet:
      "Search durable memory for relevant user preferences, project facts, and prior decisions.",
    promptGuidelines: [
      "Use memory_search when a request may depend on prior user preferences or durable project context.",
      "Prefer focused queries over broad queries.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        scope: {
          type: "string",
          enum: ["global", "session"],
          description: "Memory scope. Defaults to global.",
        },
        topK: {
          type: "number",
          description: "Maximum results. Defaults to 5.",
        },
        threshold: {
          type: "number",
          description: "Minimum score from 0 to 1. Defaults to Mem0's default.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      try {
        const rt = await getRuntime(ctx);
        const scope = (params.scope ?? "global") as Scope;
        const result = await rt.memory.search(params.query, {
          filters: searchFilters(scope),
          topK: params.topK ?? 5,
          threshold: params.threshold,
        });
        return ok(formatResults(result.results), result);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description: "Retrieve one durable Sage memory by ID.",
    promptSnippet: "Retrieve an exact durable memory by ID after memory_search.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID." },
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      try {
        const rt = await getRuntime(ctx);
        const item = await rt.memory.get(params.id);
        if (!item) return ok(`Memory not found: ${params.id}`);
        return ok(`${item.id}\n${item.memory}`, item);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete one durable Sage memory by ID.",
    promptSnippet: "Delete a durable memory by ID when it is wrong or obsolete.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID." },
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      try {
        const rt = await getRuntime(ctx);
        const result = await rt.memory.delete(params.id);
        return ok(result.message, result);
      } catch (error) {
        return fail(error);
      }
    },
  });
}

const CONTEXT_SIZES = new Set(["low", "medium", "high"]);

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function isProviderWebSearchDisabled() {
  const value = process.env.SAGE_PROVIDER_WEB_SEARCH?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "no";
}

function isOpenAIResponsesPayload(payload) {
  return (
    typeof payload.model === "string" &&
    Array.isArray(payload.input) &&
    payload.stream === true &&
    !("modelId" in payload)
  );
}

function hasOpenAIWebSearchTool(tools) {
  return (
    Array.isArray(tools) &&
    tools.some((tool) => asObject(tool)?.type === "web_search")
  );
}

function withoutSageWebSearchFunction(tools) {
  return tools.filter((tool) => {
    const objectTool = asObject(tool);
    return !(
      objectTool?.type === "function" &&
      objectTool.name === "web_search"
    );
  });
}

function createOpenAIWebSearchTool() {
  const tool = { type: "web_search" };
  const contextSize = process.env.SAGE_OPENAI_WEB_SEARCH_CONTEXT?.trim();

  if (contextSize && CONTEXT_SIZES.has(contextSize)) {
    tool.search_context_size = contextSize;
  }

  return tool;
}

export function addProviderWebSearch(payload) {
  if (isProviderWebSearchDisabled()) return undefined;

  const objectPayload = asObject(payload);
  if (!objectPayload || !isOpenAIResponsesPayload(objectPayload)) {
    return undefined;
  }

  const tools = Array.isArray(objectPayload.tools) ? objectPayload.tools : [];
  if (hasOpenAIWebSearchTool(tools)) return undefined;

  return {
    ...objectPayload,
    tools: [...withoutSageWebSearchFunction(tools), createOpenAIWebSearchTool()],
  };
}

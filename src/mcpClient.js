const crypto = require("crypto");
const { config } = require("./config");
const { fetchText } = require("./http");

const toolsCache = new Map();

function tokenCacheKey(accessToken) {
  return crypto.createHash("sha256").update(accessToken).digest("hex");
}

function getCached(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function setCached(map, key, value) {
  map.set(key, { value, expiresAt: Date.now() + config.cacheTtlMs });
}

function parseMcpResponse(text) {
  if (text.includes("data:")) {
    const jsonPayloads = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    for (const payload of jsonPayloads) {
      try {
        return JSON.parse(payload);
      } catch {
        // Keep looking; SSE streams can include non-JSON events.
      }
    }

    throw new Error(`Could not extract JSON from MCP SSE response: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

async function callMcpMethod(method, params, accessToken, options = {}) {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: params || {}
  };
  const { trace } = options;
  const startedAt = Date.now();
  await trace?.("mcp.method.start", { method });

  let response;
  let text;
  try {
    ({ response, text } = await fetchText(
      config.pbiMcpUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(body)
      },
      config.requestTimeoutMs
    ));
  } catch (error) {
    await trace?.("mcp.method.fetch_error", { method, durationMs: Date.now() - startedAt }, error);
    throw error;
  }
  await trace?.("mcp.method.http", {
    method,
    status: response.status,
    ok: response.ok,
    responseBytes: text.length,
    durationMs: Date.now() - startedAt
  });

  if (!response.ok) {
    const error = new Error(`MCP ${response.status}: ${text.slice(0, 300)}`);
    await trace?.("mcp.method.error", { method, durationMs: Date.now() - startedAt }, error);
    throw error;
  }

  let json;
  try {
    json = parseMcpResponse(text);
  } catch (error) {
    await trace?.("mcp.method.parse_error", { method, durationMs: Date.now() - startedAt }, error);
    throw new Error(`MCP parse failed: ${error.message}`);
  }

  if (json.error) {
    const error = new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);
    await trace?.("mcp.method.error", { method, durationMs: Date.now() - startedAt }, error);
    throw error;
  }

  await trace?.("mcp.method.done", { method, durationMs: Date.now() - startedAt });
  return json.result;
}

async function listMcpTools(accessToken, options = {}) {
  const cacheKey = tokenCacheKey(accessToken);
  if (!options.refresh) {
    const cached = getCached(toolsCache, cacheKey);
    if (cached) {
      await options.trace?.("mcp.tools.cache_hit", { count: cached.length });
      return cached;
    }
  }

  const result = await callMcpMethod("tools/list", {}, accessToken, { trace: options.trace });
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  setCached(toolsCache, cacheKey, tools);
  await options.trace?.("mcp.tools.loaded", { count: tools.length });
  return tools;
}

async function executeMcpTool(name, args, accessToken, options = {}) {
  return callMcpMethod("tools/call", {
    name,
    arguments: args || {}
  }, accessToken, { trace: options.trace });
}

function mcpToolToOpenAiTool(mcpTool) {
  return {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description || "",
      parameters: mcpTool.inputSchema || { type: "object", properties: {} }
    }
  };
}

module.exports = {
  callMcpMethod,
  executeMcpTool,
  listMcpTools,
  mcpToolToOpenAiTool,
  parseMcpResponse
};

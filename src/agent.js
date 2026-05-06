const OpenAI = require("openai");
const { config } = require("./config");
const { discoverSemanticModels, catalogToPromptText } = require("./powerbiCatalog");
const { executeMcpTool, listMcpTools, mcpToolToOpenAiTool } = require("./mcpClient");

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl || undefined
});

function buildSystemPrompt(catalog) {
  return `You are a senior analytics assistant connected to the user's Power BI workspace.

You have access to Power BI MCP tools. Use them to retrieve semantic model schemas, generate DAX when helpful, and execute queries against the user's real data.

Response rules:
- Use concise plain prose.
- Use simple dash lists or numbered lines when a list helps.
- Never invent figures. Always fetch real data before stating numbers.
- State the time period and source semantic model when giving metrics.
- If a query fails, correct it and retry automatically when enough context exists.
- Prefer schema discovery before writing DAX if the model structure is unclear.

Trend reporting:
- When the user asks for current performance, compare against the equivalent prior period when possible.
- If prior period data is unavailable, say so briefly.

Chart rendering:
- When the user asks for a chart, trend, graph, or visual and the result has chartable data, append one raw JSON line at the end.
- The line must start with CHART_JSON: followed by valid JSON.
- Use this shape: CHART_JSON:{"type":"line","title":"...","labels":["..."],"datasets":[{"label":"...","data":[1]}]}
- Supported chart types are line, bar, and pie.` + catalogToPromptText(catalog);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));
}

function parseToolArguments(rawArguments) {
  if (!rawArguments) return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return {};
  }
}

async function runAgentTurn({ message, history = [], accessToken, onToken = () => {} }) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  console.log(`[agent] discovering catalog`);
  const catalog = await discoverSemanticModels(accessToken).catch((error) => ({
    semanticModels: [],
    catalogError: error.message
  }));

  console.log(`[agent] loading MCP tools`);
  const mcpTools = await listMcpTools(accessToken).catch((error) => {
    console.error("[tools] Failed to load Power BI MCP tools:", error.message);
    return [];
  });

  const tools = mcpTools.map(mcpToolToOpenAiTool);
  const messages = [
    { role: "system", content: buildSystemPrompt(catalog) },
    ...normalizeHistory(history),
    { role: "user", content: message }
  ];

  const usage = { prompt: 0, completion: 0, total: 0, iterations: 0 };
  const startedAt = Date.now();

  for (let iteration = 0; iteration < config.maxAgentIterations; iteration += 1) {
    usage.iterations += 1;
    console.log(`[agent] iteration ${iteration + 1}, messages=${messages.length}, tools=${tools.length}`);

    const response = await openai.chat.completions.create({
      model: config.llmModel,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      stream: false
    });

    if (response.usage) {
      usage.prompt += response.usage.prompt_tokens || 0;
      usage.completion += response.usage.completion_tokens || 0;
      usage.total += response.usage.total_tokens || 0;
    }

    const assistantMessage = response.choices?.[0]?.message;
    if (!assistantMessage) {
      throw new Error("LLM returned no message.");
    }

    messages.push(assistantMessage);
    console.log(`[agent] iteration ${iteration + 1} tool_calls=${assistantMessage.tool_calls?.length || 0}`);

    if (!assistantMessage.tool_calls?.length) {
      const text = assistantMessage.content || "";
      await onToken(text);
      return {
        text,
        usage,
        elapsedMs: Date.now() - startedAt,
        catalog,
        tools: mcpTools.map((tool) => tool.name)
      };
    }

    const toolResultMessages = [];
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function?.name;
      const toolArgs = parseToolArguments(toolCall.function?.arguments);

      let content;
      try {
        const result = await executeMcpTool(toolName, toolArgs, accessToken);
        content = JSON.stringify(result);
      } catch (error) {
        content = `Error calling ${toolName}: ${error.message}`;
      }

      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content
      });
    }

    messages.push(...toolResultMessages);
  }

  const text = "I reached the maximum number of reasoning steps. Please try narrowing the question.";
  await onToken(text);
  return {
    text,
    usage,
    elapsedMs: Date.now() - startedAt,
    catalog,
    tools: mcpTools.map((tool) => tool.name),
    maxIterationsReached: true
  };
}

module.exports = { runAgentTurn };

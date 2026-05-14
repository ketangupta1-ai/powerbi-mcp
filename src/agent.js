const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { config } = require("./config");
const { discoverSemanticModels, catalogToPromptText } = require("./powerbiCatalog");
const { executeMcpTool, listMcpTools, mcpToolToOpenAiTool } = require("./mcpClient");

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl || undefined
});

function buildSystemPrompt(catalog) {
  let instructions = "";
  try {
    const skillPath = path.join(process.cwd(), "SKILL.md");
    instructions = fs.readFileSync(skillPath, "utf8");
  } catch (error) {
    console.error("[agent] Failed to read SKILL.md, using fallback instructions", error.message);
    instructions = "You are a senior analytics assistant connected to the user's Power BI workspace.";
  }

  return instructions + "\n\n" + catalogToPromptText(catalog);
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

async function runAgentTurn({ message, history = [], accessToken, onToken = () => {}, trace = null }) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  console.log(`[agent] discovering catalog`);
  await trace?.("agent.catalog.start");
  const catalogStartedAt = Date.now();
  const catalog = await discoverSemanticModels(accessToken).catch(async (error) => {
    await trace?.("agent.catalog.error", { durationMs: Date.now() - catalogStartedAt }, error);
    return {
      semanticModels: [],
      catalogError: error.message
    };
  });
  await trace?.("agent.catalog.done", {
    durationMs: Date.now() - catalogStartedAt,
    workspaceCount: catalog.workspaces?.length || 0,
    semanticModelCount: catalog.semanticModels?.filter((model) => model.datasetId).length || 0,
    hasError: !!catalog.catalogError
  });

  console.log(`[agent] loading MCP tools`);
  await trace?.("agent.tools.start");
  const toolsStartedAt = Date.now();
  const mcpTools = await listMcpTools(accessToken, { trace }).catch(async (error) => {
    console.error("[tools] Failed to load Power BI MCP tools:", error.message);
    await trace?.("agent.tools.error", { durationMs: Date.now() - toolsStartedAt }, error);
    return [];
  });
  await trace?.("agent.tools.done", {
    durationMs: Date.now() - toolsStartedAt,
    count: mcpTools.length,
    names: mcpTools.map((tool) => tool.name)
  });

  const tools = mcpTools.map(mcpToolToOpenAiTool);
  const systemPrompt = buildSystemPrompt(catalog);
  const messages = [
    { role: "system", content: systemPrompt },
    ...normalizeHistory(history),
    { role: "user", content: message }
  ];

  const usage = { prompt: 0, completion: 0, total: 0, iterations: 0 };
  const startedAt = Date.now();
  let rawLlmResponse = null;

  for (let iteration = 0; iteration < config.maxAgentIterations; iteration += 1) {
    usage.iterations += 1;
    console.log(`[agent] iteration ${iteration + 1}, messages=${messages.length}, tools=${tools.length}`);
    await trace?.("agent.llm.start", {
      iteration: iteration + 1,
      model: config.llmModel,
      messageCount: messages.length,
      toolCount: tools.length
    });
    const llmStartedAt = Date.now();

    let response;
    try {
      response = await openai.chat.completions.create({
        model: config.llmModel,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        stream: false
      });
    } catch (error) {
      await trace?.("agent.llm.error", {
        iteration: iteration + 1,
        durationMs: Date.now() - llmStartedAt
      }, error);
      throw error;
    }
    rawLlmResponse = response;

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
    await trace?.("agent.llm.done", {
      iteration: iteration + 1,
      durationMs: Date.now() - llmStartedAt,
      toolCallCount: assistantMessage.tool_calls?.length || 0,
      contentLength: assistantMessage.content?.length || 0,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens || 0,
            completionTokens: response.usage.completion_tokens || 0,
            totalTokens: response.usage.total_tokens || 0
          }
        : null
    });

    if (!assistantMessage.tool_calls?.length) {
      const text = assistantMessage.content || "";
      await trace?.("agent.final_answer", { contentLength: text.length });
      await onToken(text);
      return {
        text,
        assistantResponse: text,
        systemPrompt,
        rawLlmResponse,
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
      const toolStartedAt = Date.now();
      try {
        await trace?.("agent.tool.start", {
          iteration: iteration + 1,
          toolName,
          argumentKeys: Object.keys(toolArgs)
        });
        const result = await executeMcpTool(toolName, toolArgs, accessToken, { trace });
        content = JSON.stringify(result);
        await trace?.("agent.tool.done", {
          iteration: iteration + 1,
          toolName,
          resultBytes: content.length,
          durationMs: Date.now() - toolStartedAt
        });
      } catch (error) {
        content = `Error calling ${toolName}: ${error.message}`;
        await trace?.("agent.tool.error", {
          iteration: iteration + 1,
          toolName,
          durationMs: Date.now() - toolStartedAt
        }, error);
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
  await trace?.("agent.max_iterations", {
    maxAgentIterations: config.maxAgentIterations,
    elapsedMs: Date.now() - startedAt
  });
  await onToken(text);
  return {
    text,
    assistantResponse: text,
    systemPrompt,
    rawLlmResponse,
    usage,
    elapsedMs: Date.now() - startedAt,
    catalog,
    tools: mcpTools.map((tool) => tool.name),
    maxIterationsReached: true
  };
}

module.exports = { runAgentTurn };

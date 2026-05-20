const fs = require("fs/promises");
const path = require("path");

const usageLogPath = path.join(__dirname, "..", "logs", "usage.jsonl");
const readableUsageLogPath = path.join(__dirname, "..", "logs", "usage-readable.log");

function normalizeUsage(usage) {
  return {
    promptTokens: usage?.prompt || 0,
    completionTokens: usage?.completion || 0,
    totalTokens: usage?.total || 0,
    cachedTokens: usage?.cached || 0,
    iterations: usage?.iterations || 0
  };
}

function calculateCost(promptTokens, completionTokens, cachedTokens = 0) {
  const nonCachedPrompt = Math.max(0, promptTokens - cachedTokens);
  // Input: $2.50 per 1M tokens ($0.0000025 / token)
  // Input Cached: $0.25 per 1M tokens ($0.00000025 / token)
  // Output: $15.00 per 1M tokens ($0.000015 / token)
  const cost = (nonCachedPrompt * 2.50 + cachedTokens * 0.25 + completionTokens * 15.00) / 1000000;
  return Number(cost.toFixed(8));
}

async function appendUsageLog({
  requestId,
  modelUsed,
  userMessage,
  assistantResponse,
  systemPrompt,
  rawLlmResponse,
  usage,
  finalQuery = null,
  responseTimeMs = null
}) {
  const normUsage = normalizeUsage(usage);
  const costUsd = calculateCost(normUsage.promptTokens, normUsage.completionTokens, normUsage.cachedTokens);

  const payload = {
    timestamp: new Date().toISOString(),
    requestId,
    modelUsed,
    userMessage,
    assistantResponse,
    responseTimeMs,
    costUsd,
    ...normUsage
  };

  await fs.mkdir(path.dirname(usageLogPath), { recursive: true });
  await fs.appendFile(usageLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.appendFile(readableUsageLogPath, formatReadableUsage(payload), "utf8");
  return payload;
}

function formatReadableUsage(payload) {
  return [
    "================================================================================",
    `Timestamp        : ${payload.timestamp}`,
    `Request ID       : ${payload.requestId}`,
    `Model Used       : ${payload.modelUsed || ""}`,
    `Response Time    : ${payload.responseTimeMs !== null ? payload.responseTimeMs + " ms" : "N/A"}`,
    `Prompt Tokens    : ${payload.promptTokens} (Cached: ${payload.cachedTokens || 0})`,
    `Completion Tokens: ${payload.completionTokens}`,
    `Total Tokens     : ${payload.totalTokens}`,
    `Cost (GPT-5.4)   : $${payload.costUsd.toFixed(8)}`,
    `Iterations       : ${payload.iterations}`,
    "",
    "User Message",
    "------------",
    payload.userMessage || "",
    "",
    "Assistant Response",
    "------------------",
    payload.assistantResponse || "",
    "",
    ""
  ].join("\n");
}

module.exports = { appendUsageLog, normalizeUsage, formatReadableUsage };

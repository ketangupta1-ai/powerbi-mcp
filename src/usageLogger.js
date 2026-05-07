const fs = require("fs/promises");
const path = require("path");

const usageLogPath = path.join(__dirname, "..", "logs", "usage.jsonl");
const readableUsageLogPath = path.join(__dirname, "..", "logs", "usage-readable.log");

function normalizeUsage(usage) {
  return {
    promptTokens: usage?.prompt || 0,
    completionTokens: usage?.completion || 0,
    totalTokens: usage?.total || 0,
    iterations: usage?.iterations || 0
  };
}

async function appendUsageLog({
  requestId,
  userMessage,
  assistantResponse,
  systemPrompt,
  rawLlmResponse,
  usage
}) {
  const payload = {
    timestamp: new Date().toISOString(),
    requestId,
    userMessage,
    assistantResponse,
    systemPrompt,
    rawLlmResponse,
    ...normalizeUsage(usage)
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
    `Prompt Tokens    : ${payload.promptTokens}`,
    `Completion Tokens: ${payload.completionTokens}`,
    `Total Tokens     : ${payload.totalTokens}`,
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
    "System Prompt",
    "-------------",
    payload.systemPrompt || "",
    "",
    "Raw LLM Response",
    "----------------",
    JSON.stringify(payload.rawLlmResponse || null, null, 2),
    "",
    ""
  ].join("\n");
}

module.exports = { appendUsageLog, normalizeUsage };

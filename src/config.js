const dotenv = require("dotenv");

dotenv.config();

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const config = {
  port: readInteger("PORT", 3101),
  host: process.env.HOST || "127.0.0.1",
  nodeEnv: process.env.NODE_ENV || "development",
  internalApiKey: process.env.INTERNAL_API_KEY || "",
  basicAuthUser: process.env.BASIC_AUTH_USER || "",
  basicAuthPassword: process.env.BASIC_AUTH_PASSWORD || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  llmModel: process.env.LLM_MODEL || "openai/gpt-4o",
  pbiMcpUrl: process.env.PBI_MCP_URL || "https://api.fabric.microsoft.com/v1/mcp/powerbi",
  msClientId: process.env.MS_CLIENT_ID || "",
  msClientSecret: process.env.MS_CLIENT_SECRET || "",
  msTenantId: process.env.MS_TENANT_ID || "common",
  msAdminUsername: process.env.MS_ADMIN_USERNAME || "",
  msAdminPassword: process.env.MS_ADMIN_PASSWORD || "",
  msRedirectUri: process.env.MS_REDIRECT_URI || "http://localhost:3000/auth/callback",
  frontendBaseUrl: process.env.FRONTEND_BASE_URL || "http://localhost:3000",
  maxAgentIterations: readInteger("MAX_AGENT_ITERATIONS", 8),
  cacheTtlMs: readInteger("MCP_CACHE_TTL_MS", 5 * 60 * 1000),
  requestTimeoutMs: readInteger("REQUEST_TIMEOUT_MS", 120 * 1000),
  allowedReportsFile: "allowed_reports.json"
};

module.exports = { config };

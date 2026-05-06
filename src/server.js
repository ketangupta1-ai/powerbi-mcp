const express = require("express");
const crypto = require("crypto");
const { config } = require("./config");
const { runAgentTurn } = require("./agent");
const { callMcpMethod, executeMcpTool, listMcpTools } = require("./mcpClient");
const { discoverSemanticModels } = require("./powerbiCatalog");
const { requireInternalCaller, requirePowerBiToken } = require("./security");
const {
  buildLoginUrl,
  clearSession,
  decodeUserName,
  exchangeCodeForTokens,
  getOauthState,
  getSession,
  getValidSessionToken,
  setOauthState,
  setSession
} = require("./sessionStore");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "powerbi-mcp",
    model: config.llmModel,
    mcpUrl: config.pbiMcpUrl,
    uptimeSeconds: Math.round(process.uptime())
  });
});

function isAuthConfigured() {
  return !!(config.msClientId && config.msClientSecret);
}

function wantsJson(req) {
  return (req.get("accept") || "").includes("application/json");
}

function createSessionTokenMiddleware() {
  return async (req, res, next) => {
    try {
      const { accessToken } = await getValidSessionToken(req);
      req.powerBiAccessToken = accessToken;
      return next();
    } catch (error) {
      return res.status(401).json({
        error: "Not authenticated. Please sign in.",
        needsAuth: true
      });
    }
  };
}

function registerAuthRoutes(router) {
  router.get("/auth/status", (req, res) => {
    const session = getSession(req);
    res.json({
      authenticated: !!session?.accessToken,
      userName: session?.userName || null,
      configured: isAuthConfigured()
    });
  });

  router.get("/auth/login", (req, res) => {
    if (!config.msClientId) {
      return res.status(500).send("MS_CLIENT_ID is not configured.");
    }

    const state = crypto.randomBytes(16).toString("hex");
    setOauthState(res, state);
    return res.redirect(buildLoginUrl(state));
  });

  router.get("/auth/callback", async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    if (error) {
      return res
        .status(400)
        .send(`Auth error: ${error}. ${errorDescription || ""}`);
    }

    if (!code || getOauthState(req) !== state) {
      return res.status(400).send("Invalid OAuth state. Please try signing in again.");
    }

    try {
      const tokens = await exchangeCodeForTokens(code);
      setSession(res, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
        userName: decodeUserName(tokens.id_token)
      });
      res.clearCookie("oauth_state");
      return res.redirect("/Power_BI_Analyst");
    } catch (callbackError) {
      return res.status(500).send(`Auth failed: ${callbackError.message}`);
    }
  });

  router.get("/auth/logout", (req, res) => {
    clearSession(req, res);
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect("/Power_BI_Analyst");
  });
}

function registerPowerBiRoutes(router, tokenMiddleware) {
  router.post("/mcp/tools", tokenMiddleware, async (req, res, next) => {
    try {
      const tools = await listMcpTools(req.powerBiAccessToken, { refresh: !!req.body?.refresh });
      res.json({ tools });
    } catch (error) {
      next(error);
    }
  });

  router.post("/mcp/call", tokenMiddleware, async (req, res, next) => {
    try {
      const { method, params, name, arguments: args } = req.body || {};
      if (method) {
        const result = await callMcpMethod(method, params || {}, req.powerBiAccessToken);
        return res.json({ result });
      }

      if (!name) {
        return res.status(400).json({ error: "Provide either method or tool name." });
      }

      const result = await executeMcpTool(name, args || {}, req.powerBiAccessToken);
      return res.json({ result });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/powerbi/catalog", tokenMiddleware, async (req, res, next) => {
    try {
      const catalog = await discoverSemanticModels(req.powerBiAccessToken, {
        refresh: !!req.body?.refresh
      });
      res.json(catalog);
    } catch (error) {
      next(error);
    }
  });

  router.post("/chat/json", tokenMiddleware, async (req, res, next) => {
    try {
      const { message, history } = req.body || {};
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message is required." });
      }

      const result = await runAgentTurn({
        message,
        history,
        accessToken: req.powerBiAccessToken
      });

      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/chat", tokenMiddleware, async (req, res) => {
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      await runAgentTurn({
        message,
        history,
        accessToken: req.powerBiAccessToken,
        onToken: async (text) => {
          for (const part of text.split(/(\s+)/)) {
            if (!part) continue;
            res.write(`data: ${JSON.stringify({ token: part })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      });

      res.write("data: [DONE]\n\n");
    } catch (error) {
      const needsAuth = /401|403|unauthorized|forbidden/i.test(error.message);
      res.write(`data: ${JSON.stringify({ error: error.message, needsAuth })}\n\n`);
    } finally {
      res.end();
    }
  });
}

const internal = express.Router();
internal.use(requireInternalCaller);
registerPowerBiRoutes(internal, requirePowerBiToken);

app.use("/internal", internal);

const api = express.Router();
api.use(requireInternalCaller);
registerAuthRoutes(api);
registerPowerBiRoutes(api, createSessionTokenMiddleware());
app.use("/api", api);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, next) => {
  const status = /401|unauthorized/i.test(error.message) ? 401 : 500;
  const payload = { error: error.message };
  if (config.nodeEnv !== "production") payload.stack = error.stack;
  res.status(status).json(payload);
});

app.listen(config.port, config.host, () => {
  console.log(`powerbi-mcp listening on http://${config.host}:${config.port}`);
  console.log(`model: ${config.llmModel}`);
  console.log(`mcp: ${config.pbiMcpUrl}`);
  if (!config.internalApiKey) {
    console.warn("INTERNAL_API_KEY is not set; internal routes are unprotected.");
  }
  if (!config.openaiApiKey) {
    console.warn("OPENAI_API_KEY is not set; chat endpoints will fail until configured.");
  }
});

const express = require("express");
const crypto = require("crypto");
const { config } = require("./config");
const { runAgentTurn } = require("./agent");
const { callMcpMethod, executeMcpTool, listMcpTools } = require("./mcpClient");
const { discoverSemanticModels } = require("./powerbiCatalog");
const { requireInternalCaller, requirePowerBiToken } = require("./security");
const { createTraceLogger } = require("./traceLogger");
const { appendUsageLog, normalizeUsage } = require("./usageLogger");
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

function powerBiAnalystPageUrl() {
  return new URL("/power_BI_Analyst", config.frontendBaseUrl).toString();
}

function authRequestDetails(req) {
  return {
    host: req.get("host") || "",
    xForwardedHost: req.get("x-forwarded-host") || "",
    xForwardedProto: req.get("x-forwarded-proto") || "",
    origin: req.get("origin") || "",
    referer: req.get("referer") || "",
    originalUrl: req.originalUrl || req.url
  };
}

function logAuthRedirect(req, event, details) {
  console.log(`[${event}] redirect ${JSON.stringify({ ...authRequestDetails(req), ...details })}`);
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
    // If service account is configured, we consider it "configured" and "authenticated" if we can get a token.
    if (config.msAdminUsername && config.msAdminPassword) {
      return res.json({
        authenticated: true, // We auto-authenticate
        userName: config.msAdminUsername,
        configured: true,
        mode: "service-account"
      });
    }

    const session = getSession(req);
    console.log(`[auth/status] authenticated=${!!session?.accessToken} configured=${isAuthConfigured()}`);
    res.json({
      authenticated: !!session?.accessToken,
      userName: session?.userName || null,
      configured: isAuthConfigured(),
      mode: "delegated"
    });
  });

  router.get("/auth/login", async (req, res) => {
    // Silent Service Account Login
    if (config.msAdminUsername && config.msAdminPassword) {
      try {
        await getValidSessionToken(req);
        // We set a dummy local session to ensure the frontend 'sid' cookie is set
        setSession(res, { 
          accessToken: "service-account-active",
          userName: config.msAdminUsername 
        });
        const redirectUrl = powerBiAnalystPageUrl();
        console.log(`[auth/login] silent service account login successful, redirecting to ${redirectUrl}`);
        return res.redirect(redirectUrl);
      } catch (error) {
        console.error(`[auth/login] silent login failed: ${error.message}`);
        return res.status(500).send(`Silent login failed: ${error.message}`);
      }
    }

    if (!config.msClientId) {
      return res.status(500).send("MS_CLIENT_ID is not configured.");
    }

    const state = crypto.randomBytes(16).toString("hex");
    setOauthState(res, state);
    const loginUrl = buildLoginUrl(state);
    const loginRedirectUri = new URL(loginUrl).searchParams.get("redirect_uri") || config.msRedirectUri;
    logAuthRedirect(req, "auth/login", {
      to: "microsoft",
      msRedirectUri: config.msRedirectUri,
      loginRedirectUri,
      frontendBaseUrl: config.frontendBaseUrl
    });
    return res.redirect(loginUrl);
  });

  router.get("/auth/callback", async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    console.log(
      `[auth/callback] received code=${!!code} state=${!!state} error=${error || "none"} details=${JSON.stringify(
        authRequestDetails(req)
      )}`
    );
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
      const redirectUrl = powerBiAnalystPageUrl();
      logAuthRedirect(req, "auth/callback", {
        to: redirectUrl,
        frontendBaseUrl: config.frontendBaseUrl
      });
      return res.redirect(redirectUrl);
    } catch (callbackError) {
      return res.status(500).send(`Auth failed: ${callbackError.message}`);
    }
  });

  router.get("/auth/logout", (req, res) => {
    clearSession(req, res);
    if (wantsJson(req)) return res.json({ ok: true });
    const redirectUrl = powerBiAnalystPageUrl();
    logAuthRedirect(req, "auth/logout", {
      to: redirectUrl,
      frontendBaseUrl: config.frontendBaseUrl
    });
    return res.redirect(redirectUrl);
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
    const requestId = crypto.randomBytes(4).toString("hex");
    const trace = createTraceLogger(requestId);
    await trace("chat.received", {
      route: req.originalUrl || req.url,
      method: req.method,
      messageLength: typeof message === "string" ? message.length : 0,
      historyCount: Array.isArray(history) ? history.length : 0,
      authenticated: true,
      userName: getSession(req)?.userName || null,
      model: config.llmModel
    });
    if (!message || typeof message !== "string") {
      console.warn(`[chat ${requestId}] rejected: message is required`);
      await trace("chat.rejected", { reason: "message is required" });
      return res.status(400).json({ error: "message is required." });
    }

    console.log(`[chat ${requestId}] start: ${message.slice(0, 120)}`);

    req.on("aborted", () => {
      console.warn(`[chat ${requestId}] request aborted by client`);
      void trace("chat.request.aborted");
    });
    req.on("close", () => {
      console.log(`[chat ${requestId}] request closed`);
      void trace("chat.request.closed");
    });
    res.on("close", () => {
      console.log(`[chat ${requestId}] response closed writableEnded=${res.writableEnded}`);
      void trace("chat.response.closed", { writableEnded: res.writableEnded });
    });
    res.on("finish", () => {
      console.log(`[chat ${requestId}] response finished`);
      void trace("chat.response.finished");
    });
    res.on("error", (error) => {
      console.error(`[chat ${requestId}] response error:`, error);
      void trace("chat.response.error", {}, error);
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": keep-alive\n\n");
    await trace("chat.sse.opened");

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": keep-alive\n\n");
      }
    }, 15000);
    let agentResult = null;

    try {
      console.log(`[chat ${requestId}] running agent`);
      await trace("chat.agent.start");
      agentResult = await runAgentTurn({
        message,
        history,
        accessToken: req.powerBiAccessToken,
        trace,
        onToken: async (text) => {
          console.log(`[chat ${requestId}] streaming ${text.length} chars`);
          await trace("chat.stream.chunk", { contentLength: text.length });
          for (const part of text.split(/(\s+)/)) {
            if (!part) continue;
            res.write(`data: ${JSON.stringify({ token: part })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      });

      res.write(`data: ${JSON.stringify({ done: true, usage: normalizeUsage(agentResult.usage) })}\n\n`);
      console.log(`[chat ${requestId}] done`);
      await trace("chat.done", {
        assistantResponseLength: (agentResult.assistantResponse || agentResult.text || "").length,
        elapsedMs: agentResult.elapsedMs,
        usage: normalizeUsage(agentResult.usage)
      });
    } catch (error) {
      console.error(`[chat ${requestId}] error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const needsAuth = /401|403|unauthorized|forbidden/i.test(errorMessage);
      await trace("chat.error", { needsAuth }, error);
      res.write(`data: ${JSON.stringify({ error: errorMessage, needsAuth })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      console.log(`[chat ${requestId}] finalizing usage log`);
      await trace("usage_log.start");
      try {
        const usageLog = await appendUsageLog({
          requestId,
          modelUsed: config.llmModel,
          userMessage: message,
          assistantResponse: agentResult?.assistantResponse || agentResult?.text || "",
          systemPrompt: agentResult?.systemPrompt || "",
          rawLlmResponse: agentResult?.rawLlmResponse || null,
          usage: agentResult?.usage
        });
        console.log(`[chat ${requestId}] usage:`, usageLog);
        await trace("usage_log.done", {
          promptTokens: usageLog.promptTokens,
          completionTokens: usageLog.completionTokens,
          totalTokens: usageLog.totalTokens,
          iterations: usageLog.iterations
        });
      } catch (logError) {
        console.error(`[chat ${requestId}] usage log failed:`, logError);
        await trace("usage_log.error", {}, logError);
      }
      console.log(`[chat ${requestId}] ending response`);
      await trace("chat.response.end");
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

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION at:", promise, "reason:", reason);
});

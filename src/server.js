const express = require("express");
const crypto = require("crypto");
const { config } = require("./config");
const { runAgentTurn } = require("./agent");
const { callMcpMethod, executeMcpTool, listMcpTools } = require("./mcpClient");
const { discoverSemanticModels } = require("./powerbiCatalog");
const { requireInternalCaller, requirePowerBiToken } = require("./security");
const { createTraceLogger } = require("./traceLogger");
const { appendUsageLog, normalizeUsage, formatReadableUsage } = require("./usageLogger");
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
const chatJobs = new Map();
const CHAT_JOB_TTL_MS = 30 * 60 * 1000;
const CHAT_POLL_AFTER_MS = 2000;

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

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildPublicError(error, requestId) {
  const errorMessage = getErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();
  const needsAuth = /401|403|unauthorized|forbidden|not authenticated|access token/.test(lowerMessage);

  let errorType = "internal";
  let publicMessage = "I could not complete that request. Please try again in a moment.";

  if (needsAuth) {
    errorType = "auth";
    publicMessage = "Your session expired. Please sign in again.";
  } else if (/service account auth failed|aadsts|microsoft auth/i.test(lowerMessage)) {
    errorType = "auth";
    publicMessage = `Microsoft authentication failed: ${errorMessage}`;
    return {
      error: publicMessage,
      needsAuth: true,
      requestId,
      errorType
    };
  } else if (/timeout|timed out|etimedout|aborted/.test(lowerMessage)) {
    errorType = "timeout";
    publicMessage = "The request took too long to complete. Please try again with a narrower question.";
  } else if (/openrouter|litellm|insufficient credits|quota|budget|rate limit|429|402|model_group|fallback/.test(lowerMessage)) {
    errorType = "llm_provider";
    publicMessage = "The analytics service is temporarily unable to complete this request. Please try again shortly.";
  } else if (/mcp|power bi|fabric|pbi|dax|semantic model|executequery/.test(lowerMessage)) {
    errorType = "powerbi";
    publicMessage = "Power BI could not complete the data request. Please try again or narrow the question.";
  }

  return {
    error: publicMessage,
    needsAuth,
    requestId,
    errorType
  };
}

function sendPublicError(req, res, error, options = {}) {
  const requestId = options.requestId || crypto.randomBytes(4).toString("hex");
  const publicError = buildPublicError(error, requestId);
  if (options.publicMessage) publicError.error = options.publicMessage;
  if (options.errorType) publicError.errorType = options.errorType;
  if (typeof options.needsAuth === "boolean") publicError.needsAuth = options.needsAuth;

  const context = options.context || `${req.method} ${req.originalUrl || req.url}`;
  console.error(`[http ${requestId}] ${context} failed:`, error);

  const status = options.status || (publicError.needsAuth ? 401 : 500);
  if (wantsJson(req)) {
    return res.status(status).json(publicError);
  }

  return res.status(status).send(`${publicError.error} Reference ID: ${requestId}.`);
}

function cleanupChatJobs() {
  const now = Date.now();
  for (const [jobId, job] of chatJobs.entries()) {
    if (job.status === "running") continue;
    if (now - job.updatedAt > CHAT_JOB_TTL_MS) {
      chatJobs.delete(jobId);
    }
  }
}

function createChatJob({ requestId, message, history, userName }) {
  const now = Date.now();
  return {
    id: crypto.randomBytes(16).toString("hex"),
    requestId,
    status: "queued",
    message,
    history: Array.isArray(history) ? history : [],
    userName,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    partialText: "",
    result: null,
    error: null
  };
}

function serializeChatJob(job) {
  const payload = {
    jobId: job.id,
    requestId: job.requestId,
    status: job.status,
    pollAfterMs: CHAT_POLL_AFTER_MS,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString()
  };

  if (job.partialText && job.status !== "completed") {
    payload.partialText = job.partialText;
  }

  if (job.result) {
    payload.result = job.result;
    payload.text = job.result.text;
  }

  if (job.error) {
    Object.assign(payload, job.error);
  }

  return payload;
}

async function runStoredChatJob({ job, accessToken, trace }) {
  let agentResult = null;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = job.startedAt;
  await trace("chat_poll.job.started", { jobId: job.id });

  try {
    agentResult = await runAgentTurn({
      message: job.message,
      history: job.history,
      accessToken,
      trace,
      onToken: async (text) => {
        job.partialText += text;
        job.updatedAt = Date.now();
      }
    });

    const text = agentResult.assistantResponse || agentResult.text || "";
    job.status = "completed";
    job.result = {
      text,
      usage: normalizeUsage(agentResult.usage),
      elapsedMs: agentResult.elapsedMs
    };
    job.completedAt = Date.now();
    job.updatedAt = job.completedAt;
    await trace("chat_poll.job.completed", {
      jobId: job.id,
      assistantResponseLength: text.length,
      elapsedMs: agentResult.elapsedMs,
      usage: normalizeUsage(agentResult.usage)
    });
  } catch (error) {
    const publicError = buildPublicError(error, job.requestId);
    job.status = "failed";
    job.error = publicError;
    job.completedAt = Date.now();
    job.updatedAt = job.completedAt;
    console.error(`[chat ${job.requestId}] polling job failed:`, error);
    await trace("chat_poll.job.failed", {
      jobId: job.id,
      needsAuth: publicError.needsAuth,
      publicErrorType: publicError.errorType
    }, error);
  } finally {
    await trace("usage_log.start");
    try {
      const usageLog = await appendUsageLog({
        requestId: job.requestId,
        modelUsed: config.llmModel,
        userMessage: job.message,
        assistantResponse: agentResult?.assistantResponse || agentResult?.text || job.partialText || "",
        systemPrompt: agentResult?.systemPrompt || "",
        rawLlmResponse: agentResult?.rawLlmResponse || null,
        usage: agentResult?.usage,
        finalQuery: agentResult?.finalQuery,
        responseTimeMs: agentResult?.elapsedMs
      });
      console.log(`[chat ${job.requestId}] polling usage:`, usageLog);
      if (job.status === "completed" && job.result) {
        job.result.formattedLog = formatReadableUsage(usageLog);
        job.result.usageLog = usageLog;
      }
      await trace("usage_log.done", {
        promptTokens: usageLog.promptTokens,
        completionTokens: usageLog.completionTokens,
        totalTokens: usageLog.totalTokens,
        iterations: usageLog.iterations
      });
    } catch (logError) {
      console.error(`[chat ${job.requestId}] polling usage log failed:`, logError);
      await trace("usage_log.error", {}, logError);
    }
  }
}

const chatJobCleanupInterval = setInterval(cleanupChatJobs, 5 * 60 * 1000);
chatJobCleanupInterval.unref?.();

function createSessionTokenMiddleware() {
  return async (req, res, next) => {
    try {
      const { accessToken } = await getValidSessionToken(req);
      req.powerBiAccessToken = accessToken;
      return next();
    } catch (error) {
      return sendPublicError(req, res, error, {
        status: 401,
        context: "session token",
        publicMessage: "Your session expired. Please sign in again.",
        errorType: "auth",
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
        return sendPublicError(req, res, error, {
          status: 500,
          context: "auth/login silent login"
        });
      }
    }

    if (!config.msClientId) {
      return sendPublicError(req, res, new Error("MS_CLIENT_ID is not configured."), {
        status: 500,
        context: "auth/login configuration"
      });
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
      return sendPublicError(
        req,
        res,
        new Error(`Microsoft auth error: ${error}. ${errorDescription || ""}`),
        {
          status: 400,
          context: "auth/callback microsoft error",
          publicMessage: "Microsoft sign-in could not be completed. Please try again.",
          errorType: "auth",
          needsAuth: true
        }
      );
    }

    if (!code || getOauthState(req) !== state) {
      return sendPublicError(req, res, new Error("Invalid OAuth state."), {
        status: 400,
        context: "auth/callback state validation",
        publicMessage: "Sign-in could not be verified. Please try again.",
        errorType: "auth",
        needsAuth: true
      });
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
      return sendPublicError(req, res, callbackError, {
        status: 500,
        context: "auth/callback token exchange",
        publicMessage: "Microsoft sign-in could not be completed. Please try again.",
        errorType: "auth",
        needsAuth: true
      });
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
        return sendPublicError(req, res, new Error("Missing MCP tool name or method."), {
          status: 400,
          context: "mcp/call validation",
          publicMessage: "The request could not be processed. Please try again.",
          errorType: "bad_request"
        });
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
        return sendPublicError(req, res, new Error("message is required."), {
          status: 400,
          context: "chat/json validation",
          publicMessage: "Please enter a message and try again.",
          errorType: "bad_request"
        });
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

  router.post("/chat/start", tokenMiddleware, async (req, res) => {
    const { message, history } = req.body || {};
    const requestId = crypto.randomBytes(4).toString("hex");
    const trace = createTraceLogger(requestId);
    await trace("chat_poll.received", {
      route: req.originalUrl || req.url,
      method: req.method,
      messageLength: typeof message === "string" ? message.length : 0,
      historyCount: Array.isArray(history) ? history.length : 0,
      authenticated: true,
      userName: getSession(req)?.userName || null,
      model: config.llmModel
    });

    if (!message || typeof message !== "string") {
      console.warn(`[chat ${requestId}] polling rejected: message is required`);
      await trace("chat_poll.rejected", { reason: "message is required" });
      return sendPublicError(req, res, new Error("message is required."), {
        status: 400,
        requestId,
        context: "chat polling validation",
        publicMessage: "Please enter a message and try again.",
        errorType: "bad_request"
      });
    }

    cleanupChatJobs();
    const accessToken = req.powerBiAccessToken;
    const userName = getSession(req)?.userName || null;
    const job = createChatJob({
      requestId,
      message,
      history,
      userName
    });
    chatJobs.set(job.id, job);

    console.log(`[chat ${requestId}] polling job queued: ${message.slice(0, 120)}`);
    res.status(202).json(serializeChatJob(job));

    setImmediate(() => {
      void runStoredChatJob({
        job,
        accessToken,
        trace
      }).catch((error) => {
        console.error(`[chat ${requestId}] polling job crashed:`, error);
        job.status = "failed";
        job.error = buildPublicError(error, requestId);
        job.completedAt = Date.now();
        job.updatedAt = job.completedAt;
      });
    });
  });

  router.post("/chat/status", tokenMiddleware, async (req, res) => {
    const { jobId } = req.body || {};
    cleanupChatJobs();

    if (!jobId || typeof jobId !== "string") {
      return sendPublicError(req, res, new Error("jobId is required."), {
        status: 400,
        context: "chat polling status validation",
        publicMessage: "The request could not be processed. Please try again.",
        errorType: "bad_request"
      });
    }

    const job = chatJobs.get(jobId);
    if (!job) {
      return sendPublicError(req, res, new Error(`Chat job not found: ${jobId}`), {
        status: 404,
        context: "chat polling status lookup",
        publicMessage: "That analysis request is no longer available. Please run it again.",
        errorType: "not_found"
      });
    }

    return res.json(serializeChatJob(job));
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
      return sendPublicError(req, res, new Error("message is required."), {
        status: 400,
        requestId,
        context: "chat validation",
        publicMessage: "Please enter a message and try again.",
        errorType: "bad_request"
      });
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
      const publicError = buildPublicError(error, requestId);
      await trace("chat.error", {
        needsAuth: publicError.needsAuth,
        publicErrorType: publicError.errorType
      }, error);
      res.write(`data: ${JSON.stringify(publicError)}\n\n`);
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
          usage: agentResult?.usage,
          finalQuery: agentResult?.finalQuery,
          responseTimeMs: agentResult?.elapsedMs
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
  return sendPublicError(req, res, new Error(`Route not found: ${req.method} ${req.originalUrl || req.url}`), {
    status: 404,
    context: "route not found",
    publicMessage: "The requested service endpoint was not found.",
    errorType: "not_found"
  });
});

app.use((error, req, res, next) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  const publicError = buildPublicError(error, requestId);
  const errorStatus = Number(error?.statusCode || error?.status);
  const status = Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 600
    ? errorStatus
    : publicError.needsAuth
      ? 401
      : 500;
  console.error(`[http ${requestId}] error:`, error);
  res.status(status).json(publicError);
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

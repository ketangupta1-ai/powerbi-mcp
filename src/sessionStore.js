const crypto = require("crypto");
const { config } = require("./config");
const { fetchJson } = require("./http");

const sessions = new Map();
let serviceAccountSession = null;

const scopes = [
  "https://analysis.windows.net/powerbi/api/Dataset.Read.All",
  "https://analysis.windows.net/powerbi/api/Report.Read.All",
  "https://analysis.windows.net/powerbi/api/Workspace.Read.All",
  "offline_access",
  "openid",
  "profile",
  "email"
].join(" ");

function makeSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function parseCookies(req) {
  const cookies = {};
  const header = req.get("cookie") || "";
  for (const pair of header.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(value.join("="));
  }
  return cookies;
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  return sid ? sessions.get(sid) : null;
}

function setSession(res, session) {
  const sid = makeSessionId();
  sessions.set(sid, session);
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000
  });
  return sid;
}

function clearSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  res.clearCookie("sid");
}

function setOauthState(res, state) {
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60 * 1000
  });
}

function getOauthState(req) {
  return parseCookies(req).oauth_state;
}

function buildLoginUrl(state) {
  const params = new URLSearchParams({
    client_id: config.msClientId,
    response_type: "code",
    redirect_uri: config.msRedirectUri,
    response_mode: "query",
    scope: scopes,
    state
  });

  return `https://login.microsoftonline.com/${config.msTenantId}/oauth2/v2.0/authorize?${params}`;
}

function decodeUserName(idToken) {
  if (!idToken) return "User";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    return payload.name || payload.preferred_username || payload.email || "User";
  } catch {
    return "User";
  }
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    client_id: config.msClientId,
    client_secret: config.msClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.msRedirectUri,
    scope: scopes
  });

  const { response, json, text } = await fetchJson(
    `https://login.microsoftonline.com/${config.msTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    },
    config.requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(json?.error_description || `Token exchange failed: ${response.status} ${text}`);
  }

  return json;
}

async function authenticateServiceAccount() {
  if (!config.msAdminUsername || !config.msAdminPassword) {
    throw new Error("MS_ADMIN_USERNAME or MS_ADMIN_PASSWORD is not configured.");
  }

  console.log(`[session] authenticating service account: ${config.msAdminUsername}`);
  const body = new URLSearchParams({
    client_id: config.msClientId,
    client_secret: config.msClientSecret,
    grant_type: "password",
    username: config.msAdminUsername,
    password: config.msAdminPassword,
    scope: scopes
  });

  const { response, json, text } = await fetchJson(
    `https://login.microsoftonline.com/${config.msTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    },
    config.requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(json?.error_description || `Service account auth failed: ${response.status} ${text}`);
  }

  serviceAccountSession = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    userName: decodeUserName(json.id_token) || config.msAdminUsername
  };

  console.log(`[session] service account authenticated successfully`);
  return serviceAccountSession;
}

async function refreshAccessToken(session) {
  if (!session?.refreshToken) throw new Error("No refresh token available.");

  const body = new URLSearchParams({
    client_id: config.msClientId,
    client_secret: config.msClientSecret,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    scope: scopes
  });

  const { response, json, text } = await fetchJson(
    `https://login.microsoftonline.com/${config.msTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    },
    config.requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(json?.error_description || `Token refresh failed: ${response.status} ${text}`);
  }

  session.accessToken = json.access_token;
  session.refreshToken = json.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + (json.expires_in - 60) * 1000;
  return session.accessToken;
}

async function getValidSessionToken(req) {
  // If a service account is configured, we prioritize its session.
  if (config.msAdminUsername && config.msAdminPassword) {
    if (!serviceAccountSession || Date.now() >= (serviceAccountSession.expiresAt || 0)) {
      await authenticateServiceAccount();
    }
    return { session: serviceAccountSession, accessToken: serviceAccountSession.accessToken };
  }

  // Fallback to per-user session (original behavior)
  const session = getSession(req);
  if (!session?.accessToken) throw new Error("Not authenticated.");
  if (Date.now() < (session.expiresAt || 0)) return { session, accessToken: session.accessToken };
  const accessToken = await refreshAccessToken(session);
  return { session, accessToken };
}

module.exports = {
  buildLoginUrl,
  clearSession,
  decodeUserName,
  exchangeCodeForTokens,
  getOauthState,
  getSession,
  getValidSessionToken,
  scopes,
  setOauthState,
  setSession
};

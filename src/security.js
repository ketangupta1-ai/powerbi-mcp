const crypto = require("crypto");
const { config } = require("./config");

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireInternalCaller(req, res, next) {
  if (config.basicAuthUser || config.basicAuthPassword) {
    const authorization = req.get("authorization") || "";
    if (authorization.toLowerCase().startsWith("basic ")) {
      const raw = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = raw.indexOf(":");
      const user = separator === -1 ? raw : raw.slice(0, separator);
      const password = separator === -1 ? "" : raw.slice(separator + 1);
      if (
        timingSafeEqualString(user, config.basicAuthUser) &&
        timingSafeEqualString(password, config.basicAuthPassword)
      ) {
        return next();
      }
    }
  }

  if (!config.internalApiKey) return next();

  const providedKey = req.get("x-internal-api-key") || "";
  if (!timingSafeEqualString(providedKey, config.internalApiKey)) {
    return res.status(401).json({ error: "Invalid internal API key." });
  }

  return next();
}

function getBearerToken(req) {
  const authorization = req.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  const headerToken = req.get("x-powerbi-access-token");
  if (headerToken) return headerToken.trim();

  const bodyToken = req.body?.accessToken;
  return typeof bodyToken === "string" ? bodyToken.trim() : "";
}

function requirePowerBiToken(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Power BI access token is required. Send Authorization: Bearer <token>."
    });
  }

  req.powerBiAccessToken = token;
  return next();
}

module.exports = { requireInternalCaller, requirePowerBiToken };

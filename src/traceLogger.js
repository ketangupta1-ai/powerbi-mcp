const fs = require("fs/promises");
const path = require("path");

const traceLogPath = path.join(__dirname, "..", "logs", "trace.jsonl");
const readableTraceLogPath = path.join(__dirname, "..", "logs", "trace-readable.log");

const REDACTED_KEY_PATTERN =
  /authorization|cookie|secret|password|client_secret|accessToken|refreshToken|idToken|bearer|oauthState|authCode/i;
const MAX_STRING_LENGTH = 500;

function isTraceEnabled() {
  return process.env.TRACE_CHAT_FLOW !== "false";
}

function sanitizeValue(key, value) {
  if (REDACTED_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  return value;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== "object") return details || {};
  return JSON.parse(
    JSON.stringify(details, (key, value) => sanitizeValue(key, value))
  );
}

function normalizeError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack
    };
  }
  return { message: String(error) };
}

function formatReadable(event) {
  const details = Object.keys(event.details || {}).length
    ? ` ${JSON.stringify(event.details)}`
    : "";
  const error = event.error ? ` error=${JSON.stringify(event.error)}` : "";
  return `[${event.timestamp}] ${event.requestId} +${event.elapsedMs}ms #${event.seq} ${event.stage}${details}${error}\n`;
}

function createTraceLogger(requestId) {
  const startedAt = Date.now();
  let seq = 0;

  return async function trace(stage, details = {}, error = null) {
    if (!isTraceEnabled()) return null;

    const event = {
      timestamp: new Date().toISOString(),
      requestId,
      seq: ++seq,
      elapsedMs: Date.now() - startedAt,
      stage,
      details: sanitizeDetails(details),
      error: normalizeError(error)
    };

    try {
      await fs.mkdir(path.dirname(traceLogPath), { recursive: true });
      await fs.appendFile(traceLogPath, `${JSON.stringify(event)}\n`, "utf8");
      await fs.appendFile(readableTraceLogPath, formatReadable(event), "utf8");
    } catch (writeError) {
      console.warn(`[trace ${requestId}] write failed: ${writeError.message}`);
    }
    return event;
  };
}

module.exports = { createTraceLogger };

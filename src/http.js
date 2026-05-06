function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

async function fetchText(url, options, timeoutMs) {
  const timeout = createAbortSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    timeout.clear();
  }
}

async function fetchJson(url, options, timeoutMs) {
  const { response, text } = await fetchText(url, options, timeoutMs);
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
    }
  }
  return { response, json, text };
}

module.exports = { fetchJson, fetchText };

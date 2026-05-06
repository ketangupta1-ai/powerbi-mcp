const crypto = require("crypto");
const { config } = require("./config");
const { fetchJson } = require("./http");

const catalogCache = new Map();

function tokenCacheKey(accessToken) {
  return crypto.createHash("sha256").update(accessToken).digest("hex");
}

function getCachedCatalog(key) {
  const cached = catalogCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    catalogCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedCatalog(key, value) {
  catalogCache.set(key, { value, expiresAt: Date.now() + config.cacheTtlMs });
}

async function fetchPowerBiJson(url, accessToken) {
  const { response, json, text } = await fetchJson(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    config.requestTimeoutMs
  );

  if (!response.ok) {
    throw new Error(`Power BI REST ${response.status}: ${text.slice(0, 300)}`);
  }

  return json;
}

async function discoverSemanticModels(accessToken, options = {}) {
  const cacheKey = tokenCacheKey(accessToken);
  if (!options.refresh) {
    const cached = getCachedCatalog(cacheKey);
    if (cached) return cached;
  }

  const workspaceData = await fetchPowerBiJson(
    "https://api.powerbi.com/v1.0/myorg/groups?$top=100",
    accessToken
  );

  const workspaces = Array.isArray(workspaceData?.value) ? workspaceData.value : [];
  const models = [];

  for (const workspace of workspaces) {
    try {
      const datasetData = await fetchPowerBiJson(
        `https://api.powerbi.com/v1.0/myorg/groups/${workspace.id}/datasets`,
        accessToken
      );

      for (const dataset of datasetData?.value || []) {
        models.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          datasetId: dataset.id,
          datasetName: dataset.name,
          configuredBy: dataset.configuredBy || null,
          isRefreshable: dataset.isRefreshable ?? null
        });
      }
    } catch (error) {
      models.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        error: error.message
      });
    }
  }

  const catalog = {
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      type: workspace.type || null,
      state: workspace.state || null
    })),
    semanticModels: models,
    discoveredAt: new Date().toISOString()
  };

  setCachedCatalog(cacheKey, catalog);
  return catalog;
}

function catalogToPromptText(catalog) {
  const models = (catalog?.semanticModels || []).filter((model) => model.datasetId);
  if (!models.length) {
    return "\n\nNo semantic models were discovered automatically.";
  }

  const lines = models.map((model) =>
    `- Name: "${model.datasetName}" | Workspace: "${model.workspaceName}" | artifactId: ${model.datasetId}`
  );

  return [
    "\n\nAVAILABLE SEMANTIC MODELS (always use datasetId as artifactId in tool calls):",
    ...lines,
    "",
    "IMPORTANT: Always use the artifactId GUID shown above. Never pass a semantic model name as artifactId.",
    "Always mention which report or semantic model the data came from in the answer."
  ].join("\n");
}

module.exports = { catalogToPromptText, discoverSemanticModels };

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
  // Original logic to fetch full catalog
  const catalog = await fetchFullCatalog(accessToken, options);
  
  // Filtering logic
  try {
    const filePath = path.join(process.cwd(), config.allowedReportsFile);
    console.log(`[catalog] checking for allowed reports at: ${filePath}`);
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, "utf8");
      const allowedNames = JSON.parse(fileContent)
        .map(name => name.trim().toLowerCase());
      
      console.log(`[catalog] found allowed_reports.json with ${allowedNames.length} names`);
      
      const filtered = (catalog.semanticModels || []).filter(model => {
        // Handle models that might have datasetName (from fetchFullCatalog) or name (from legacy)
        const name = (model.datasetName || model.name || "").trim().toLowerCase();
        const match = allowedNames.includes(name);
        return match;
      });
      
      console.log(`[catalog] Filtered ${catalog.semanticModels.length} models down to ${filtered.length} allowed models`);
      if (filtered.length > 0) {
        console.log(`[catalog] Allowed reports: ${filtered.map(m => m.datasetName || m.name).join(", ")}`);
      }
      
      // Return the catalog object with the filtered list
      return {
        ...catalog,
        semanticModels: filtered
      };
    } else {
      console.log(`[catalog] allowed_reports.json NOT FOUND at ${filePath}`);
    }
  } catch (error) {
    console.error(`[catalog] Failed to read allowed reports file: ${error.message}`);
  }

  return catalog;
}

async function fetchFullCatalog(accessToken, options = {}) {
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

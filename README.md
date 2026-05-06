# powerbi-mcp

Internal Node.js service for Power BI MCP access. It is designed to run beside a Next.js app, usually under PM2, and be called only from the Next.js server layer.

This project does not replicate the Google Ads MCP repo. It follows the same idea of a focused MCP backend, but it is tailored to Power BI/Fabric, direct JSON-RPC calls, and the agent/tool iteration already proven in the PBI bot POC.

## What It Does

- Calls the Fabric Power BI MCP endpoint with a user bearer token.
- Lists and executes MCP tools through JSON-RPC.
- Discovers Power BI workspaces and semantic models for better model prompts.
- Runs an OpenAI-compatible agent loop that can call Power BI MCP tools.
- Exposes internal HTTP endpoints for a Next.js backend.
- Ships with a PM2 process config named `powerbi-mcp`.

## Endpoints

- `GET /health`
- `POST /internal/mcp/tools`
- `POST /internal/mcp/call`
- `POST /internal/powerbi/catalog`
- `POST /internal/chat`
- `POST /internal/chat/json`

Browser/proxy compatibility routes are also available under `/api/*`:

- `GET /api/auth/status`
- `GET /api/auth/login`
- `GET /api/auth/callback`
- `GET /api/auth/logout`
- `POST /api/mcp/tools`
- `POST /api/mcp/call`
- `POST /api/powerbi/catalog`
- `POST /api/chat`
- `POST /api/chat/json`

All internal routes accept the user Power BI access token in one of these forms:

- `Authorization: Bearer <power-bi-access-token>`
- `x-powerbi-access-token: <power-bi-access-token>`
- JSON body field `accessToken`

If `INTERNAL_API_KEY` is configured, also send:

```http
x-internal-api-key: <your-internal-key>
```

## Install

```bash
cd powerbi-mcp
npm install
cp .env.example .env
npm run check
```

Fill `.env` with your LiteLLM/OpenAI-compatible gateway settings.
For the browser route, set your Azure redirect URI to the Next.js proxy callback, for example:

```text
http://localhost:3000/api/powerbi-mcp/auth/callback
```

## Run Locally

```bash
npm run dev
```

The default service URL is `http://127.0.0.1:3101`.

## Run With PM2

```bash
pm2 start ecosystem.config.js
pm2 status
```

Expected process name:

```text
powerbi-mcp
```

## Next.js Drop-In Route

Keep the Next.js route files outside this backend repo. In this workspace they live in the sibling folder:

```text
../powerbi-analyst-next-dropin/app
```

Copy those files into the real `ads-next/app` directory:

- `app/Power_BI_Analyst/page.tsx`
- `app/api/powerbi-mcp/[...path]/route.ts`

Then browse to:

```text
/Power_BI_Analyst
```

The Next.js proxy calls this backend at:

```text
http://127.0.0.1:3101/api/*
```

## Next.js Server Example

Call this only from a server route, server action, or API handler. Do not expose the Power BI access token to browser-side code beyond your normal auth flow.

```js
const response = await fetch("http://127.0.0.1:3101/internal/chat/json", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-internal-api-key": process.env.POWERBI_MCP_INTERNAL_API_KEY,
    "Authorization": `Bearer ${powerBiAccessToken}`
  },
  body: JSON.stringify({
    message: "Show total sales this month vs last month",
    history: []
  })
});

const data = await response.json();
```

For streaming UI responses, call `/internal/chat` or `/api/chat`; it returns server-sent events:

```text
data: {"token":"..."}
data: [DONE]
```

## Notes

- This service supports both token-forwarding through `/internal/*` and browser session flow through `/api/auth/*`.
- Bind to `127.0.0.1` in production unless you are intentionally putting this behind a private network boundary.
- Set `INTERNAL_API_KEY` before deploying so only trusted internal callers can use the service.

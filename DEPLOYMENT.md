# Deployment Guide — Second Brain

Production deployment runbook for **Second Brain** (`VpkDevs/second-brain`) on **Cloudflare Workers**.

## Stack Summary

| Layer | Technology | Binding / Config |
| --- | --- | --- |
| Compute / HTTP / MCP | Cloudflare Workers (TypeScript, `nodejs_compat`) | `src/index.ts` |
| Relational Storage | Cloudflare D1 (SQLite) | `DB` (`second-brain-db`, schema in `db/schema.sql`) |
| Vector Search | Cloudflare Vectorize (384 dims, `cosine`) | `VECTORIZE` (`second-brain-vectors`) |
| Embeddings & LLM | Cloudflare Workers AI (`@cf/baai/bge-small-en-v1.5`, `@cf/meta/llama-4-scout-17b-16e-instruct`) | `AI` |
| OAuth & Integration State | Cloudflare Workers KV | `OAUTH_KV` |
| Web Dashboard | Cloudflare Workers Static Assets | `./public` (+ `public/_headers`) |
| Scheduled Maintenance | Cloudflare Cron Trigger (`0 1 * * *` UTC) | Nightly compression, graph pass, integration sync |

## Prerequisites

- **Node.js `>= 20.0.0`** and npm (tested on Node 22 in GitHub Actions CI).
- **Cloudflare account** with Workers, D1, KV, Vectorize, and Workers AI enabled (free tier works at personal scale).
- **Supported host OS for Wrangler / `workerd`:** Linux (`x64`/`arm64`), macOS (`x64`/`arm64`), or Windows (`x64`).
  - *Note for Android / Termux users:* `workerd` does not publish an `android-arm64` binary, so `wrangler` CLI commands (`wrangler types`, `wrangler dev`, `wrangler deploy`) must run on Linux/macOS/Windows or via GitHub Actions CI.

## Environment Variables & Bindings

### Worker Secrets & Runtime Vars

| Name | Required | Where Configured | Purpose |
| --- | --- | --- | --- |
| `AUTH_TOKEN` | **Yes** | `.dev.vars` (local) / `wrangler secret put AUTH_TOKEN` (prod) | Bearer token & OAuth login password protecting `/mcp`, dashboard APIs, and `/health`. Worker fails closed (`503`) if unset or blank. |
| `VECTORIZE_GRACE_MS` | No (default `300000`) | `wrangler.jsonc` `vars` (overrideable in `.dev.vars`) | Milliseconds to wait before unvectorized entries are counted/retried by `POST /vectorize-pending`. |

### Cloudflare Bindings (`wrangler.jsonc`)

| Binding | Resource Type | Name in `wrangler.jsonc` | Notes |
| --- | --- | --- | --- |
| `DB` | D1 Database | `second-brain-db` | Must point to a `database_id` in **your** Cloudflare account. |
| `VECTORIZE` | Vectorize Index | `second-brain-vectors` | 384 dimensions, `cosine` metric. Degrades gracefully to keyword search if absent. |
| `AI` | Workers AI | Built-in binding | No separate API key required; billed/metered under Cloudflare account. |
| `OAUTH_KV` | Workers KV Namespace | `OAUTH_KV` | Stores OAuth 2.0 client registrations/grants and integration tokens (e.g., Notion). Must point to a KV `id` in **your** Cloudflare account. |
| `ASSETS` | Static Assets | `./public` | Serves the web dashboard and applies `public/_headers`. |

### Optional Client-Side Hook Variables (`integrations/claude-code-hooks/`)

| Name | Required | Purpose |
| --- | --- | --- |
| `SECOND_BRAIN_URL` | Only if using Claude Code hooks | Deployed Worker base URL (e.g., `https://second-brain.<subdomain>.workers.dev`). |
| `SECOND_BRAIN_TOKEN` | Only if using Claude Code hooks | Same secret value as `AUTH_TOKEN`. |

See [`.dev.vars.example`](.dev.vars.example) and [`.env.example`](.env.example) for ready-to-copy templates.

---

## Local Verification

```bash
# 1. Install dependencies
npm ci

# 2. Configure local dev secret (never commit .dev.vars)
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set AUTH_TOKEN to a local secret

# 3. Generate Cloudflare types & run strict TypeScript check
npm run typecheck

# 4. Run full automated test suite (unit, integration, UI, security hardening)
npm test

# 5. Verify Worker production bundle without deploying
npm run build:dry-run

# 6. Run locally with Wrangler (Linux / macOS / Windows)
npm run dev
```

---

## Step-by-Step Production Deployment (Cloudflare Workers)

### 1. Authenticate Wrangler

```bash
npx wrangler login
```

*(For headless/CI environments, export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.)*

### 2. Provision Cloudflare Resources

> **Important:** `wrangler.jsonc` ships with existing `database_id` and `OAUTH_KV` `id` values. If you are deploying into a fresh Cloudflare account, create your own resources and replace those IDs in `wrangler.jsonc` before migrating or deploying.

```bash
# Create the D1 database -> copy the printed database_id into wrangler.jsonc
npm run db:create

# Create the KV namespace for OAuth & integrations -> copy the printed id into wrangler.jsonc
npm run kv:create

# Create the Vectorize index (384 dimensions for @cf/baai/bge-small-en-v1.5, cosine metric)
npm run vectors:create
```

### 3. Apply Remote D1 Database Schema

```bash
npm run db:migrate:remote
```

*(Runs `wrangler d1 execute second-brain-db --remote --file=db/schema.sql`. The Worker also runs idempotent `CREATE TABLE IF NOT EXISTS` / column `ALTER` checks on cold start.)*

### 4. Set the Production `AUTH_TOKEN` Secret

Generate a strong token and store it as an encrypted Cloudflare Worker secret:

```bash
openssl rand -base64 32
npm run secret:auth
# Paste the generated token when prompted (runs: wrangler secret put AUTH_TOKEN)
```

Save this token in your password manager — you will need it to authorize the dashboard, OAuth login page, REST clients, and headless MCP clients.

### 5. Bundle Check & Deploy

```bash
npm run typecheck
npm test
npm run build:dry-run
npm run deploy
```

Copy the deployed Worker URL printed by Wrangler (e.g. `https://second-brain.<your-subdomain>.workers.dev`).

---

## Post-Deploy Verification

Replace `YOUR-WORKER-URL` and `YOUR-TOKEN` with your deployed URL and `AUTH_TOKEN`:

```bash
# 1. Unauthenticated liveness probe (should return 200 + security headers, no internal details)
curl -i "https://YOUR-WORKER-URL/healthz"

# 2. Verify /health and data routes enforce authentication (should return 401)
curl -i "https://YOUR-WORKER-URL/health"

# 3. Authenticated readiness & Vectorize index check (should return 200 with ok: true)
curl -s "https://YOUR-WORKER-URL/health" \
  -H "Authorization: Bearer YOUR-TOKEN"

# 4. Capture & recall smoke test
curl -s -X POST "https://YOUR-WORKER-URL/capture" \
  -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Second Brain production smoke test","source":"deploy-check"}'

curl -s "https://YOUR-WORKER-URL/recall?query=smoke+test" \
  -H "Authorization: Bearer YOUR-TOKEN"
```

---

## Connecting MCP Clients

Your MCP endpoint is:

```text
https://YOUR-WORKER-URL/mcp
```

### Claude Code & Codex CLI (OAuth)

Run the included setup script (registers `/mcp` via OAuth and appends instructions):

```bash
# macOS / Linux / WSL
bash scripts/connect-ai-clients.sh "https://YOUR-WORKER-URL"
```

```powershell
# Windows PowerShell
.\scripts\connect-ai-clients.ps1 -WorkerUrl "https://YOUR-WORKER-URL"
```

Or register manually:

```bash
claude mcp add --transport http second-brain "https://YOUR-WORKER-URL/mcp"
codex mcp add second-brain --url "https://YOUR-WORKER-URL/mcp"
```

On first use, your browser opens `/oauth/authorize` and prompts for your `AUTH_TOKEN`.

### Cursor

Add to `.cursor/mcp.json` (or global Cursor MCP settings):

```json
{
  "mcpServers": {
    "second-brain": {
      "url": "https://YOUR-WORKER-URL/mcp",
      "headers": {
        "Authorization": "Bearer YOUR-AUTH-TOKEN"
      }
    }
  }
}
```

### Claude.ai & ChatGPT (Web / Desktop Connectors)

1. Add custom instructions from [`AI_Instructions/CLAUDE_INSTRUCTIONS.md`](AI_Instructions/CLAUDE_INSTRUCTIONS.md) or [`AI_Instructions/CHATGPT_INSTRUCTIONS.md`](AI_Instructions/CHATGPT_INSTRUCTIONS.md).
2. Add `https://YOUR-WORKER-URL/mcp` as a custom MCP connector and complete the OAuth prompt using your `AUTH_TOKEN`.

---

## Security & Hardening Summary

- **Fail-closed auth:** All REST endpoints, `/health`, `/oauth/authorize`, and `/mcp` reject requests with `503` (or `401` on `/mcp`) if `AUTH_TOKEN` is missing or whitespace-only — never accepting `Bearer undefined` or empty tokens.
- **Constant-time comparison:** `AUTH_TOKEN` checks use constant-time UTF-8 comparison (`timingSafeEqualStrings`).
- **Response security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy` are set on all Worker responses and static assets (`public/_headers`), plus `Cache-Control: no-store` on `/oauth/authorize`.
- **Unauthenticated liveness vs. authenticated readiness:** `GET /healthz` returns minimal liveness JSON for uptime probes without leaking bindings or index details; `GET /health` requires authentication and reports full Vectorize + binding status.
- **CI gate:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm ci`, `npm run typecheck`, `npm test`, and `npx wrangler deploy --dry-run --outdir dist` on every push and PR to `main`.

---

## Honest Readiness & Remaining Owner Steps

The codebase, schema, tests, security hardening, and CI workflow are complete and verified. Before going live in your own Cloudflare account, you still need to complete these account-bound steps:

1. **Authenticate with Cloudflare:** Run `npx wrangler login` (or configure `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) on a Wrangler-supported machine (Linux, macOS, Windows, or GitHub Actions).
2. **Verify or create Cloudflare resources:** Confirm whether the `database_id` (`2a30b902-a2a3-41d9-b217-3da2b046ac27`) and `OAUTH_KV` `id` (`058a6de4ffb140208fb07b2c42fb366a`) in `wrangler.jsonc` belong to your Cloudflare account; if not, run `npm run db:create` and `npm run kv:create` and update `wrangler.jsonc`.
3. **Create the Vectorize index:** Run `npm run vectors:create` (required once per account; Cloudflare does not auto-provision Vectorize during deploy).
4. **Migrate D1 remotely:** Run `npm run db:migrate:remote`.
5. **Configure production secret:** Run `npm run secret:auth` (`npx wrangler secret put AUTH_TOKEN`) with a strong generated token.
6. **Deploy:** Run `npm run deploy` and verify `GET /healthz` and authenticated `GET /health`.
7. *(Optional)* **Connect Notion sync:** Open the deployed web dashboard → **Settings → Integrations** and paste a Notion internal connection secret if you want Notion page mirroring.

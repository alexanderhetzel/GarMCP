# garmin-connect-mcp

Garmin Connect MCP server with two modes:
- local stdio mode (`npm run start:stdio`)
- remote Streamable HTTP mode (`npm start`) for Claude Web/Mobile custom connectors

The Garmin API flow is based on [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) by [cyberjunky](https://github.com/cyberjunky).

## Runtime Modes

- `npm run start:stdio`: local MCP over stdio (desktop/dev clients)
- `npm start` / `npm run start:http`: HTTP MCP server
- Vercel serverless handlers in `api/*` expose OAuth + MCP endpoints

## Local Quickstart (stdio)

Required:
- `GARMIN_EMAIL`
- `GARMIN_PASSWORD`

```bash
GARMIN_EMAIL=you@email.com GARMIN_PASSWORD=yourpass npm run start:stdio
```

## Cloud Quickstart (Vercel + Claude OAuth)

### 1) Configure environment variables in Vercel

Required:
- `MCP_OAUTH_ENABLED=true`
- `MCP_OAUTH_CLIENT_ID=<your-client-id>`
- `MCP_OAUTH_CLIENT_SECRET=<your-client-secret>`
- `MCP_OAUTH_SIGNING_SECRET=<long-random-secret>`
- `MCP_ALLOWED_ORIGINS=https://claude.ai`
- `GARMIN_TOKEN_STORE=vercel-kv`
- `KV_REST_API_URL=<from Upstash/Vercel integration>`
- `KV_REST_API_TOKEN=<from Upstash/Vercel integration>`

Recommended:
- `MCP_ENABLE_WRITE_TOOLS=false`
- `GARMIN_MAX_CONCURRENT_REQUESTS=1`

Optional:
- `GARMIN_TOKEN_DIR=/tmp/garmin-mcp` (namespace base for token keys)
- `GARMIN_EMAIL` and `GARMIN_PASSWORD` (fallback when token storage is unavailable)
- `MCP_API_KEY` and `MCP_OAUTH_ALLOW_API_KEY_FALLBACK=true` (Inspector/API-key testing)
- `MCP_OAUTH_REDIRECT_URIS` (restrict OAuth redirect targets)

### 2) Deploy

```bash
npm install
npm run check
vercel --prod
```

### 3) Add custom connector in Claude

- URL: `https://<your-domain>/mcp`
- OAuth Client ID: same value as `MCP_OAUTH_CLIENT_ID`
- OAuth Client Secret: same value as `MCP_OAUTH_CLIENT_SECRET`

Connector flow:
1. Claude hits `/mcp`
2. OAuth starts at `/authorize`
3. User enters Garmin credentials
4. Server stores Garmin tokens per OAuth subject
5. Tool calls use stored Garmin tokens

## Endpoints

- `GET /health`
- `POST|GET|DELETE /mcp`
- `GET|POST /authorize`
- `POST /token`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource/mcp`

## Troubleshooting

- `Garmin re-authorization required: no stored Garmin tokens...`
  - Cause: token storage not reachable or empty in current runtime.
  - Fix: verify `GARMIN_TOKEN_STORE`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`; reconnect OAuth once.

- `Request failed with status code 429`
  - Cause: Garmin rate limit.
  - Fix: wait and retry, keep request volume low, use `GARMIN_MAX_CONCURRENT_REQUESTS=1`.

- `Session not found`
  - Cause: stale/expired MCP session id.
  - Fix: reconnect client (Inspector/Claude), re-run call.

- `Vercel Runtime Timeout Error: Task timed out after 300 seconds`
  - Usually a long-lived/idle stream request in serverless runtime.
  - If tool calls still succeed in Claude, this is often non-fatal reconnect noise.

- `Unauthorized` on `/mcp`
  - With OAuth enabled, client must send valid OAuth bearer token.
  - For Inspector testing, use API-key fallback only if explicitly configured.

## Development

```bash
# clone your fork (or open this repo locally)
# git clone <your-fork-url>
# cd <repo-folder>
npm install
npm run typecheck
npm run build
```

## License

MIT

# garmin-connect-mcp

MCP server for Garmin Connect with:
- local stdio mode (Claude Desktop, Cursor, etc.)
- remote Streamable HTTP mode (Claude Web/Mobile)

The Garmin API flow is based on [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) by [cyberjunky](https://github.com/cyberjunky).

## What this repository runs

- `npm run start:stdio`: local MCP over stdio
- `npm start` / `npm run start:http`: HTTP MCP server
- Vercel serverless handlers in `api/*` for `/mcp`, `/health`, `/authorize`, `/token`

## Local usage (stdio)

Required env vars:
- `GARMIN_EMAIL`
- `GARMIN_PASSWORD`

Example:

```bash
GARMIN_EMAIL=you@email.com GARMIN_PASSWORD=yourpass npm run start:stdio
```

## Cloud usage (Vercel + Claude OAuth)

Current production flow:
1. Claude connects to `https://<your-domain>/mcp`
2. Claude starts OAuth (`/authorize`)
3. User enters Garmin credentials on the authorize page
4. Server stores Garmin tokens per OAuth subject
5. Tool calls use stored Garmin tokens

### Endpoints

- `GET /health`
- `POST|GET|DELETE /mcp`
- `GET|POST /authorize`
- `POST /token`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource/mcp`

### Minimal Vercel env setup

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
- `GARMIN_EMAIL` + `GARMIN_PASSWORD` (fallback when shared token storage is unavailable)
- `MCP_API_KEY` (+ `MCP_OAUTH_ALLOW_API_KEY_FALLBACK=true`) for inspector-style API-key testing

## Deploy on Vercel

```bash
npm install
npm run build
vercel --prod
```

Then add the custom connector in Claude:
- URL: `https://<your-domain>/mcp`
- OAuth Client ID: value of `MCP_OAUTH_CLIENT_ID`
- OAuth Client Secret: value of `MCP_OAUTH_CLIENT_SECRET`

## Notes

- Default tool policy is read-only (`MCP_ENABLE_WRITE_TOOLS=false`).
- Keep `GARMIN_MAX_CONCURRENT_REQUESTS` low in cloud runtimes to reduce Garmin 429 pressure.
- `GARMIN_TOKEN_STORE=vercel-kv` uses `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

## Development

```bash
git clone https://github.com/Nicolasvegam/garmin-connect-mcp.git
cd garmin-connect-mcp
npm install
npm run build
```

## License

MIT

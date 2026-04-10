# Garmin Connect MCP Server

MCP server for Garmin Connect in TypeScript. 61 tools for accessing fitness, health, and training data.

---

## 1. Project Structure

```
src/
  index.ts              Entry point: MCP server + stdio transport
  client/
    garmin-auth.ts       SSO authentication + OAuth1/OAuth2 (based on python-garminconnect)
    garmin.client.ts     Client with methods for each endpoint
    index.ts             Barrel
  constants/
    garmin-endpoints.ts  Garmin Connect API URLs
    index.ts             Barrel
  dtos/
    date-params.dto.ts   Date params (type + Zod schema)
    activities.dto.ts    Activity params
    devices.dto.ts       Device params
    index.ts             Barrel
  tools/
    activities.tools.ts  Activity tools (12)
    health.tools.ts      Daily health tools (14)
    trends.tools.ts      Trend tools (4)
    sleep.tools.ts       Sleep tools (2)
    body.tools.ts        Body composition tools (5)
    performance.tools.ts Performance and training tools (11)
    profile.tools.ts     Profile and device tools (13)
    index.ts             Barrel
```

---

## 2. DTOs: Explicit Type + Zod Schema

Each DTO has an explicit `type` and a parallel Zod `schema`. The type is never inferred from the schema with `z.infer<>`.

```typescript
export type DateRangeParamDto = {
  startDate: string;
  endDate: string;
};

export const dateRangeParamSchema = z.object({
  startDate: z.string().describe('Start date in YYYY-MM-DD format'),
  endDate: z.string().describe('End date in YYYY-MM-DD format'),
});
```

---

## 3. MCP Tools: `registerTool` Pattern

Each tool uses `server.registerTool` with a config object and `inputSchema` using `.shape` from the Zod schema.

```typescript
server.registerTool(
  'get_activities',
  {
    description: 'Get recent activities from Garmin Connect',
    inputSchema: getActivitiesSchema.shape,
  },
  async ({ start, limit }) => {
    const data = await client.getActivities(start ?? 0, limit ?? 20);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);
```

---

## 4. Barrel Exports

Each folder has an `index.ts` that re-exports everything. Imports use the folder path, without an extension.

```typescript
export { GarminClient } from './garmin.client';
```

```typescript
import { GarminClient } from './client';
import { dateParamSchema } from '../dtos';
```

---

## 5. Naming Conventions

| Pattern | Convention | Example |
|--------|-----------|---------|
| Classes | PascalCase | `GarminClient` |
| Variables/functions | camelCase | `getActivities`, `todayString` |
| Files | kebab-case | `garmin.client.ts`, `date-params.dto.ts` |
| Constants | UPPERCASE | `DAILY_HEART_RATE_ENDPOINT` |
| Booleans | `is/has` prefix | `isAuthenticated` |
| Functions | Start with a verb | `getSteps`, `ensureAuthenticated` |
| DTO types | `{Verb}{Thing}Dto` | `GetActivitiesDto` |
| DTO schemas | `{verb}{Thing}Schema` | `getActivitiesSchema` |
| Tool files | `{category}.tools.ts` | `health.tools.ts` |
| Register functions | `register{Cat}Tools` | `registerHealthTools` |

---

## 6. Technical Stack

| Component | Choice |
|------------|----------|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| HTTP Client | `axios` + `tough-cookie` |
| OAuth | `oauth-1.0a` (HMAC-SHA1) |
| Validation | `zod` |
| Transport | stdio |
| Build | `tsup` (ESM, node20 target) |
| Module Resolution | Bundler (no `.js` extensions in imports) |

---

## 7. Authentication

Flow based on `python-garminconnect` (cyberjunky) via `garth`:

1. Fetch OAuth consumer credentials from S3
2. SSO login (embed → signin → POST credentials → extract ticket)
3. Exchange ticket → OAuth1 token (HMAC-SHA1 signed)
4. Exchange OAuth1 → OAuth2 token (Bearer)
5. Auto-refresh OAuth2 on 401 using OAuth1
6. Tokens persisted in `~/.garmin-mcp/` (`oauth1_token.json`, `oauth2_token.json`)

---

## 8. Rules

- No comments in code
- Local imports without extension (no `.js` or `.ts`)
- External library imports with full path (`@modelcontextprotocol/sdk/server/mcp.js`)
- `console.error()` for logging (never `console.log` in stdio servers)
- Authentication via env vars `GARMIN_EMAIL` and `GARMIN_PASSWORD`
- Tokens cached in `~/.garmin-mcp/`
- Automatic retry with re-auth if a request fails with 401

import type { VercelRequest, VercelResponse } from '@vercel/node';

const enableWriteTools = (process.env.MCP_ENABLE_WRITE_TOOLS ?? 'false').toLowerCase() === 'true';
const oauthEnabled = (process.env.MCP_OAUTH_ENABLED ?? 'false').toLowerCase() === 'true';
const oauthAllowApiKeyFallback = (process.env.MCP_OAUTH_ALLOW_API_KEY_FALLBACK ?? 'true').toLowerCase() === 'true';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    status: 'ok',
    transport: 'streamable-http',
    platform: 'vercel',
    writeToolsEnabled: enableWriteTools,
    oauthEnabled,
    oauthAllowApiKeyFallback,
  });
}

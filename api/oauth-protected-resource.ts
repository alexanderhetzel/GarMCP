import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  buildBaseUrlFromHeaders,
  getOAuthConfigFromEnv,
  getOAuthProtectedResourceMetadata,
  isOAuthEnabled,
  validateOAuthConfig,
} from '../src/oauth/single-user-oauth.js';

const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const config = getOAuthConfigFromEnv();
  if (!isOAuthEnabled(config)) {
    res.status(404).json({ error: 'OAuth is disabled' });
    return;
  }

  const configErrors = validateOAuthConfig(config);
  if (configErrors.length > 0) {
    res.status(500).json({ error: 'OAuth configuration error', details: configErrors });
    return;
  }

  const baseUrl = buildBaseUrlFromHeaders(req.headers);
  res.status(200).json(getOAuthProtectedResourceMetadata(baseUrl, MCP_PATH));
}


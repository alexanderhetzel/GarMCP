import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createGarminServer } from '../src/server/index.js';
import { GarminClient } from '../src/client/index.js';
import {
  buildBaseUrlFromHeaders,
  getOAuthConfigFromEnv,
  getResourceMetadataUrl,
  isOAuthEnabled,
  validateOAuthConfig,
  verifyAccessToken,
} from '../src/oauth/single-user-oauth.js';

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
};

const garminEmail = process.env.GARMIN_EMAIL;
const garminPassword = process.env.GARMIN_PASSWORD;
const mcpApiKey = process.env.MCP_API_KEY?.trim();
const oauthAllowApiKeyFallback =
  (process.env.MCP_OAUTH_ALLOW_API_KEY_FALLBACK ?? 'true').toLowerCase() === 'true';
const mcpPath = process.env.MCP_PATH ?? '/mcp';
const oauthConfig = getOAuthConfigFromEnv();
const oauthEnabled = isOAuthEnabled(oauthConfig);
const oauthConfigErrors = validateOAuthConfig(oauthConfig);
const enableWriteTools = (process.env.MCP_ENABLE_WRITE_TOOLS ?? 'false').toLowerCase() === 'true';
const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const sessions = new Map<string, SessionContext>();
let sharedGarminClient: GarminClient | undefined;

function getSharedGarminClient(): GarminClient {
  if (!sharedGarminClient) {
    sharedGarminClient = new GarminClient(garminEmail!, garminPassword!);
  }
  return sharedGarminClient;
}

function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.length === 0) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  if (!isOriginAllowed(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,MCP-Session-Id,Authorization,X-API-Key');
  return true;
}

function getSessionId(req: VercelRequest): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  return undefined;
}

function getApiKeyFromHeaders(req: VercelRequest): string | undefined {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  if (Array.isArray(xApiKey) && xApiKey[0]?.trim()) return xApiKey[0].trim();

  const authHeader = req.headers.authorization;
  const rawAuth = typeof authHeader === 'string' ? authHeader : authHeader?.[0];
  if (!rawAuth) return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(rawAuth);
  return match?.[1]?.trim();
}

function isAuthorized(req: VercelRequest): boolean {
  if (oauthEnabled) {
    const authHeader = req.headers.authorization;
    const rawAuth = typeof authHeader === 'string' ? authHeader : authHeader?.[0];
    const match = rawAuth ? /^\s*Bearer\s+(.+?)\s*$/i.exec(rawAuth) : null;
    const bearerToken = match?.[1]?.trim();

    if (bearerToken) {
      try {
        verifyAccessToken(oauthConfig, bearerToken);
        return true;
      } catch {
        if (oauthAllowApiKeyFallback && mcpApiKey && bearerToken === mcpApiKey) {
          return true;
        }
      }
    }

    if (oauthAllowApiKeyFallback && mcpApiKey) {
      const providedApiKey = getApiKeyFromHeaders(req);
      if (providedApiKey && providedApiKey === mcpApiKey) {
        return true;
      }
    }

    return false;
  }

  if (!mcpApiKey) return true;
  const provided = getApiKeyFromHeaders(req);
  return !!provided && provided === mcpApiKey;
}

async function parseBody(req: VercelRequest): Promise<unknown> {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new Error('Invalid JSON body');
      }
    }
    return req.body;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function createStatefulTransport(): Promise<StreamableHTTPServerTransport> {
  const server = createGarminServer(garminEmail!, garminPassword!, {
    enableWriteTools,
    client: getSharedGarminClient(),
  });

  let initializedSessionId: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      initializedSessionId = sessionId;
      sessions.set(sessionId, {
        server,
        transport,
        lastSeenAt: Date.now(),
      });
    },
    onsessionclosed: (sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.server.close().catch(() => undefined);
      }
      sessions.delete(sessionId);
    },
  });

  transport.onclose = () => {
    if (!initializedSessionId) return;
    const existing = sessions.get(initializedSessionId);
    if (existing) {
      existing.server.close().catch(() => undefined);
      sessions.delete(initializedSessionId);
    }
  };

  await server.connect(transport);
  return transport;
}

function writeJson(res: VercelResponse, statusCode: number, payload: unknown): void {
  if (!res.headersSent) {
    res.status(statusCode).setHeader('Content-Type', 'application/json');
  }
  res.send(JSON.stringify(payload));
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!applyCors(req, res)) return;

  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (oauthEnabled && oauthConfigErrors.length > 0) {
    writeJson(res, 500, { error: 'OAuth configuration error', details: oauthConfigErrors });
    return;
  }

  if (!isAuthorized(req)) {
    if (oauthEnabled) {
      const baseUrl = buildBaseUrlFromHeaders(req.headers as Record<string, string | string[] | undefined>);
      const resourceMetadataUrl = getResourceMetadataUrl(baseUrl, mcpPath);
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="garmin-mcp", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="${resourceMetadataUrl}"`,
      );
    } else {
      res.setHeader('WWW-Authenticate', 'Bearer realm="garmin-mcp"');
    }
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (!garminEmail || !garminPassword) {
    writeJson(res, 500, {
      error: 'GARMIN_EMAIL and GARMIN_PASSWORD environment variables are required',
    });
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const sessionId = getSessionId(req);

  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (method === 'POST') {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
        return;
      }
      const initializeRequest = isInitializeRequest(body);

      if (!sessionId && !initializeRequest) {
        writeJson(res, 400, { error: 'Missing MCP-Session-Id header' });
        return;
      }

      if (!sessionId && initializeRequest) {
        const transport = await createStatefulTransport();
        await transport.handleRequest(req, res, body);
        return;
      }

      if (sessionId && initializeRequest) {
        writeJson(res, 400, { error: 'Initialize request must not include MCP-Session-Id' });
        return;
      }

      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return;
      }

      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId) {
      writeJson(res, 400, { error: 'Missing MCP-Session-Id header' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }

    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.error('Vercel MCP handler error:', error);
    if (!res.headersSent) {
      writeJson(res, 500, { error: 'Internal server error' });
    } else {
      res.end();
    }
  }
}

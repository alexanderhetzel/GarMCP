import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createGarminServer } from './server/index.js';
import { GarminClient } from './client/index.js';

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
};

const GARMIN_EMAIL = process.env.GARMIN_EMAIL;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD;

if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
  console.error(
    'Error: GARMIN_EMAIL and GARMIN_PASSWORD environment variables are required.\n' +
      'Set them in your deployment environment before starting the HTTP MCP server.',
  );
  process.exit(1);
}

const ENABLE_WRITE_TOOLS = (process.env.MCP_ENABLE_WRITE_TOOLS ?? 'false').toLowerCase() === 'true';
const MCP_API_KEY = process.env.MCP_API_KEY?.trim();
const RAW_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const MCP_PATH = normalizePath(process.env.MCP_PATH ?? '/mcp');
const PORT = parsePort(process.env.MCP_PORT ?? process.env.PORT ?? '8080');
const FAVICON_PNG_PATH = resolve(process.cwd(), 'public/favicon.png');

const sessions = new Map<string, SessionContext>();
let sharedGarminClient: GarminClient | undefined;
let faviconPng: Buffer | undefined;

try {
  faviconPng = readFileSync(FAVICON_PNG_PATH);
} catch {
  // Optional asset; server continues without favicon if file is absent.
}

function getSharedGarminClient(): GarminClient {
  if (!sharedGarminClient) {
    sharedGarminClient = new GarminClient(GARMIN_EMAIL!, GARMIN_PASSWORD!);
  }
  return sharedGarminClient;
}

function parsePort(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port "${raw}". Use a number between 1 and 65535.`);
  }
  return parsed;
}

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '/mcp';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function getRequestPath(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  return url.pathname;
}

function isMcpPath(path: string): boolean {
  if (path === MCP_PATH) return true;
  if (MCP_PATH === '/') return path === '/';
  return path === `${MCP_PATH}/`;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
  }
  res.end(JSON.stringify(payload));
}

function isOriginAllowed(origin: string): boolean {
  if (RAW_ALLOWED_ORIGINS.length === 0) return false;
  if (RAW_ALLOWED_ORIGINS.includes('*')) return true;
  return RAW_ALLOWED_ORIGINS.includes(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  if (!isOriginAllowed(origin)) {
    writeJson(res, 403, { error: 'Origin not allowed' });
    return false;
  }

  if (RAW_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,MCP-Session-Id,Authorization,X-API-Key');
  return true;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  return undefined;
}

function getApiKeyFromHeaders(req: IncomingMessage): string | undefined {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  if (Array.isArray(xApiKey) && xApiKey[0]?.trim()) return xApiKey[0].trim();

  const authHeader = req.headers.authorization;
  const rawAuth = typeof authHeader === 'string' ? authHeader : authHeader?.[0];
  if (!rawAuth) return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(rawAuth);
  return match?.[1]?.trim();
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!MCP_API_KEY) return true;
  const provided = getApiKeyFromHeaders(req);
  return !!provided && provided === MCP_API_KEY;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  if (!body) return undefined;

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function createStatefulTransport(): Promise<StreamableHTTPServerTransport> {
  const client = getSharedGarminClient();
  await client.prepare();
  const server = createGarminServer(GARMIN_EMAIL!, GARMIN_PASSWORD!, {
    enableWriteTools: ENABLE_WRITE_TOOLS,
    client,
  });

  let initializedSessionId: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      initializedSessionId = sessionId;
      sessions.set(sessionId, {
        server,
        transport,
        lastSeenAt: Date.now(),
      });
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });

  (transport as unknown as { onclose?: () => void }).onclose = () => {
    if (initializedSessionId) {
      sessions.delete(initializedSessionId);
    }
  };

  await server.connect(transport);
  return transport;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const sessionId = getSessionId(req);

  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request body' });
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
}

const httpServer = createServer(async (req, res) => {
  if (!applyCors(req, res)) return;

  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const path = getRequestPath(req);

  if ((path === '/favicon.ico' || path === '/favicon.png') && method === 'GET') {
    if (!faviconPng) {
      writeJson(res, 404, { error: 'Favicon not found' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(faviconPng);
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="garmin-mcp"');
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (path === '/health' && (req.method ?? 'GET').toUpperCase() === 'GET') {
    writeJson(res, 200, {
      status: 'ok',
      transport: 'streamable-http',
      sessions: sessions.size,
      writeToolsEnabled: ENABLE_WRITE_TOOLS,
    });
    return;
  }

  if (!isMcpPath(path)) {
    writeJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    console.error('MCP HTTP request failed:', error);
    if (!res.headersSent) {
      writeJson(res, 500, { error: 'Internal server error' });
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.error(`Garmin MCP HTTP server running on port ${PORT}`);
  console.error(`MCP endpoint: ${MCP_PATH}`);
  console.error(`Health endpoint: /health`);
  console.error(`Write tools enabled: ${ENABLE_WRITE_TOOLS}`);
  console.error(`API key protection enabled: ${Boolean(MCP_API_KEY)}`);
});

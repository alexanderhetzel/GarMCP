import crypto from 'node:crypto';

type OAuthMode = 'disabled' | 'enabled';
type TokenType = 'auth_code' | 'access' | 'refresh';

type SignedPayload = {
  typ: TokenType;
  cid: string;
  exp: number;
  scopes?: string[];
  redirectUri?: string;
  codeChallenge?: string;
  resource?: string;
  sub?: string;
};

export type OAuthRuntimeConfig = {
  mode: OAuthMode;
  clientId: string;
  clientSecret: string;
  ownerUsername: string;
  ownerPassword: string;
  signingSecret: string;
  allowedRedirectUris: string[];
  defaultScopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
};

export type VerifyTokenResult = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  subject: string;
  resource?: string;
};

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_AUTH_CODE_TTL_SECONDS = 60 * 5;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8');
}

function signingKey(config: OAuthRuntimeConfig): Buffer {
  return Buffer.from(config.signingSecret, 'utf8');
}

function signPayload(payloadB64: string, config: OAuthRuntimeConfig): string {
  return base64UrlEncode(crypto.createHmac('sha256', signingKey(config)).update(payloadB64).digest());
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function decodeAndVerify(token: string, config: OAuthRuntimeConfig): SignedPayload {
  const [payloadB64, signatureB64] = token.split('.');
  if (!payloadB64 || !signatureB64) {
    throw new Error('invalid_token_format');
  }

  const expected = signPayload(payloadB64, config);
  if (!safeEqual(signatureB64, expected)) {
    throw new Error('invalid_token_signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64)) as SignedPayload;
  if (!payload?.typ || !payload.exp || !payload.cid) {
    throw new Error('invalid_token_payload');
  }
  return payload;
}

function makeSignedToken(payload: SignedPayload, config: OAuthRuntimeConfig): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signatureB64 = signPayload(payloadB64, config);
  return `${payloadB64}.${signatureB64}`;
}

export function getOAuthConfigFromEnv(): OAuthRuntimeConfig {
  const mode: OAuthMode = (process.env.MCP_OAUTH_ENABLED ?? 'false').toLowerCase() === 'true'
    ? 'enabled'
    : 'disabled';

  const clientId = (process.env.MCP_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.MCP_OAUTH_CLIENT_SECRET ?? '').trim();
  const ownerUsername = (process.env.MCP_OAUTH_OWNER_USERNAME ?? process.env.GARMIN_EMAIL ?? '').trim();
  const ownerPassword = (process.env.MCP_OAUTH_OWNER_PASSWORD ?? '').trim();
  const signingSecret = (process.env.MCP_OAUTH_SIGNING_SECRET ?? '').trim();
  const allowedRedirectUris = (process.env.MCP_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const defaultScopes = (process.env.MCP_OAUTH_DEFAULT_SCOPES ?? 'mcp:read')
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const accessTokenTtlSeconds = parsePositiveInt(
    process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  );
  const refreshTokenTtlSeconds = parsePositiveInt(
    process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  );
  const authCodeTtlSeconds = parsePositiveInt(
    process.env.MCP_OAUTH_AUTH_CODE_TTL_SECONDS,
    DEFAULT_AUTH_CODE_TTL_SECONDS,
  );

  return {
    mode,
    clientId,
    clientSecret,
    ownerUsername,
    ownerPassword,
    signingSecret,
    allowedRedirectUris,
    defaultScopes,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    authCodeTtlSeconds,
  };
}

export function isOAuthEnabled(config: OAuthRuntimeConfig): boolean {
  return config.mode === 'enabled';
}

export function validateOAuthConfig(config: OAuthRuntimeConfig): string[] {
  if (!isOAuthEnabled(config)) return [];

  const errors: string[] = [];
  if (!config.clientId) errors.push('MCP_OAUTH_CLIENT_ID is required when MCP_OAUTH_ENABLED=true');
  if (!config.clientSecret) errors.push('MCP_OAUTH_CLIENT_SECRET is required when MCP_OAUTH_ENABLED=true');
  if (!config.ownerUsername) errors.push('MCP_OAUTH_OWNER_USERNAME (or GARMIN_EMAIL) is required when MCP_OAUTH_ENABLED=true');
  if (!config.ownerPassword) errors.push('MCP_OAUTH_OWNER_PASSWORD is required when MCP_OAUTH_ENABLED=true');
  if (!config.signingSecret) errors.push('MCP_OAUTH_SIGNING_SECRET is required when MCP_OAUTH_ENABLED=true');
  return errors;
}

export function buildBaseUrlFromHeaders(headers: Record<string, string | string[] | undefined>): URL {
  const forwardedProto = headers['x-forwarded-proto'];
  const forwardedHost = headers['x-forwarded-host'];
  const host = headers.host;

  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const resolvedProto = proto?.trim() || 'https';
  const resolvedHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || (Array.isArray(host) ? host[0] : host) || 'localhost:8080';
  return new URL(`${resolvedProto}://${resolvedHost}`);
}

export function getResourceMetadataUrl(baseUrl: URL, mcpPath = '/mcp'): string {
  const normalizedPath = mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`;
  const rsPath = normalizedPath === '/' ? '' : normalizedPath;
  return new URL(`/.well-known/oauth-protected-resource${rsPath}`, baseUrl).href;
}

export function getOAuthAuthorizationServerMetadata(baseUrl: URL): Record<string, unknown> {
  return {
    issuer: baseUrl.href.replace(/\/$/, ''),
    authorization_endpoint: new URL('/authorize', baseUrl).href,
    token_endpoint: new URL('/token', baseUrl).href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

export function getOAuthProtectedResourceMetadata(baseUrl: URL, mcpPath = '/mcp'): Record<string, unknown> {
  return {
    resource: new URL(mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`, baseUrl).href,
    authorization_servers: [baseUrl.href.replace(/\/$/, '')],
    scopes_supported: ['mcp:read'],
    resource_name: 'Garmin MCP',
  };
}

export function validateClient(config: OAuthRuntimeConfig, clientId: string, clientSecret?: string): boolean {
  if (!isOAuthEnabled(config)) return false;
  if (clientId !== config.clientId) return false;
  if (clientSecret !== undefined && clientSecret !== config.clientSecret) return false;
  return true;
}

export function isRedirectUriAllowed(config: OAuthRuntimeConfig, redirectUri: string): boolean {
  if (config.allowedRedirectUris.length === 0) return true;
  return config.allowedRedirectUris.includes(redirectUri);
}

export function verifyOwnerCredentials(config: OAuthRuntimeConfig, username: string, password: string): boolean {
  return username === config.ownerUsername && password === config.ownerPassword;
}

export function createAuthorizationCode(params: {
  config: OAuthRuntimeConfig;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes?: string[];
  resource?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return makeSignedToken(
    {
      typ: 'auth_code',
      cid: params.clientId,
      exp: now + params.config.authCodeTtlSeconds,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes && params.scopes.length > 0 ? params.scopes : params.config.defaultScopes,
      resource: params.resource,
      sub: params.config.ownerUsername,
    },
    params.config,
  );
}

function sha256Base64Url(input: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(input).digest());
}

export function exchangeAuthorizationCode(params: {
  config: OAuthRuntimeConfig;
  code: string;
  clientId: string;
  redirectUri?: string;
  codeVerifier: string;
  resource?: string;
}): {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
} {
  const payload = decodeAndVerify(params.code, params.config);
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== 'auth_code') throw new Error('invalid_grant');
  if (payload.exp <= now) throw new Error('invalid_grant');
  if (payload.cid !== params.clientId) throw new Error('invalid_grant');
  if (!payload.codeChallenge) throw new Error('invalid_grant');
  if (payload.redirectUri && params.redirectUri && payload.redirectUri !== params.redirectUri) throw new Error('invalid_grant');
  if (payload.resource && params.resource && payload.resource !== params.resource) throw new Error('invalid_target');

  const derivedChallenge = sha256Base64Url(params.codeVerifier);
  if (!safeEqual(derivedChallenge, payload.codeChallenge)) {
    throw new Error('invalid_grant');
  }

  const scopes = payload.scopes && payload.scopes.length > 0 ? payload.scopes : params.config.defaultScopes;
  const accessToken = makeSignedToken(
    {
      typ: 'access',
      cid: params.clientId,
      exp: now + params.config.accessTokenTtlSeconds,
      scopes,
      resource: payload.resource,
      sub: payload.sub ?? params.config.ownerUsername,
    },
    params.config,
  );
  const refreshToken = makeSignedToken(
    {
      typ: 'refresh',
      cid: params.clientId,
      exp: now + params.config.refreshTokenTtlSeconds,
      scopes,
      resource: payload.resource,
      sub: payload.sub ?? params.config.ownerUsername,
    },
    params.config,
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: params.config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

export function exchangeRefreshToken(params: {
  config: OAuthRuntimeConfig;
  refreshToken: string;
  clientId: string;
  requestedScopes?: string[];
  resource?: string;
}): {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
} {
  const payload = decodeAndVerify(params.refreshToken, params.config);
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== 'refresh') throw new Error('invalid_grant');
  if (payload.exp <= now) throw new Error('invalid_grant');
  if (payload.cid !== params.clientId) throw new Error('invalid_grant');
  if (payload.resource && params.resource && payload.resource !== params.resource) throw new Error('invalid_target');

  const originalScopes = payload.scopes && payload.scopes.length > 0 ? payload.scopes : params.config.defaultScopes;
  const requestedScopes = params.requestedScopes && params.requestedScopes.length > 0 ? params.requestedScopes : originalScopes;
  const isSubset = requestedScopes.every((scope) => originalScopes.includes(scope));
  if (!isSubset) throw new Error('invalid_scope');

  const accessToken = makeSignedToken(
    {
      typ: 'access',
      cid: params.clientId,
      exp: now + params.config.accessTokenTtlSeconds,
      scopes: requestedScopes,
      resource: payload.resource,
      sub: payload.sub ?? params.config.ownerUsername,
    },
    params.config,
  );

  const rotatedRefreshToken = makeSignedToken(
    {
      typ: 'refresh',
      cid: params.clientId,
      exp: now + params.config.refreshTokenTtlSeconds,
      scopes: requestedScopes,
      resource: payload.resource,
      sub: payload.sub ?? params.config.ownerUsername,
    },
    params.config,
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: params.config.accessTokenTtlSeconds,
    refresh_token: rotatedRefreshToken,
    scope: requestedScopes.join(' '),
  };
}

export function verifyAccessToken(config: OAuthRuntimeConfig, token: string): VerifyTokenResult {
  const payload = decodeAndVerify(token, config);
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== 'access') throw new Error('invalid_token');
  if (payload.exp <= now) throw new Error('invalid_token');
  if (payload.cid !== config.clientId) throw new Error('invalid_token');

  return {
    clientId: payload.cid,
    scopes: payload.scopes && payload.scopes.length > 0 ? payload.scopes : config.defaultScopes,
    expiresAt: payload.exp,
    subject: payload.sub ?? config.ownerUsername,
    resource: payload.resource,
  };
}


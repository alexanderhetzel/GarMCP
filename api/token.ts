import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getOAuthConfigFromEnv,
  isOAuthEnabled,
  validateClient,
  validateOAuthConfig,
} from '../src/oauth/single-user-oauth.js';

type FormBody = Record<string, string>;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function parseFormBody(req: VercelRequest): Promise<FormBody> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const record = req.body as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, readString(value)]));
  }

  if (typeof req.body === 'string') {
    const params = new URLSearchParams(req.body);
    return Object.fromEntries(params.entries());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function writeOAuthError(res: VercelResponse, code: string, description?: string): void {
  const payload: Record<string, string> = { error: code };
  if (description) payload.error_description = description;
  res.status(400).json(payload);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
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

  res.setHeader('Cache-Control', 'no-store');

  const form = await parseFormBody(req);
  const grantType = readString(form.grant_type);
  const clientId = readString(form.client_id);
  const clientSecret = readString(form.client_secret);

  if (!clientId || !clientSecret || !validateClient(config, clientId, clientSecret)) {
    writeOAuthError(res, 'invalid_client');
    return;
  }

  try {
    if (grantType === 'authorization_code') {
      const code = readString(form.code);
      const codeVerifier = readString(form.code_verifier);
      const redirectUri = readString(form.redirect_uri) || undefined;
      const resource = readString(form.resource) || undefined;

      if (!code || !codeVerifier) {
        writeOAuthError(res, 'invalid_request', 'code and code_verifier are required');
        return;
      }

      const tokenSet = exchangeAuthorizationCode({
        config,
        code,
        clientId,
        codeVerifier,
        redirectUri,
        resource,
      });
      res.status(200).json(tokenSet);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = readString(form.refresh_token);
      const scope = readString(form.scope);
      const requestedScopes = scope
        ? scope.split(' ').map((entry) => entry.trim()).filter(Boolean)
        : undefined;
      const resource = readString(form.resource) || undefined;
      if (!refreshToken) {
        writeOAuthError(res, 'invalid_request', 'refresh_token is required');
        return;
      }

      const tokenSet = exchangeRefreshToken({
        config,
        refreshToken,
        clientId,
        requestedScopes,
        resource,
      });
      res.status(200).json(tokenSet);
      return;
    }

    writeOAuthError(res, 'unsupported_grant_type');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'server_error';
    if (message === 'invalid_scope') {
      writeOAuthError(res, 'invalid_scope');
      return;
    }
    if (message === 'invalid_target') {
      writeOAuthError(res, 'invalid_target');
      return;
    }
    if (message === 'invalid_grant') {
      writeOAuthError(res, 'invalid_grant');
      return;
    }
    writeOAuthError(res, 'server_error');
  }
}


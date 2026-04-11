import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createAuthorizationCode,
  getOAuthConfigFromEnv,
  isOAuthEnabled,
  isRedirectUriAllowed,
  validateClient,
  validateOAuthConfig,
  verifyOwnerCredentials,
} from '../src/oauth/single-user-oauth.js';

type AuthorizeParams = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  resource?: string;
};

function readString(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

function htmlEscape(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractParams(req: VercelRequest): AuthorizeParams {
  const source = req.query;
  return {
    response_type: readString(source.response_type),
    client_id: readString(source.client_id),
    redirect_uri: readString(source.redirect_uri),
    code_challenge: readString(source.code_challenge),
    code_challenge_method: readString(source.code_challenge_method),
    state: readString(source.state) || undefined,
    scope: readString(source.scope) || undefined,
    resource: readString(source.resource) || undefined,
  };
}

function extractParamsFromRecord(source: Record<string, unknown>): AuthorizeParams {
  return {
    response_type: readString(source.response_type),
    client_id: readString(source.client_id),
    redirect_uri: readString(source.redirect_uri),
    code_challenge: readString(source.code_challenge),
    code_challenge_method: readString(source.code_challenge_method),
    state: readString(source.state) || undefined,
    scope: readString(source.scope) || undefined,
    resource: readString(source.resource) || undefined,
  };
}

async function parseFormBody(req: VercelRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>;
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

function validateAuthorizeParams(params: AuthorizeParams): string | undefined {
  if (params.response_type !== 'code') return 'unsupported_response_type';
  if (!params.client_id) return 'invalid_request';
  if (!params.redirect_uri) return 'invalid_request';
  if (!params.code_challenge) return 'invalid_request';
  if (params.code_challenge_method !== 'S256') return 'invalid_request';
  try {
    new URL(params.redirect_uri);
  } catch {
    return 'invalid_request';
  }
  return undefined;
}

function renderAuthorizeForm(params: AuthorizeParams, message?: string): string {
  const fields = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'state',
    'scope',
    'resource',
  ] as const;

  const hiddenFields = fields
    .map((field) => {
      const value = params[field];
      if (!value) return '';
      return `<input type="hidden" name="${field}" value="${htmlEscape(value)}" />`;
    })
    .join('\n');

  const errorBlock = message ? `<p style="color:#b00020">${htmlEscape(message)}</p>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Garmin MCP Authorization</title>
  </head>
  <body style="font-family: sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px;">
    <h1>Authorize Garmin MCP</h1>
    <p>Sign in to allow Claude access to your Garmin MCP tools.</p>
    ${errorBlock}
    <form method="POST">
      ${hiddenFields}
      <label for="username">Username</label>
      <input id="username" name="username" type="text" required style="display:block;width:100%;margin:6px 0 16px;padding:8px;" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required style="display:block;width:100%;margin:6px 0 16px;padding:8px;" />
      <button type="submit" style="padding:8px 14px;">Authorize</button>
    </form>
  </body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
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

  let formBody: Record<string, unknown> = {};
  let effectiveParams: AuthorizeParams;
  if (method === 'GET') {
    effectiveParams = extractParams(req);
  } else {
    formBody = await parseFormBody(req);
    effectiveParams = extractParamsFromRecord(formBody);
  }
  const paramsError = validateAuthorizeParams(effectiveParams);
  if (paramsError) {
    res.status(400).json({ error: paramsError });
    return;
  }

  if (!validateClient(config, effectiveParams.client_id)) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }

  if (!isRedirectUriAllowed(config, effectiveParams.redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
    return;
  }

  if (method === 'GET') {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAuthorizeForm(effectiveParams));
    return;
  }

  const username = readString((formBody ?? {}).username);
  const password = readString((formBody ?? {}).password);

  if (!verifyOwnerCredentials(config, username, password)) {
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAuthorizeForm(effectiveParams, 'Invalid credentials'));
    return;
  }

  const scopes = effectiveParams.scope
    ? effectiveParams.scope.split(' ').map((entry) => entry.trim()).filter(Boolean)
    : config.defaultScopes;

  const code = createAuthorizationCode({
    config,
    clientId: effectiveParams.client_id,
    redirectUri: effectiveParams.redirect_uri,
    codeChallenge: effectiveParams.code_challenge,
    scopes,
    resource: effectiveParams.resource,
  });

  const redirectUri = new URL(effectiveParams.redirect_uri);
  redirectUri.searchParams.set('code', code);
  if (effectiveParams.state) redirectUri.searchParams.set('state', effectiveParams.state);
  res.redirect(302, redirectUri.toString());
}

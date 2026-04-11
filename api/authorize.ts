import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createAuthorizationCode,
  getOAuthConfigFromEnv,
  isOAuthEnabled,
  isRedirectUriAllowed,
  validateClient,
  validateOAuthConfig,
  verifyOwnerCredentials,
} from "../src/oauth/single-user-oauth.js";

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
  return typeof input === "string" ? input.trim() : "";
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function htmlEscape(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAuthorizeForm(
  params: AuthorizeParams,
  options?: { message?: string; username?: string },
): string {
  const fields = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ] as const;

  const hiddenFields = fields
    .map((field) => {
      const value = params[field];
      if (!value) return "";
      return `<input type="hidden" name="${field}" value="${htmlEscape(value)}" />`;
    })
    .join("\n");

  const errorBlock = options?.message
    ? `<p class="notice notice--error" role="alert">${htmlEscape(options.message)}</p>`
    : "";

  const usernameValue = options?.username ? htmlEscape(options.username) : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GarMCP Authorization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg0: #02060a;
        --bg1: #070e14;
        --panel: #0a1219;
        --panel-2: #111b24;
        --line: #233342;
        --line-soft: #1a2835;
        --text: #eef6fc;
        --muted: #8ea4b6;
        --accent: #11a9ed;
        --accent-2: #0a8ec9;
        --danger: #ff6e77;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(1100px 680px at 100% -10%, rgba(17, 169, 237, 0.16), transparent 62%),
          repeating-radial-gradient(circle at 92% -5%, rgba(109, 207, 246, 0.08) 0 1px, transparent 1px 24px),
          linear-gradient(160deg, var(--bg0), var(--bg1));
        display: grid;
        place-items: center;
        padding: 14px;
      }
      .auth-shell {
        width: 100%;
        max-width: 520px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(13, 21, 29, 0.96), rgba(8, 14, 19, 0.96));
        box-shadow: 0 24px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.03);
      }
      .topbar {
        height: 6px;
        background: linear-gradient(90deg, var(--accent-2), var(--accent), var(--accent-2));
      }
      .content {
        padding: 18px 18px 16px;
      }
      .brand {
        display: flex;
        align-items: center;
        margin-bottom: 14px;
      }
      .brand-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .logo-box {
        width: 192px;
        height: 64px;
        place-items: center;
      }
      .logo-box img {
        width: 192px;
        height: 64px;
        object-fit: contain;
      }
      h1 {
        margin: 0 0 6px;
        font-family: "Barlow Condensed", "Segoe UI", sans-serif;
        font-size: clamp(1.72rem, 6.2vw, 2.18rem);
        font-weight: 700;
        letter-spacing: 0.01em;
        text-transform: uppercase;
      }
      .subtitle {
        margin: 0 0 14px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.45;
      }
      .notice {
        margin: 0 0 12px;
        border: 1px solid rgba(255, 110, 119, 0.4);
        background: rgba(255, 110, 119, 0.1);
        color: var(--danger);
        padding: 8px 10px;
        font-size: 13px;
      }
      .panel {
        border: 1px solid var(--line-soft);
        background: linear-gradient(180deg, var(--panel), var(--panel-2));
        padding: 12px;
      }
      form {
        margin: 0;
      }
      label {
        display: block;
        margin: 0 0 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #aac2d2;
      }
      .field + .field {
        margin-top: 10px;
      }
      input {
        width: 100%;
        min-height: 42px;
        border: 1px solid #2a3d4e;
        background: #0b141c;
        color: var(--text);
        font-size: 15px;
        padding: 9px 10px;
        outline: none;
      }
      input::placeholder {
        color: #6f8798;
      }
      input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(17, 169, 237, 0.2);
      }
      .actions {
        margin-top: 12px;
      }
      button {
        width: 100%;
        min-height: 42px;
        border: 1px solid #0c97d7;
        background: linear-gradient(180deg, #1ab3ee, #0b8fcb);
        color: #04121a;
        font-family: "Barlow Condensed", "Segoe UI", sans-serif;
        font-size: 1rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
      }
      button:hover {
        filter: brightness(1.04);
      }
      button:active {
        transform: translateY(1px);
      }
      button:focus-visible {
        outline: 2px solid rgba(17, 169, 237, 0.45);
        outline-offset: 1px;
      }
      .tech-row {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }
      .tech {
        border: 1px solid #2a3d4e;
        background: #0f1821;
        color: #b7cfde;
        min-height: 30px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        display: grid;
        place-items: center;
      }
      .meta {
        margin-top: 10px;
        color: #7f95a6;
        font-size: 12px;
        line-height: 1.45;
      }
      .meta strong {
        color: #d7e8f5;
      }
      @media (min-width: 700px) {
        .content {
          padding: 20px 20px 18px;
        }
      }
    </style>
  </head>
  <body>
    <main class="auth-shell" aria-labelledby="title">
      <div class="topbar" aria-hidden="true"></div>
      <section class="content">
        <div class="brand">
          <div class="brand-left">
            <div class="logo-box">
              <img src="/branding/GarMCP_logo_white.svg" alt="GarMCP Logo" />
            </div>
          </div>
        </div>
        <h1 id="title">Authorize Connector Access</h1>
        <p class="subtitle">Sign in to permit a secure read session for your fitness data in Claude.</p>
        ${errorBlock}
        <section class="panel" aria-label="Authorization form panel">
          <form method="POST" autocomplete="on">
            ${hiddenFields}
            <div class="field">
              <label for="username">Account Username</label>
              <input id="username" name="username" type="text" required autocomplete="username" value="${usernameValue}" placeholder="Connector username" />
            </div>
            <div class="field">
              <label for="password">Connector Password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Connector password" />
            </div>
            <div class="actions">
              <button type="submit">Authorize</button>
            </div>
          </form>
        </section>
        <p class="meta"><strong>Notice:</strong> Independent third-party connector. Not affiliated with or endorsed by Garmin Ltd.</p>
      </section>
    </main>
  </body>
</html>`;
}

function renderRedirectPage(redirectUrl: string): string {
  const safeUrl = htmlEscape(redirectUrl);
  const targetJson = JSON.stringify(redirectUrl);
  const autoRedirect = readBooleanEnv("MCP_OAUTH_AUTO_REDIRECT", true);
  const parsedDelay = Number.parseInt(
    process.env.MCP_OAUTH_REDIRECT_DELAY_MS ?? "700",
    10,
  );
  const delayMs =
    Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 700;
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const metaRefreshTag = autoRedirect
    ? `<meta http-equiv="refresh" content="${delaySeconds};url=${safeUrl}" />`
    : "";
  const redirectText = autoRedirect
    ? `Session verified. Redirecting back to Claude in ${delaySeconds}s.`
    : "Session verified. Automatic redirect is disabled for this environment.";
  const scriptBlock = autoRedirect
    ? `<script>
      const target = ${targetJson};
      window.setTimeout(() => {
        window.location.replace(target);
      }, ${delayMs});
    </script>`
    : "";
  let destinationLabel = redirectUrl;
  try {
    const parsed = new URL(redirectUrl);
    destinationLabel = `${parsed.origin}${parsed.pathname}`;
  } catch {
    destinationLabel = redirectUrl;
  }
  const safeDestinationLabel = htmlEscape(destinationLabel);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorization Complete</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
    ${metaRefreshTag}
    <style>
      :root {
        --bg0: #02060a;
        --bg1: #070e14;
        --line: #233342;
        --panel: #0b131b;
        --text: #eef6fc;
        --muted: #8ea4b6;
        --accent: #11a9ed;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 14px;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(900px 620px at 100% -10%, rgba(17, 169, 237, 0.15), transparent 65%),
          repeating-radial-gradient(circle at 90% -4%, rgba(109, 207, 246, 0.07) 0 1px, transparent 1px 22px),
          linear-gradient(160deg, var(--bg0), var(--bg1));
      }
      .shell {
        width: 100%;
        max-width: 500px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(13, 20, 28, 0.96), rgba(8, 13, 18, 0.96));
        box-shadow: 0 24px 52px rgba(0, 0, 0, 0.48);
      }
      .topbar {
        height: 6px;
        background: linear-gradient(90deg, #0a8ec9, #11a9ed, #0a8ec9);
      }
      .content {
        padding: 18px;
        text-align: center;
      }
      .logo {
        width: 128px;
        height: 64px;
        margin: 0 auto 10px;
        display: block;
      }
      h1 {
        margin: 0 0 8px;
        font-family: "Barlow Condensed", "Segoe UI", sans-serif;
        font-size: clamp(1.5rem, 6vw, 2rem);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }
      .meter {
        margin: 14px auto;
        width: 100%;
        max-width: 260px;
        height: 8px;
        border: 1px solid #254053;
        background: #09131b;
        overflow: hidden;
      }
      .meter > span {
        display: block;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, #0a8ec9, #11a9ed);
        animation: sweep 1s ease-in-out infinite;
        transform-origin: left;
      }
      .cta {
        margin-top: 10px;
      }
      .btn {
        display: inline-block;
        min-height: 38px;
        line-height: 38px;
        padding: 0 14px;
        border: 1px solid #0c97d7;
        background: linear-gradient(180deg, #1ab3ee, #0b8fcb);
        color: #04121a;
        text-decoration: none;
        font-family: "Barlow Condensed", "Segoe UI", sans-serif;
        font-size: 0.98rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      code {
        margin-top: 10px;
        display: inline-block;
        max-width: 100%;
        overflow-wrap: anywhere;
        border: 1px solid #284050;
        background: var(--panel);
        color: #c6dceb;
        padding: 6px 8px;
        font-size: 11px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      @keyframes sweep {
        0% { transform: scaleX(0.15); opacity: 0.4; }
        50% { transform: scaleX(1); opacity: 1; }
        100% { transform: scaleX(0.15); opacity: 0.4; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="topbar" aria-hidden="true"></div>
      <section class="content">
        <img class="logo" src="/branding/GarMCP_logo_white.svg" alt="GarMCP Logo" />
        <h1>Authorization Successful</h1>
        <p>${redirectText}</p>
        <div class="meter" aria-hidden="true"><span></span></div>
        <div class="cta">
          <a class="btn" href="${safeUrl}">Continue</a>
        </div>
      </section>
    </main>
    ${scriptBlock}
  </body>
</html>`;
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

function extractParamsFromRecord(
  source: Record<string, unknown>,
): AuthorizeParams {
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

async function parseFormBody(
  req: VercelRequest,
): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>;
  }

  if (typeof req.body === "string") {
    const params = new URLSearchParams(req.body);
    return Object.fromEntries(params.entries());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function validateAuthorizeParams(params: AuthorizeParams): string | undefined {
  if (params.response_type !== "code") return "unsupported_response_type";
  if (!params.client_id) return "invalid_request";
  if (!params.redirect_uri) return "invalid_request";
  if (!params.code_challenge) return "invalid_request";
  if (params.code_challenge_method !== "S256") return "invalid_request";
  try {
    new URL(params.redirect_uri);
  } catch {
    return "invalid_request";
  }
  return undefined;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const config = getOAuthConfigFromEnv();
  if (!isOAuthEnabled(config)) {
    res.status(404).json({ error: "OAuth is disabled" });
    return;
  }

  const configErrors = validateOAuthConfig(config);
  if (configErrors.length > 0) {
    res
      .status(500)
      .json({ error: "OAuth configuration error", details: configErrors });
    return;
  }
  res.setHeader("Cache-Control", "no-store");

  let formBody: Record<string, unknown> = {};
  let effectiveParams: AuthorizeParams;
  if (method === "GET") {
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
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (!isRedirectUriAllowed(config, effectiveParams.redirect_uri)) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "Unregistered redirect_uri",
    });
    return;
  }

  if (method === "GET") {
    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderAuthorizeForm(effectiveParams));
    return;
  }

  const username = readString((formBody ?? {}).username);
  const password = readString((formBody ?? {}).password);

  if (!verifyOwnerCredentials(config, username, password)) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderAuthorizeForm(effectiveParams, {
        message: "Invalid credentials",
        username,
      }),
    );
    return;
  }

  const scopes = effectiveParams.scope
    ? effectiveParams.scope
        .split(" ")
        .map((entry) => entry.trim())
        .filter(Boolean)
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
  redirectUri.searchParams.set("code", code);
  if (effectiveParams.state)
    redirectUri.searchParams.set("state", effectiveParams.state);
  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRedirectPage(redirectUri.toString()));
}

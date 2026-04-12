import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const SSO_SIGNIN = 'https://sso.garmin.com/sso/signin';
const SSO_ORIGIN = 'https://sso.garmin.com';
const GARMIN_CONNECT_API = 'https://connectapi.garmin.com';
const OAUTH_PREAUTHORIZED = `${GARMIN_CONNECT_API}/oauth-service/oauth/preauthorized`;
const OAUTH_EXCHANGE = `${GARMIN_CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
const PROFILE_URL = `${GARMIN_CONNECT_API}/userprofile-service/socialProfile`;

const SSO_CLIENT_ID = 'GarminConnect';
const SSO_LOCALE = 'en';
const SSO_WIDGET_ID = 'gauth-widget';

const USER_AGENT_MOBILE = 'com.garmin.android.apps.connectmobile';
const USER_AGENT_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CSRF_REGEX = /name="_csrf"\s+value="(.+?)"/;
const TICKET_REGEX = /ticket=([^"]+)"/;
const TITLE_REGEX = /<title>(.+?)<\/title>/;
const SSO_VERIFY_MFA = 'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode';

export function resolveGarminTokenDir(configured?: string): string {
  if (!configured) return path.join(os.homedir(), '.garmin-mcp');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
  return path.isAbsolute(configured) ? configured : path.resolve(configured);
}
const OAUTH1_TOKEN_FILE = 'oauth1_token.json';
const OAUTH2_TOKEN_FILE = 'oauth2_token.json';
const PROFILE_FILE = 'profile.json';

const MAX_REQUEST_RETRIES = 3;
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const MAX_CONCURRENT_REQUESTS = Number.parseInt(
  process.env.GARMIN_MAX_CONCURRENT_REQUESTS ?? String(DEFAULT_MAX_CONCURRENT_REQUESTS),
  10,
);
const DEFAULT_TOKEN_STORE_MODE = 'filesystem';

type TokenStoreMode = 'filesystem' | 'vercel-kv';

type VercelKvResponse<T> = {
  result: T;
  error?: string;
};

function resolveTokenStoreMode(): TokenStoreMode {
  const raw = (process.env.GARMIN_TOKEN_STORE ?? DEFAULT_TOKEN_STORE_MODE).trim().toLowerCase();
  if (raw === 'vercel-kv' || raw === 'kv') return 'vercel-kv';
  return 'filesystem';
}

function tokenNamespaceFromDir(tokenDir: string): string {
  const normalized = tokenDir.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts[parts.length - 1];
  if (tail && /^[a-f0-9]{16,}$/i.test(tail)) return tail.toLowerCase();
  return crypto.createHash('sha256').update(tokenDir).digest('hex').slice(0, 32);
}

let activeRequestCount = 0;
const requestWaitQueue: Array<() => void> = [];

async function acquireRequestSlot(): Promise<void> {
  if (!Number.isFinite(MAX_CONCURRENT_REQUESTS) || MAX_CONCURRENT_REQUESTS <= 0) return;
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => {
      requestWaitQueue.push(resolve);
    });
  }
  activeRequestCount += 1;
}

function releaseRequestSlot(): void {
  if (!Number.isFinite(MAX_CONCURRENT_REQUESTS) || MAX_CONCURRENT_REQUESTS <= 0) return;
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  const next = requestWaitQueue.shift();
  if (next) next();
}

async function withRequestSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquireRequestSlot();
  try {
    return await task();
  } finally {
    releaseRequestSlot();
  }
}

type OAuth1Token = {
  oauth_token: string;
  oauth_token_secret: string;
};

type OAuth2Token = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token_expires_in: number;
  refresh_token_expires_at: number;
};

type OAuthConsumer = {
  consumer_key: string;
  consumer_secret: string;
};

type UserProfile = {
  displayName: string;
  profileId: number;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export type GarminAuthOptions = {
  tokenDir?: string;
  persistTokens?: boolean;
};

export class GarminAuth {
  private email: string;
  private password: string;
  private consumer: OAuthConsumer | null = null;
  private oauth1Token: OAuth1Token | null = null;
  private oauth2Token: OAuth2Token | null = null;
  private profile: UserProfile | null = null;
  private isAuthenticated = false;
  private authInFlight: Promise<void> | null = null;
  private tokenLoadInFlight: Promise<void> | null = null;
  private tokensLoaded = false;
  private promptMfa?: () => Promise<string>;
  private readonly tokenDir: string;
  private readonly persistTokens: boolean;
  private readonly tokenStoreMode: TokenStoreMode;
  private readonly tokenNamespace: string;
  private readonly kvUrl?: string;
  private readonly kvToken?: string;

  get displayName(): string {
    return this.profile?.displayName ?? '';
  }

  get userProfilePk(): number {
    return this.profile?.profileId ?? 0;
  }

  constructor(
    email: string,
    password: string,
    promptMfa?: () => Promise<string>,
    options?: GarminAuthOptions,
  ) {
    this.email = email;
    this.password = password;
    this.promptMfa = promptMfa;
    this.tokenDir = resolveGarminTokenDir(options?.tokenDir ?? process.env.GARMIN_TOKEN_DIR?.trim());
    this.persistTokens = options?.persistTokens ?? true;
    this.tokenStoreMode = resolveTokenStoreMode();
    this.tokenNamespace = tokenNamespaceFromDir(this.tokenDir);
    this.kvUrl = process.env.KV_REST_API_URL?.trim();
    this.kvToken = process.env.KV_REST_API_TOKEN?.trim();

    if (this.tokenStoreMode === 'filesystem') {
      this.loadTokensFromFilesystem();
      this.tokensLoaded = true;
    }
  }

  async prepare(): Promise<void> {
    await this.ensureAuthenticated();
  }

  async request<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    await this.ensureAuthenticated();

    const url = endpoint.startsWith('http') ? endpoint : `${GARMIN_CONNECT_API}${endpoint}`;
    const method = (options?.method ?? 'GET').toUpperCase();
    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.oauth2Token!.access_token}`,
      'User-Agent': USER_AGENT_MOBILE,
      ...options?.headers,
    };

    if (options?.body && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt++) {
      try {
        const response = await withRequestSlot(() => axios<T>({
          url,
          method,
          headers: reqHeaders,
          data: options?.body,
        }));
        return response.data;
      } catch (error: unknown) {
        if (!axios.isAxiosError(error)) throw error;

        const status = error.response?.status;

        if (status === 401 && attempt === 0) {
          await this.refreshOrRelogin();
          reqHeaders.Authorization = `Bearer ${this.oauth2Token!.access_token}`;
          continue;
        }

        if ((status === 429 || (status && status >= 500)) && attempt < MAX_REQUEST_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new Error('Max retries exceeded');
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.isAuthenticated && this.oauth2Token && !this.isOAuth2Expired() && this.profile) return;
    await this.ensureTokensLoaded();
    await this.withAuthInFlight(async () => {
      if (this.isAuthenticated && this.oauth2Token && !this.isOAuth2Expired() && this.profile) return;

      if (this.oauth1Token && this.oauth2Token && !this.isOAuth2Expired() && this.profile) {
        this.isAuthenticated = true;
        return;
      }

      if (this.oauth1Token && this.oauth2Token && !this.isOAuth2Expired() && !this.profile) {
        await this.fetchProfile();
        await this.saveTokens();
        this.isAuthenticated = true;
        return;
      }

      if (this.oauth1Token) {
        await this.exchangeOAuth1ForOAuth2();
        await this.fetchProfile();
        await this.saveTokens();
        this.isAuthenticated = true;
        return;
      }

      if (!this.email || !this.password) {
        throw new Error('Garmin re-authorization required: no stored Garmin tokens and no credentials available');
      }

      await this.login();
      this.isAuthenticated = true;
    });
  }

  private async refreshOrRelogin(): Promise<void> {
    await this.ensureTokensLoaded();
    await this.withAuthInFlight(async () => {
      this.isAuthenticated = false;

      if (this.oauth1Token) {
        try {
          await this.exchangeOAuth1ForOAuth2();
          if (!this.profile) await this.fetchProfile();
          await this.saveTokens();
          this.isAuthenticated = true;
          return;
        } catch (error) {
          console.error('OAuth2 refresh failed, will re-login:', error);
        }
      }

      if (!this.email || !this.password) {
        throw new Error('Garmin re-authorization required: stored Garmin tokens are invalid and no credentials are available');
      }

      await this.login();
      this.isAuthenticated = true;
    });
  }

  private async withAuthInFlight(task: () => Promise<void>): Promise<void> {
    if (this.authInFlight) {
      await this.authInFlight;
      return;
    }

    const inFlight = task();
    this.authInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.authInFlight === inFlight) {
        this.authInFlight = null;
      }
    }
  }

  private async login(): Promise<void> {
    console.error('Authenticating with Garmin Connect...');

    await this.fetchOAuthConsumer();
    const ticket = await this.getLoginTicket();
    await this.exchangeTicketForOAuth1(ticket);
    await this.exchangeOAuth1ForOAuth2();
    await this.fetchProfile();
    await this.saveTokens();

    console.error('Authentication successful');
  }

  private async fetchProfile(): Promise<void> {
    const response = await axios.get<Record<string, unknown>>(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${this.oauth2Token!.access_token}`,
        'User-Agent': USER_AGENT_MOBILE,
      },
    });

    const displayName = response.data.displayName as string;
    const profileId = response.data.profileId as number ?? response.data.userProfileNumber as number;

    if (!displayName) throw new Error('Failed to get display name from profile');

    this.profile = { displayName, profileId };
  }

  private async fetchOAuthConsumer(): Promise<void> {
    if (this.consumer) return;

    const response = await axios.get<OAuthConsumer>(OAUTH_CONSUMER_URL);
    this.consumer = response.data;
  }

  private async getLoginTicket(): Promise<string> {
    const jar = new CookieJar();
    const ssoClient = wrapper(axios.create({ jar, withCredentials: true }));

    await ssoClient.get(SSO_EMBED, {
      params: { clientId: SSO_CLIENT_ID, locale: SSO_LOCALE, service: SSO_EMBED },
      headers: { 'User-Agent': USER_AGENT_BROWSER },
    });

    const signinParams = {
      id: SSO_WIDGET_ID,
      embedWidget: true,
      locale: SSO_LOCALE,
      gauthHost: SSO_EMBED,
    };

    const signinResponse = await ssoClient.get(SSO_SIGNIN, {
      params: signinParams,
      headers: { 'User-Agent': USER_AGENT_BROWSER },
    });

    const csrfMatch = CSRF_REGEX.exec(signinResponse.data);
    if (!csrfMatch) throw new Error('Failed to extract CSRF token from SSO');
    const csrfToken = csrfMatch[1];

    const loginResponse = await ssoClient.post(SSO_SIGNIN, new URLSearchParams({
      username: this.email,
      password: this.password,
      embed: 'true',
      _csrf: csrfToken!,
    }).toString(), {
      params: {
        ...signinParams,
        clientId: SSO_CLIENT_ID,
        service: SSO_EMBED,
        source: SSO_EMBED,
        redirectAfterAccountLoginUrl: SSO_EMBED,
        redirectAfterAccountCreationUrl: SSO_EMBED,
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT_BROWSER,
        Origin: SSO_ORIGIN,
        Referer: SSO_SIGNIN,
        Dnt: '1',
      },
    });

    let responseHtml: string = loginResponse.data;

    const titleMatch = TITLE_REGEX.exec(responseHtml);
    const title = titleMatch?.[1] ?? '';

    if (title.includes('MFA')) {
      if (!this.promptMfa) {
        throw new Error(
          'MFA is required but no interactive MFA handler is available in this runtime. Run "npx @nicolasvegam/garmin-connect-mcp setup" in an interactive environment and persist tokens to GARMIN_TOKEN_DIR.',
        );
      }

      const mfaCsrfMatch = CSRF_REGEX.exec(responseHtml);
      if (!mfaCsrfMatch) throw new Error('Failed to extract CSRF token for MFA');

      const mfaCode = await this.promptMfa();

      const mfaResponse = await ssoClient.post(SSO_VERIFY_MFA, new URLSearchParams({
        'mfa-code': mfaCode,
        embed: 'true',
        _csrf: mfaCsrfMatch[1]!,
        fromPage: 'setupEnterMfaCode',
      }).toString(), {
        params: {
          ...signinParams,
          clientId: SSO_CLIENT_ID,
          service: SSO_EMBED,
          source: SSO_EMBED,
          redirectAfterAccountLoginUrl: SSO_EMBED,
          redirectAfterAccountCreationUrl: SSO_EMBED,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT_BROWSER,
          Origin: SSO_ORIGIN,
          Referer: SSO_SIGNIN,
          Dnt: '1',
        },
      });

      responseHtml = mfaResponse.data;
    }

    const ticketMatch = TICKET_REGEX.exec(responseHtml);
    if (!ticketMatch) throw new Error('Login failed: invalid credentials or MFA verification failed');

    return ticketMatch[1]!;
  }

  private async exchangeTicketForOAuth1(ticket: string): Promise<void> {
    await this.fetchOAuthConsumer();

    const oauth = new OAuth({
      consumer: { key: this.consumer!.consumer_key, secret: this.consumer!.consumer_secret },
      signature_method: 'HMAC-SHA1',
      hash_function: (baseString, key) =>
        crypto.createHmac('sha1', key).update(baseString).digest('base64'),
    });

    const url = `${OAUTH_PREAUTHORIZED}?${new URLSearchParams({
      ticket,
      'login-url': SSO_EMBED,
      'accepts-mfa-tokens': 'true',
    })}`;

    const requestData = { url, method: 'GET' };
    const authHeader = oauth.toHeader(oauth.authorize(requestData));

    const response = await axios.get(url, {
      headers: {
        ...authHeader,
        'User-Agent': USER_AGENT_MOBILE,
      },
    });

    const params = new URLSearchParams(response.data);
    const oauthToken = params.get('oauth_token');
    const oauthTokenSecret = params.get('oauth_token_secret');

    if (!oauthToken || !oauthTokenSecret) {
      throw new Error('Failed to obtain OAuth1 token');
    }

    this.oauth1Token = { oauth_token: oauthToken, oauth_token_secret: oauthTokenSecret };
  }

  private async exchangeOAuth1ForOAuth2(): Promise<void> {
    await this.fetchOAuthConsumer();

    if (!this.oauth1Token) throw new Error('OAuth1 token required for OAuth2 exchange');

    const oauth = new OAuth({
      consumer: { key: this.consumer!.consumer_key, secret: this.consumer!.consumer_secret },
      signature_method: 'HMAC-SHA1',
      hash_function: (baseString, key) =>
        crypto.createHmac('sha1', key).update(baseString).digest('base64'),
    });

    const token: OAuth.Token = {
      key: this.oauth1Token.oauth_token,
      secret: this.oauth1Token.oauth_token_secret,
    };

    const requestData = { url: OAUTH_EXCHANGE, method: 'POST' };
    const authData = oauth.authorize(requestData, token);

    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(authData)) {
      queryParams.set(key, String(value));
    }

    const response = await axios.post<OAuth2Token>(
      `${OAUTH_EXCHANGE}?${queryParams}`,
      null,
      {
        headers: {
          'User-Agent': USER_AGENT_MOBILE,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    const now = Math.floor(Date.now() / 1000);
    this.oauth2Token = {
      ...response.data,
      expires_at: now + response.data.expires_in,
      refresh_token_expires_at: now + response.data.refresh_token_expires_in,
    };
  }

  private isOAuth2Expired(): boolean {
    if (!this.oauth2Token) return true;
    return this.oauth2Token.expires_at < Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_BUFFER_SECONDS;
  }

  private async ensureTokensLoaded(): Promise<void> {
    if (!this.persistTokens || this.tokensLoaded) return;

    if (this.tokenLoadInFlight) {
      await this.tokenLoadInFlight;
      return;
    }

    const inFlight = (async () => {
      if (this.tokenStoreMode === 'vercel-kv') {
        await this.loadTokensFromVercelKv();
      } else {
        this.loadTokensFromFilesystem();
      }
      this.tokensLoaded = true;
    })();

    this.tokenLoadInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.tokenLoadInFlight === inFlight) {
        this.tokenLoadInFlight = null;
      }
    }
  }

  private loadTokensFromFilesystem(): void {
    if (!this.persistTokens) return;
    try {
      const oauth1Path = path.join(this.tokenDir, OAUTH1_TOKEN_FILE);
      const oauth2Path = path.join(this.tokenDir, OAUTH2_TOKEN_FILE);
      const profilePath = path.join(this.tokenDir, PROFILE_FILE);

      if (fs.existsSync(oauth1Path)) {
        this.oauth1Token = JSON.parse(fs.readFileSync(oauth1Path, 'utf-8'));
      }
      if (fs.existsSync(oauth2Path)) {
        this.oauth2Token = JSON.parse(fs.readFileSync(oauth2Path, 'utf-8'));
      }
      if (fs.existsSync(profilePath)) {
        this.profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      }
    } catch {
      this.oauth1Token = null;
      this.oauth2Token = null;
      this.profile = null;
    }
  }

  private async saveTokens(): Promise<void> {
    if (!this.persistTokens) return;
    if (this.tokenStoreMode === 'vercel-kv') {
      await this.saveTokensToVercelKv();
      return;
    }
    this.saveTokensToFilesystem();
  }

  private saveTokensToFilesystem(): void {
    if (!this.persistTokens) return;

    if (!fs.existsSync(this.tokenDir)) {
      fs.mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
    }

    if (this.oauth1Token) {
      fs.writeFileSync(
        path.join(this.tokenDir, OAUTH1_TOKEN_FILE),
        JSON.stringify(this.oauth1Token, null, 2),
        { mode: 0o600 },
      );
    }
    if (this.oauth2Token) {
      fs.writeFileSync(
        path.join(this.tokenDir, OAUTH2_TOKEN_FILE),
        JSON.stringify(this.oauth2Token, null, 2),
        { mode: 0o600 },
      );
    }
    if (this.profile) {
      fs.writeFileSync(
        path.join(this.tokenDir, PROFILE_FILE),
        JSON.stringify(this.profile, null, 2),
        { mode: 0o600 },
      );
    }
  }

  private async loadTokensFromVercelKv(): Promise<void> {
    if (!this.kvUrl || !this.kvToken) {
      console.error(
        'GARMIN_TOKEN_STORE=vercel-kv is set, but KV_REST_API_URL or KV_REST_API_TOKEN is missing. Falling back to empty token cache.',
      );
      this.oauth1Token = null;
      this.oauth2Token = null;
      this.profile = null;
      return;
    }

    try {
      const oauth1Raw = await this.kvGet(`${this.tokenNamespace}:${OAUTH1_TOKEN_FILE}`);
      const oauth2Raw = await this.kvGet(`${this.tokenNamespace}:${OAUTH2_TOKEN_FILE}`);
      const profileRaw = await this.kvGet(`${this.tokenNamespace}:${PROFILE_FILE}`);

      this.oauth1Token = oauth1Raw ? JSON.parse(oauth1Raw) : null;
      this.oauth2Token = oauth2Raw ? JSON.parse(oauth2Raw) : null;
      this.profile = profileRaw ? JSON.parse(profileRaw) : null;
    } catch (error) {
      console.error('Failed to load Garmin tokens from Vercel KV', error);
      this.oauth1Token = null;
      this.oauth2Token = null;
      this.profile = null;
    }
  }

  private async saveTokensToVercelKv(): Promise<void> {
    if (!this.kvUrl || !this.kvToken) {
      throw new Error('GARMIN_TOKEN_STORE is set to vercel-kv, but KV_REST_API_URL/KV_REST_API_TOKEN are missing');
    }

    const writes: Array<Promise<unknown>> = [];
    if (this.oauth1Token) {
      writes.push(this.kvSet(`${this.tokenNamespace}:${OAUTH1_TOKEN_FILE}`, JSON.stringify(this.oauth1Token)));
    }
    if (this.oauth2Token) {
      writes.push(this.kvSet(`${this.tokenNamespace}:${OAUTH2_TOKEN_FILE}`, JSON.stringify(this.oauth2Token)));
    }
    if (this.profile) {
      writes.push(this.kvSet(`${this.tokenNamespace}:${PROFILE_FILE}`, JSON.stringify(this.profile)));
    }
    await Promise.all(writes);
  }

  private async kvGet(key: string): Promise<string | null> {
    const result = await this.kvCommand<string | null>(['GET', key]);
    if (result === undefined || result === null) return null;
    return String(result);
  }

  private async kvSet(key: string, value: string): Promise<void> {
    await this.kvCommand(['SET', key, value]);
  }

  private async kvCommand<T = unknown>(command: string[]): Promise<T> {
    const response = await fetch(this.kvUrl!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.kvToken!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      const snippet = await response.text();
      throw new Error(`Vercel KV request failed (${response.status}): ${snippet.slice(0, 200)}`);
    }

    const payload = await response.json() as VercelKvResponse<T>;
    if (payload.error) {
      throw new Error(`Vercel KV error: ${payload.error}`);
    }

    return payload.result;
  }
}

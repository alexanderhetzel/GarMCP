import crypto from 'node:crypto';
import OAuth from 'oauth-1.0a';
import type { VercelRequest, VercelResponse } from '@vercel/node';

type AnyObj = Record<string, unknown>;

function json(res: VercelResponse, data: unknown, status = 200): void {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    json(res, { error: 'Method not allowed' }, 405);
    return;
  }

  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    json(res, { error: 'Missing GARMIN_EMAIL/GARMIN_PASSWORD' }, 500);
    return;
  }

  const steps: AnyObj[] = [];

  const userAgentBrowser =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const userAgentMobile = 'com.garmin.android.apps.connectmobile';

  const garminConnectApi = 'https://connectapi.garmin.com';
  const oauthConsumerUrl = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
  const ssoEmbed = 'https://sso.garmin.com/sso/embed';
  const ssoSignin = 'https://sso.garmin.com/sso/signin';
  const oauthPreauthorized = `${garminConnectApi}/oauth-service/oauth/preauthorized`;
  const oauthExchange = `${garminConnectApi}/oauth-service/oauth/exchange/user/2.0`;
  const profileUrl = `${garminConnectApi}/userprofile-service/socialProfile`;

  const ssoClientId = 'GarminConnect';
  const ssoLocale = 'en';
  const ssoWidgetId = 'gauth-widget';

  const csrfRegex = /name="_csrf"\s+value="(.+?)"/;
  const ticketRegex = /ticket=([^"]+)/;
  const titleRegex = /<title>(.+?)<\/title>/;

  try {
    const consumerResp = await fetch(oauthConsumerUrl);
    steps.push({ step: 'consumer_get', status: consumerResp.status });
    if (!consumerResp.ok) {
      json(res, { steps, error: 'consumer_fetch_failed' }, 500);
      return;
    }
    const consumer = (await consumerResp.json()) as { consumer_key: string; consumer_secret: string };

    const embedUrl = `${ssoEmbed}?clientId=${encodeURIComponent(
      ssoClientId,
    )}&locale=${encodeURIComponent(ssoLocale)}&service=${encodeURIComponent(ssoEmbed)}`;
    const embedResp = await fetch(embedUrl, {
      headers: { 'user-agent': userAgentBrowser },
    });
    const setCookie = embedResp.headers.get('set-cookie') ?? '';
    steps.push({ step: 'sso_embed', status: embedResp.status });

    const signinParams = new URLSearchParams({
      id: ssoWidgetId,
      embedWidget: 'true',
      locale: ssoLocale,
      gauthHost: ssoEmbed,
    });
    const signinGetResp = await fetch(`${ssoSignin}?${signinParams.toString()}`, {
      headers: {
        'user-agent': userAgentBrowser,
        cookie: setCookie,
      },
    });
    const signinGetHtml = await signinGetResp.text();
    const csrf = csrfRegex.exec(signinGetHtml)?.[1];
    steps.push({ step: 'sso_signin_get', status: signinGetResp.status, hasCsrf: !!csrf });
    if (!csrf) {
      json(res, { steps, error: 'csrf_not_found' }, 500);
      return;
    }

    const signinPostQuery = new URLSearchParams({
      ...Object.fromEntries(signinParams.entries()),
      clientId: ssoClientId,
      service: ssoEmbed,
      source: ssoEmbed,
      redirectAfterAccountLoginUrl: ssoEmbed,
      redirectAfterAccountCreationUrl: ssoEmbed,
    });
    const signinPostBody = new URLSearchParams({
      username: email,
      password,
      embed: 'true',
      _csrf: csrf,
    });

    const signinPostResp = await fetch(`${ssoSignin}?${signinPostQuery.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgentBrowser,
        origin: 'https://sso.garmin.com',
        referer: 'https://sso.garmin.com/sso/signin',
        dnt: '1',
        cookie: setCookie,
      },
      body: signinPostBody,
    });

    const signinPostHtml = await signinPostResp.text();
    const mfaRequired = (titleRegex.exec(signinPostHtml)?.[1] ?? '').includes('MFA');
    steps.push({ step: 'sso_signin_post', status: signinPostResp.status, mfaRequired });
    if (mfaRequired) {
      json(res, { steps, error: 'mfa_required' }, 200);
      return;
    }

    const ticket = ticketRegex.exec(signinPostHtml)?.[1];
    if (!ticket) {
      json(res, { steps, error: 'ticket_not_found', snippet: signinPostHtml.slice(0, 200) }, 500);
      return;
    }

    const oauth = new OAuth({
      consumer: { key: consumer.consumer_key, secret: consumer.consumer_secret },
      signature_method: 'HMAC-SHA1',
      hash_function: (baseString: string, key: string) =>
        crypto.createHmac('sha1', key).update(baseString).digest('base64'),
    });

    const preauthUrl = `${oauthPreauthorized}?${new URLSearchParams({
      ticket,
      'login-url': ssoEmbed,
      'accepts-mfa-tokens': 'true',
    }).toString()}`;

    const preauthAuthHeader = oauth.toHeader(oauth.authorize({ url: preauthUrl, method: 'GET' }));
    const preauthResp = await fetch(preauthUrl, {
      headers: {
        ...preauthAuthHeader,
        'user-agent': userAgentMobile,
      },
    });
    const preauthText = await preauthResp.text();
    steps.push({
      step: 'oauth_preauthorized',
      status: preauthResp.status,
      snippet: preauthText.slice(0, 120),
    });
    if (!preauthResp.ok) {
      json(res, { steps, error: 'preauthorized_failed' }, 200);
      return;
    }

    const preauthParams = new URLSearchParams(preauthText);
    const oauthToken = preauthParams.get('oauth_token');
    const oauthTokenSecret = preauthParams.get('oauth_token_secret');
    if (!oauthToken || !oauthTokenSecret) {
      json(res, { steps, error: 'oauth1_not_found' }, 200);
      return;
    }

    const token = { key: oauthToken, secret: oauthTokenSecret };
    const authData = oauth.authorize({ url: oauthExchange, method: 'POST' }, token);
    const exchangeQuery = new URLSearchParams();
    for (const [k, v] of Object.entries(authData)) {
      exchangeQuery.set(k, String(v));
    }

    const exchangeResp = await fetch(`${oauthExchange}?${exchangeQuery.toString()}`, {
      method: 'POST',
      headers: {
        'user-agent': userAgentMobile,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    const exchangeText = await exchangeResp.text();
    steps.push({
      step: 'oauth_exchange',
      status: exchangeResp.status,
      snippet: exchangeText.slice(0, 120),
    });
    if (!exchangeResp.ok) {
      json(res, { steps, error: 'exchange_failed' }, 200);
      return;
    }

    const oauth2 = JSON.parse(exchangeText) as AnyObj;
    const accessToken = oauth2.access_token as string | undefined;
    if (!accessToken) {
      json(res, { steps, error: 'access_token_missing' }, 200);
      return;
    }

    const profileResp = await fetch(profileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'user-agent': userAgentMobile,
      },
    });
    const profileText = await profileResp.text();
    steps.push({
      step: 'profile_fetch',
      status: profileResp.status,
      snippet: profileText.slice(0, 120),
    });

    json(res, { ok: true, steps }, 200);
  } catch (error) {
    json(res, { steps, error: String(error) }, 500);
  }
}

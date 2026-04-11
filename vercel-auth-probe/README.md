# Garmin Vercel Auth Probe

Deploy this folder as a separate Vercel project to compare Garmin auth behavior on another cloud egress IP.

## Deploy

```bash
cd vercel-auth-probe
vercel
```

## Required Environment Variables

- `GARMIN_EMAIL`
- `GARMIN_PASSWORD`

Set them in Vercel project settings (`Settings -> Environment Variables`) and redeploy.

## Test Endpoint

```bash
curl -s https://<your-vercel-domain>/api/garmin-auth-full-test | jq
```

Focus on step statuses, especially:

- `oauth_preauthorized`
- `oauth_exchange`
- `profile_fetch`

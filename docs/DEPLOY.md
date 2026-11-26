# Deploying the public demo (free tiers)

The public deployment runs in **demo mode only**: simulated positions, no real wallets, no RPC keys,
no login. Nothing in it can move funds. This tool is read-only and never needs a private key.

```
Browser ──► Vercel (Next.js dashboard) ──/api/* proxy──► Render (Node backend: monitor + API + optional bot)
                                                                   │
                                                                   └──► Postgres (optional, e.g. Neon free)
```

The dashboard proxies `/api/*` to the backend, so the browser only talks to one origin.

## Before you start

- The code is on GitHub, and the secret scan is clean (`npm run scan:all`).
- You have accounts on Render and Vercel (free plans). Neon is optional.

## 1. (Optional) Free Postgres on Neon

Without a database URL, the backend uses SQLite on Render's disk. That disk is **wiped on every
restart and every sleep**, so the demo history and the bot's users are lost each time.

1. Create a free project at neon.tech.
2. Copy the connection string. It looks like `postgresql://USER:PASSWORD@HOST/DB?sslmode=require`.
3. Do not paste it into any file in the repository. It goes into Render's environment settings in step 2.

## 2. Backend on Render

1. In Render, choose **New → Blueprint** and select the GitHub repository. Render reads `render.yaml`.
2. When asked for the variables marked `sync: false`:
   - `DATABASE_URL`: the Neon URL from step 1, or leave it empty.
   - `TELEGRAM_BOT_TOKEN`: optional. If you use your demo bot here, **stop the local copy**. Two
     programs polling the same bot token conflict (Telegram returns 409).
3. Deploy. Check `https://<your-service>.onrender.com/healthz`. It should return `{"ok":true,"mode":"demo",...}`.

`APP_MODE=demo` is fixed in `render.yaml`. Do not change it on the public service.

## 3. Dashboard on Vercel

1. In Vercel, choose **Add New → Project** and import the same repository.
2. Set **Root Directory** to `dashboard`. The framework is detected as Next.js.
3. Add one environment variable:
   `API_BASE_URL = https://<your-service>.onrender.com`
   This is not a secret. The dashboard holds no secrets.
4. Deploy, then open the Vercel URL.

## Free-tier limits

- **Render free services sleep** after about 15 minutes without inbound requests. While asleep:
  - nothing is monitored and no alerts are sent;
  - the bot does not answer.
- The first request after a sleep takes about a minute. The dashboard shows "backend not reachable…
  waking up" until it is back.
- **After a wake-up:**
  - alerts that waited more than 30 minutes are **expired, not sent late**;
  - an alert interrupted mid-send is marked `uncertain` and **not resent**, so no duplicates.
  - The Network health page shows how long ago the last monitoring cycle ran.
- This is acceptable for a demo. It is **not** acceptable for real monitoring. See
  [LIVE-SETUP.md](LIVE-SETUP.md).

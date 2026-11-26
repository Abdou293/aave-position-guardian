# Real use (live mode): self-hosted setup

> **Not financial advice. Not audited.** Alerts can be delayed or fail: RPC outages, a sleeping host,
> Telegram problems. This tool cannot guarantee you avoid liquidation. Keep your own safety margin.

Live mode reads real Aave V3 positions on Ethereum, Arbitrum, Base and Polygon.
- It is **read-only and non-custodial**. You only ever enter **public wallet addresses**.
- It never needs or accepts a private key or seed phrase. If anything asks for one, it is a scam.
- Run it for yourself. The public deployment is demo-only.

## 1. Requirements

- Node.js 22.13+ (24 recommended) and git.
- A Telegram bot token from @BotFather.
- Strongly recommended: your own RPC endpoints (free tiers such as Alchemy work). The public RPCs
  are shared, rate-limited and sometimes slow.
- An always-on machine or a paid host. A free host that sleeps will miss alerts.

## 2. Configure

```powershell
git clone <your repo url>
cd aave-position-guardian
npm ci
Copy-Item .env.example .env
```

Edit `.env` locally. It is git-ignored, and the pre-commit and pre-push scans block secrets.

| Variable | Value |
|---|---|
| `APP_MODE` | `live` |
| `RPC_URL_ETHEREUM`, `RPC_URL_ARBITRUM`, `RPC_URL_BASE`, `RPC_URL_POLYGON` | your HTTPS RPC URLs (optional, recommended) |
| `NETWORKS` | optional, e.g. `arbitrum,base` to watch fewer networks |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `DATABASE_URL` | `file:./data/guardian.db` (local) or a `postgres://...?sslmode=require` URL |
| `ADMIN_PASSWORD_HASH` | output of `npm run hash:password` (the password itself is never stored) |
| `SESSION_SECRET` | output of `npm run session:secret` |
| `COOKIE_SECURE` | `true` if the dashboard is served over HTTPS |

## 3. Verify the contract addresses yourself

```powershell
npm run verify:addresses
```

This checks every Aave V3 address from the official address book on-chain, plus Multicall3.
It writes `config/addresses.json`. Live mode only uses networks that passed.

Optional: the fork validation needs Anvil from Foundry. It compares our reader with Aave's own
`getUserAccountData` on local forks:

```powershell
npm run fork:validate
```

## 4. Run

```powershell
npm run build
npm start
```

In a second terminal, start the dashboard:

```powershell
npm run dashboard:build
npm --prefix dashboard start
```

Open http://localhost:3000 and log in. In Telegram:
- `/add <network> <address> [label]` to watch a wallet;
- `/thresholds` to set your alert levels;
- `/status` to see your positions.

## 5. What it does and does not do

- Health factor, collateral, debt, liquidation threshold and LTV are read directly from Aave's
  `Pool.getUserAccountData`. They are not recomputed.
- The "what-if" liquidation price is **our own estimate**, always labelled, with its formula and limits.
  - Exact for a single collateral asset. Fork validation: Aave's own HF was 1.0000 at our estimated
    price in 7 of 7 single-collateral cases.
  - Approximate for mixed collateral.
- When a read fails, the data is shown as **stale**, with its age. It is never shown as fresh.
- Alerts are sent **at most once**. If the app stops mid-send, that alert is not resent.

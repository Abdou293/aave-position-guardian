# Project description (English)

## Short version (for a portfolio card, about 300 characters)

Aave Position Guardian: a read-only monitor for Aave V3 borrowers. It reads health factors on 4
networks via Multicall3 and sends smart Telegram alerts (thresholds, cooldown, hysteresis,
at-most-once delivery). It includes a Next.js dashboard and was validated against Aave on mainnet forks.

## Full version

**Aave Position Guardian** warns Aave V3 borrowers before their positions approach liquidation.

**What I built**
- A Node.js/TypeScript backend that reads positions on Ethereum, Arbitrum, Base and Polygon
  through Multicall3 (viem). It uses caching, retries and rate limiting. Every contract address is
  taken from the official Aave address book and verified on-chain before use.
- An alert engine with multiple thresholds, cooldown, hysteresis, recovery messages, critical
  repeats and "data problem" warnings. It is a pure function, so it is fully unit-tested.
- A transactional outbox and an audit log. Alerts are delivered at most once, even across crashes
  and the sleep of free hosts.
- A Telegram bot (grammY) and a Next.js + Recharts dashboard: positions, health-factor history,
  alerts, network health, and a login for live mode.
- A clearly labelled what-if estimate of the liquidation price, with its formula and limits.
- SQLite for local use and PostgreSQL for hosting, behind one interface tested against both.

**Quality and safety**
- 152 automated tests.
- Fork validation on Ethereum and Arbitrum (64/64 checks): the reader matches Aave's own
  `getUserAccountData` exactly. Aave reported HF 1.0000 at the estimated liquidation price in 7 of 7
  single-collateral cases.
- Read-only and non-custodial: no private keys, no signing code. Secrets live only in `.env`, and
  gitleaks scans run before every commit and push.
- API hardening: rate limits, scrypt-hashed admin password, signed HttpOnly cookies, security headers.

**Stack:** TypeScript, Node.js, viem, Fastify, grammY, Next.js, Recharts, SQLite, PostgreSQL,
Vitest, Anvil (Foundry), Render, Vercel.

**Live demo** (simulated data): https://aave-position-guardian.vercel.app

*Portfolio project, built with an AI coding assistant under my direction. Not audited and not
financial advice.*

## Skills / tags

TypeScript · Node.js · Web3 · DeFi · Aave · viem · Smart contract integration · Telegram bot ·
Next.js · React · Fastify · PostgreSQL · SQLite · Vitest · REST API · Monitoring & alerting

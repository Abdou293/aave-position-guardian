# 60-second demo video script

Record the screen with the live demo (https://aave-position-guardian.vercel.app) and Telegram.
Open the dashboard a minute before recording so the free backend is awake. Use only the demo:
**no real wallet, no `.env`, no token on screen.**

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:06 | Dashboard home, the "Read-only" pill and the demo banner | "This is Aave Position Guardian: an early-warning monitor for Aave V3 borrowers. It's read-only. It never asks for a private key." |
| 0:06–0:16 | Positions table: four networks, HF colours | "It watches wallets on Ethereum, Arbitrum, Base and Polygon. The health factor comes straight from Aave's own contracts, batched through Multicall3." |
| 0:16–0:28 | Open the "liquidation drill" position: HF chart with threshold lines | "Here a simulated position falls toward liquidation. Alerts fire at 1.5, 1.25 and 1.1, with cooldown and hysteresis, so there's no spam when it hovers around a line." |
| 0:28–0:36 | Telegram: the warning, critical and "Recovered" messages | "The alerts arrive in Telegram, and a 'recovered' message follows when it's safe again." |
| 0:36–0:44 | The what-if card, with the formula and limits visible | "A what-if estimate shows how far the main collateral can fall. It's labelled as an estimate, with its formula and limits." |
| 0:44–0:52 | Alerts page → Audit tab, then the Network health page | "Every alert is sent at most once, even if the server restarts, and every decision is in an audit log." |
| 0:52–1:00 | GitHub README: test table, then the disclaimer | "152 tests, and checked against Aave itself on mainnet forks. Not financial advice, not audited, but built carefully. Link below." |

## Recording tips

- Screen size 1280×720 or 1920×1080. Zoom the browser to 110–125% so the text is readable on a phone.
- Wait for the drill to reach the red zone. It falls and recovers every 30 minutes; the alerts
  arrive at about 10, 13 and 15 minutes into the cycle.
- Before publishing, watch the whole video once and check that no token, `.env` or personal chat is visible.

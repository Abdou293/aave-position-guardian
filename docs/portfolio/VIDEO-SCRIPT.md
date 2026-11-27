# Demo video script

The finished video is [aave-position-guardian-demo.mp4](aave-position-guardian-demo.mp4) (55 s, 1920×1080).

How it was made:
- Screenshots of the live demo (simulated data only).
- A Telegram chat frame that uses the bot's exact reply wording, with the drill's demo values.
- An English voice-over generated with ElevenLabs (premade voice "Liam").
- The video was put together with ffmpeg.

It shows no real wallet, no `.env` and no token.

| Scene | On screen | Voice-over |
|---|---|---|
| 1 | Title: read-only early warnings | "Borrowing on Aave? One bad price move, and you get liquidated. Aave Position Guardian warns you first." |
| 2 | Telegram bot chat: `/add`, `/status`, `/thresholds` | "It all happens in a Telegram bot. Add a wallet with slash add, check your health factor with slash status, and set your own alert levels." |
| 3 | Dashboard home: four networks | "Behind the bot, a read-only monitor watches four networks, using Aave's own on-chain numbers. No private keys. Ever." |
| 4 | Liquidation drill: HF chart with threshold lines | "Watch this position fall. It crosses 1.5, then 1.25, then 1.1..." |
| 5 | Alerts log + the Telegram alert message | "...and the bot messages you, with your collateral, your debt, and how far the price can drop. When you're safe again, it tells you that too." |
| 6 | What-if card with formula and limits | "That price estimate is clearly labelled, with its formula and its limits." |
| 7 | At-most-once delivery states | "No spam, no duplicates. Every alert is sent at most once, and every decision is logged." |
| 8 | Test results and links | "152 tests pass, and it's checked against Aave itself on mainnet forks. Not financial advice. Try the live demo!" |

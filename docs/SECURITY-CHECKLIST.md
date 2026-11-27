# Final security checklist

Re-check these items before every release, and before making the repository public. Each result
comes from a real run on 2026-11-27. "How to check" gives the command to repeat it.

| # | Item | How to check | Result |
|---|---|---|---|
| 1 | No private keys, seed phrases or signing code | `grep -rnE "privateKeyToAccount\|mnemonicToAccount\|createWalletClient\|signTransaction\|sendTransaction\|sendRawTransaction\|signMessage\|writeContract" src scripts dashboard/app dashboard/lib dashboard/components` | ✅ no matches |
| 2 | `.env` is ignored and never tracked | `git check-ignore -v .env` and `git ls-files \| grep .env` | ✅ ignored. Only the two `.env.example` templates are tracked |
| 3 | `.env.example` contains placeholders only | read the file | ✅ empty values or `change-me` / `your-...-here` |
| 4 | gitleaks pre-commit and pre-push hooks are active | `git config core.hooksPath` → `.githooks` | ✅ |
| 5 | Secret scan of the folder | `npm run scan:secrets` | ✅ see the release commit |
| 6 | Secret scan of the whole Git history | `npm run scan:history` | ✅ see the release commit |
| 7 | Known vulnerabilities in runtime dependencies | `npm audit --omit=dev` and `npm --prefix dashboard audit --omit=dev` | ✅ 0 and 0 |
| 8 | Contract addresses from official sources, verified on-chain | `npm run verify:addresses` | ✅ address book + Multicall3; unverified networks are skipped |
| 9 | Aave's own values are used; own math only for the labelled what-if | code review: `src/datasources/onchain.ts`, `src/risk/whatIf.ts` | ✅ |
| 10 | Address inputs validated with checksum | tests in `tests/lib.test.ts`, `tests/bot.test.ts` | ✅ |
| 11 | Endpoints rate-limited; admin password hashed (scrypt); signed HttpOnly session cookie | `tests/api.test.ts` | ✅ |
| 12 | Alerts idempotent (at most once) with an audit log | `tests/store.test.ts` restart test, on SQLite and PostgreSQL | ✅ |
| 13 | Public deployment is demo-only | `render.yaml` has `APP_MODE=demo`; `/healthz` returns `"mode":"demo"` | ✅ |
| 14 | No real money in tests | fixtures, a read-only local fork, simulated data | ✅ |
| 15 | Visible disclaimer (not financial advice; alerts can be delayed or fail) | README top, dashboard footer, bot `/start` | ✅ |
| 16 | No claims of an audit, a guarantee or production readiness | README "Limits" section | ✅ |
| 17 | All tests pass | `npm test` | ✅ 152 / 152 |

## If a secret ever leaks

1. **Rotate it first.** Revoke the key at the provider. For a Telegram token, use `/revoke` in
   @BotFather. A leaked key must be treated as public, even after it is deleted.
2. Remove it from the files and move it into `.env`.
3. If it was committed, rewrite the history (for example with `git filter-repo`), then run
   `npm run scan:all` again before pushing.

## Not covered (be honest)

- There has been **no independent security audit** and no penetration test.
- Free hosts sleep. Monitoring stops while they sleep.
- Public RPC data is trusted as returned. There is no cross-checking between several RPC providers.

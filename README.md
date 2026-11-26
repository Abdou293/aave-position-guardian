# Aave Position Guardian

> 🚧 Work in progress. Full documentation will come with the first release.

A **read-only, non-custodial** early-warning monitor for Aave V3 borrowers. It watches
health factors across wallets and networks and alerts the owner before liquidation risk grows.

- It **never** asks for, holds or stores private keys or seed phrases.
- It **never** sends transactions. It only makes read-only calls.

## Verified contract addresses

Addresses come from the official [Aave address book](https://github.com/bgd-labs/aave-address-book)
and [Multicall3](https://github.com/mds1/multicall3). Each one is checked on-chain before use:

```bash
npm install
npm run verify:addresses   # writes config/addresses.json (verified networks only)
```

## Disclaimer

This is a portfolio project. It is **not financial advice**, it is **not audited**, and it
**cannot guarantee** that you avoid liquidation. Alerts can be delayed or fail.

# Five-minute local testnet quickstart

```bash
git clone https://github.com/sublime247/mobile-money.git
cd mobile-money
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run migrate:up
npm run dev
```

Set Stellar Testnet, database, Redis, and provider mock values in `.env`. Never put a real mainnet seed or API key in the file. For a local provider flow, run `npm run provider-mock:dev` in another terminal and use the mock base URLs from `.env.example`.

Check the service and SEP-38 rates:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health/deep
curl "http://localhost:3000/sep38/prices?sell_asset=stellar:USDC&sell_amount=10&buy_asset=iso4217:NGN"
```

Install [Freighter](https://www.freighter.app/) or [Albedo](https://albedo.link/), select **Stellar Testnet**, and fund a test account through [Friendbot](https://laboratory.stellar.org/#account-creator?network=test). Start a deposit/withdrawal from the app, approve it in the wallet, then query the returned reference with the API or `momo-cli status <transaction-id>`.

## Troubleshooting

- **CORS:** use the configured local frontend origin and inspect `CORS_ORIGIN`/`ALLOWED_ORIGINS`; do not use `*` in production.
- **Invalid seed:** use a Testnet account in Freighter/Albedo. The bridge should receive a signed transaction, never a raw seed.
- **Network timeout:** confirm Docker networking, Redis/Postgres health, and Stellar/provider URLs. Provider mocks remove external gateway timeouts.
- **No FX rate:** verify `/sep38/prices` asset syntax and provider liquidity.

import { Gauge, register } from "prom-client";
import * as StellarSdk from "stellar-sdk";

// Use environment variables for network routing to support dev/prod parity
const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const HOT_WALLET_PUBLIC_KEY = process.env.STELLAR_HOT_WALLET_PUBLIC_KEY;

// 1. Define the Prometheus Gauge
export const stellarHotWalletBalance = new Gauge({
  name: "stellar_hot_wallet_balance",
  help: "Current balance of the Stellar hot wallet",
  labelNames: ["asset_type", "asset_code"],
  registers: [register], // Attach to the default global registry
});

// 2. The Core Scraper Logic
export async function scrapeStellarBalances(): Promise<void> {
  if (!HOT_WALLET_PUBLIC_KEY) {
    console.warn(
      "[Stellar Exporter] STELLAR_HOT_WALLET_PUBLIC_KEY is missing. Skipping metrics export.",
    );
    return;
  }

  try {
    const account = await server.loadAccount(HOT_WALLET_PUBLIC_KEY);

    // Iterate through all trustlines/native balances
    account.balances.forEach((balance) => {
      const assetType = balance.asset_type;
      const assetCode =
        assetType === "native" ? "XLM" : (balance as any).asset_code;

      // Update the Grafana Gauge
      stellarHotWalletBalance.set(
        { asset_type: assetType, asset_code: assetCode },
        parseFloat(balance.balance),
      );
    });
  } catch (error) {
    console.error(
      "[Stellar Exporter] Failed to scrape Horizon balances:",
      error,
    );
  }
}

// 3. The Polling Initializer
export function startStellarExporter(): void {
  console.log(
    "[Stellar Exporter] Initializing 60-second background scraper...",
  );

  // Scrape immediately on container boot
  scrapeStellarBalances();

  // Schedule subsequent scrapes every 60,000 ms (1 minute)
  setInterval(scrapeStellarBalances, 60 * 1000);
}

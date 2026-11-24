import { Gauge } from "prom-client";
import { getStellarServer } from "../config/stellar";
import { register } from "../utils/metrics";
import logger from "../utils/logger";

export type StellarWalletRole = "hot_wallet" | "fee_account" | "escrow_pool";

interface WalletConfig {
  role: StellarWalletRole;
  publicKey: string | undefined;
}

interface StellarAccountSnapshot {
  sequence: string;
  subentry_count: number;
  balances: Array<{
    asset_type: string;
    balance: string;
  }>;
}

interface StellarServer {
  loadAccount(publicKey: string): Promise<StellarAccountSnapshot>;
}

export const stellarWalletSequenceNumber = new Gauge({
  name: "stellar_wallet_sequence_number",
  help: "Current Stellar wallet account sequence number",
  labelNames: ["role"],
  registers: [register],
});

export const stellarWalletReserveBytes = new Gauge({
  name: "stellar_wallet_reserve_bytes",
  help: "Estimated ledger entry storage footprint for a Stellar wallet in bytes",
  labelNames: ["role"],
  registers: [register],
});

export const stellarWalletBaseReserveUtilizationPercent = new Gauge({
  name: "stellar_wallet_base_reserve_utilization_percent",
  help: "Stellar wallet base reserve requirement as a percentage of its XLM balance",
  labelNames: ["role"],
  registers: [register],
});

export const stellarWalletXlmBalance = new Gauge({
  name: "stellar_wallet_xlm_balance",
  help: "Current native XLM balance of a Stellar wallet",
  labelNames: ["role"],
  registers: [register],
});

export const stellarWalletSubentriesTotal = new Gauge({
  name: "stellar_wallet_subentries_total",
  help: "Current number of Stellar wallet subentries",
  labelNames: ["role"],
  registers: [register],
});

const walletConfigs = (env: NodeJS.ProcessEnv): WalletConfig[] => [
  { role: "hot_wallet", publicKey: env.STELLAR_HOT_WALLET_PUBLIC_KEY },
  {
    role: "fee_account",
    publicKey:
      env.STELLAR_FEE_ACCOUNT_PUBLIC_KEY || env.STELLAR_FEE_PAYER_PUBLIC_KEY,
  },
  { role: "escrow_pool", publicKey: env.STELLAR_ESCROW_POOL_PUBLIC_KEY },
];

export async function refreshStellarWalletMetrics(
  server: StellarServer = getStellarServer(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const baseReserveXlm = Number(env.STELLAR_BASE_RESERVE_XLM || "0.5");
  const ledgerEntryBytes = Number(env.STELLAR_LEDGER_ENTRY_BYTES || "128");

  await Promise.all(
    walletConfigs(env)
      .filter((wallet): wallet is WalletConfig & { publicKey: string } =>
        Boolean(wallet.publicKey),
      )
      .map(async ({ role, publicKey }) => {
        try {
          const account = await server.loadAccount(publicKey);
          const xlmBalance = Number(
            account.balances.find((balance) => balance.asset_type === "native")
              ?.balance ?? 0,
          );
          const reserveEntries = account.subentry_count + 2;
          const reserveRequirementXlm = reserveEntries * baseReserveXlm;

          stellarWalletSequenceNumber.set({ role }, Number(account.sequence));
          stellarWalletReserveBytes.set(
            { role },
            reserveEntries * ledgerEntryBytes,
          );
          stellarWalletBaseReserveUtilizationPercent.set(
            { role },
            xlmBalance > 0 ? (reserveRequirementXlm / xlmBalance) * 100 : 0,
          );
          stellarWalletXlmBalance.set({ role }, xlmBalance);
          stellarWalletSubentriesTotal.set({ role }, account.subentry_count);
        } catch (error) {
          logger.warn(
            { role, error },
            "[StellarCollector] Failed to refresh wallet metrics",
          );
        }
      }),
  );
}

let refreshTimer: NodeJS.Timeout | null = null;
let refreshInProgress = false;

async function refreshWithoutOverlap(): Promise<void> {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    await refreshStellarWalletMetrics();
  } finally {
    refreshInProgress = false;
  }
}

export function startStellarCollector(intervalMs = 60_000): void {
  if (refreshTimer) return;
  void refreshWithoutOverlap();
  refreshTimer = setInterval(() => void refreshWithoutOverlap(), intervalMs);
  refreshTimer.unref?.();
}

export function stopStellarCollector(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

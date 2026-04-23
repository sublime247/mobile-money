import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { notifySlackAlert } from "../services/loggers";

/**
 * Balance Monitor Job
 * Schedule: Every 5 minutes (configurable via BALANCE_MONITOR_CRON)
 * Monitors Stellar hot wallet balances and alerts if below thresholds.
 */

interface BalanceThreshold {
  asset: string; // "XLM" or asset code like "USDC"
  threshold: number;
}

interface WalletBalance {
  publicKey: string;
  balances: Array<{
    asset: string;
    balance: number;
  }>;
}

function getHotWalletPublicKeys(): string[] {
  const keys = process.env.HOT_WALLET_PUBLIC_KEYS;
  if (!keys) {
    console.warn("[balance-monitor] HOT_WALLET_PUBLIC_KEYS not configured");
    return [];
  }
  return keys.split(",").map(key => key.trim()).filter(key => key.length > 0);
}

function getBalanceThresholds(): BalanceThreshold[] {
  const thresholds: BalanceThreshold[] = [];

  // Check for XLM threshold
  const xlmThreshold = process.env.BALANCE_THRESHOLD_XLM;
  if (xlmThreshold) {
    thresholds.push({
      asset: "XLM",
      threshold: parseFloat(xlmThreshold),
    });
  }

  // Check for other asset thresholds (e.g. BALANCE_THRESHOLD_USDC=1000)
  Object.keys(process.env).forEach(key => {
    if (key.startsWith("BALANCE_THRESHOLD_") && key !== "BALANCE_THRESHOLD_XLM") {
      const asset = key.replace("BALANCE_THRESHOLD_", "");
      const threshold = parseFloat(process.env[key]!);
      if (!isNaN(threshold)) {
        thresholds.push({ asset, threshold });
      }
    }
  });

  return thresholds;
}

async function getWalletBalances(publicKey: string): Promise<WalletBalance> {
  const server = getStellarServer();
  try {
    const account = await server.loadAccount(publicKey);
    const balances = account.balances.map(balance => {
      let asset: string;
      let balanceAmount: number;

      if (balance.asset_type === "native") {
        asset = "XLM";
        balanceAmount = parseFloat(balance.balance);
      } else {
        asset = (balance as any).asset_code;
        balanceAmount = parseFloat(balance.balance);
      }

      return { asset, balance: balanceAmount };
    });

    return { publicKey, balances };
  } catch (error) {
    console.error(`[balance-monitor] Failed to load account ${publicKey}:`, error);
    throw error;
  }
}

async function checkBalancesAndAlert(): Promise<void> {
  const wallets = getHotWalletPublicKeys();
  const thresholds = getBalanceThresholds();

  if (wallets.length === 0) {
    console.log("[balance-monitor] No hot wallets configured");
    return;
  }

  if (thresholds.length === 0) {
    console.log("[balance-monitor] No balance thresholds configured");
    return;
  }

  console.log(`[balance-monitor] Checking ${wallets.length} wallets for ${thresholds.length} thresholds`);

  for (const walletKey of wallets) {
    try {
      const walletBalance = await getWalletBalances(walletKey);

      for (const threshold of thresholds) {
        const balance = walletBalance.balances.find(b => b.asset === threshold.asset);
        if (!balance) {
          // Wallet doesn't hold this asset, skip
          continue;
        }

        if (balance.balance < threshold.threshold) {
          console.warn(
            `[balance-monitor] ALERT: Wallet ${walletKey} has ${balance.balance} ${threshold.asset}, below threshold ${threshold.threshold}`
          );

          // Send Slack alert
          await notifySlackAlert({
            statusCode: 500, // Use 500 to indicate critical issue
            method: "MONITOR",
            path: `/balance/${walletKey}`,
            timestamp: new Date().toISOString(),
            error: new Error(
              `Low balance alert: ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`
            ),
          }, {
            appName: "balance-monitor",
          });
        } else {
          console.log(
            `[balance-monitor] OK: Wallet ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`
          );
        }
      }
    } catch (error) {
      console.error(`[balance-monitor] Error checking wallet ${walletKey}:`, error);
      // Send alert for monitoring failure
      await notifySlackAlert({
        statusCode: 500,
        method: "MONITOR",
        path: `/balance/${walletKey}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : new Error(String(error)),
      }, {
        appName: "balance-monitor",
      });
    }
  }
}

export async function runBalanceMonitorJob(): Promise<void> {
  await checkBalancesAndAlert();
}
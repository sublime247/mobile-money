import logger from "../utils/logger";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { notifySlackAlert } from "../services/loggers";
import {
  calculateStellarReserve,
  formatReserveInfo,
} from "../utils/stellarReserveCalculator";
import { ledgerService } from "../services/ledgerService";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { AirtelService } from "../services/mobilemoney/providers/airtel";

/**
 * Balance Monitor Job
 * Schedule: Every 5 minutes (configurable via BALANCE_MONITOR_CRON)
 * Monitors Stellar hot wallet balances and alerts if below thresholds.
 * Also warns admins if XLM reserve falls below threshold.
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
  return keys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
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
  Object.keys(process.env).forEach((key) => {
    if (
      key.startsWith("BALANCE_THRESHOLD_") &&
      key !== "BALANCE_THRESHOLD_XLM"
    ) {
      const asset = key.replace("BALANCE_THRESHOLD_", "");
      const threshold = parseFloat(process.env[key]!);
      if (!isNaN(threshold)) {
        thresholds.push({ asset, threshold });
      }
    }
  });

  return thresholds;
}

function getStellarMinimumBalanceThreshold(): number {
  // Min XLM above reserve; prevent out of gas
  const threshold = process.env.STELLAR_MIN_BALANCE_ABOVE_RESERVE;
  const defaultValue = 5; // 5 XLM default
  if (!threshold) return defaultValue;
  const parsed = parseFloat(threshold);
  return isNaN(parsed) ? defaultValue : parsed;
}

async function getWalletBalances(publicKey: string): Promise<WalletBalance> {
  const server = getStellarServer();
  try {
    const account = await server.loadAccount(publicKey);
    const balances = account.balances.map((balance) => {
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
    logger.error(
      `[balance-monitor] Failed to load account ${publicKey}:`,
      error,
    );
    throw error;
  }
}

async function checkBalancesAndAlert(): Promise<void> {
  const wallets = getHotWalletPublicKeys();
  const thresholds = getBalanceThresholds();
  const minBalanceThreshold = getStellarMinimumBalanceThreshold();

  if (wallets.length === 0) {
    console.log("[balance-monitor] No hot wallets configured");
    return;
  }

  if (thresholds.length === 0) {
    console.log(
      "[balance-monitor] No balance thresholds configured; checking reserve-only alerts",
    );
  }

  console.log(
    `[balance-monitor] Checking ${wallets.length} wallets for ${thresholds.length} thresholds`,
  );

  for (const walletKey of wallets) {
    try {
      const walletBalance = await getWalletBalances(walletKey);

      for (const threshold of thresholds) {
        const balance = walletBalance.balances.find(
          (b) => b.asset === threshold.asset,
        );
        if (!balance) {
          // Wallet doesn't hold this asset, skip
          continue;
        }

        if (balance.balance < threshold.threshold) {
          console.warn(
            `[balance-monitor] ALERT: Wallet ${walletKey} has ${balance.balance} ${threshold.asset}, below threshold ${threshold.threshold}`,
          );

          // Send Slack alert
          await notifySlackAlert(
            {
              statusCode: 500, // Use 500 to indicate critical issue
              method: "MONITOR",
              path: `/balance/${walletKey}`,
              timestamp: new Date().toISOString(),
              error: new Error(
                `Low balance alert: ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`,
              ),
            },
            {
              appName: "balance-monitor",
            },
          );
        } else {
          console.log(
            `[balance-monitor] OK: Wallet ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`,
          );
        }
      }

      // Check minimum reserve balance for Stellar
      const reserveInfo = await calculateStellarReserve(
        walletKey,
        minBalanceThreshold,
      );
      if (reserveInfo.isBelowThreshold) {
        console.warn(
          `[balance-monitor] RESERVE WARNING: ${formatReserveInfo(reserveInfo)}`,
        );

        // Alert admins
        await notifySlackAlert(
          {
            statusCode: 500,
            method: "MONITOR",
            path: `/reserve/${walletKey}`,
            timestamp: new Date().toISOString(),
            error: new Error(
              `Low XLM reserve alert: ${formatReserveInfo(reserveInfo)}`,
            ),
          },
          {
            appName: "balance-monitor",
          },
        );
      } else {
        console.log(
          `[balance-monitor] RESERVE OK: ${formatReserveInfo(reserveInfo)}`,
        );
      }
    } catch (error) {
      logger.error(
        `[balance-monitor] Error checking wallet ${walletKey}:`,
        error,
      );
      // Send alert for monitoring failure
      await notifySlackAlert(
        {
          statusCode: 500,
          method: "MONITOR",
          path: `/balance/${walletKey}`,
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error : new Error(String(error)),
        },
        {
          appName: "balance-monitor",
        },
      );
    }
  }
}

export async function runBalanceMonitorJob(): Promise<void> {
  await checkBalancesAndAlert();

  // Fetch provider wallet balances and check reserve liquidity ratios
  try {
    const mtn = new MTNProvider();
    const airtel = new AirtelService();
    const [mtnResult, airtelResult] = await Promise.all([
      mtn.getOperationalBalance().catch(() => null),
      airtel.getOperationalBalance().catch(() => null),
    ]);

    const walletBalances: Record<string, number> = {};
    if (mtnResult?.success && mtnResult.data) {
      walletBalances["mtn"] = (mtnResult.data as any).availableBalance ?? 0;
    }
    if (airtelResult?.success && airtelResult.data) {
      walletBalances["airtel"] =
        (airtelResult.data as any).availableBalance ?? 0;
    }

    if (Object.keys(walletBalances).length > 0) {
      await ledgerService.checkReserveLiquidity(walletBalances);
    }
  } catch (err) {
    logger.error("[balance-monitor] Reserve liquidity check failed:", err);
  }
}

export async function checkAirtelBalanceAndAlert(): Promise<void> {
  const airtel = new AirtelService();
  try {
    const result = await airtel.getOperationalBalance();
    if (!result.success || !result.data) {
      logger.error("[airtel-balance-monitor] Failed to fetch Airtel balance", result.error);
      return;
    }

    const rawBalance = result.data.availableBalance ?? 0;
    const balance = typeof rawBalance === "number" ? rawBalance : parseFloat(String(rawBalance));
    
    // Configurable threshold, defaulting to 50000
    const threshold = parseFloat(process.env.AIRTEL_LOW_BALANCE_THRESHOLD || "50000");

    logger.info(`[airtel-balance-monitor] Current Airtel balance: ${balance}`);

    // Trigger alert if below threshold
    if (balance < threshold) {
      console.warn(`[airtel-balance-monitor] ALERT: Airtel balance is ${balance}, below threshold ${threshold}`);
      
      await notifySlackAlert({
        statusCode: 500,
        method: "MONITOR",
        path: `/balance/airtel`,
        timestamp: new Date().toISOString(),
        error: new Error(`Airtel Low Liquidity Alert: Operational float balance is ${balance} (threshold: ${threshold})`),
      }, { appName: "airtel-balance-monitor" });
    }

    // Record snapshot
    try {
      const { pool } = require("../config/database");
      // Use query directly, assuming a table provider_balance_snapshots exists or just log if not
      await pool.query(
        `INSERT INTO provider_balance_snapshots (provider, balance, currency, recorded_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
        ["airtel", balance, result.data.currency || "NGN"]
      );
    } catch (dbErr) {
      logger.warn("[airtel-balance-monitor] Failed to record snapshot in DB (table might not exist)", dbErr);
    }
    
  } catch (err) {
    logger.error("[airtel-balance-monitor] Error running job:", err);
  }
}

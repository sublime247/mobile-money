import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";

/**
 * Reserve Calculator
 * Stellar requires minimum balance to prevent account deletion:
 * - Base reserve: 0.5 XLM per account
 * - Per trustline/offer/data entry: 0.5 XLM each
 */

export interface ReserveInfo {
  publicKey: string;
  baseReserve: number; // base reserve in XLM
  trustlineReserve: number; // reserve for trustlines in XLM
  totalRequired: number; // total required reserve
  nativeBalance: number; // current XLM balance
  availableBalance: number; // nativeBalance - totalRequired
  isBelowThreshold: boolean; // true if availableBalance < threshold
}

// Stellar reserves in stroops (1 XLM = 10,000,000 stroops)
const STROOPS_PER_XLM = 10_000_000;
const BASE_RESERVE_STROOPS = 5_000_000; // 0.5 XLM
const SUBENTRY_RESERVE_STROOPS = 5_000_000; // 0.5 XLM per trustline/offer/data

/**
 * Fetch account data and calculate reserves
 */
export async function calculateStellarReserve(
  publicKey: string,
  minimumThreshold: number = 5,
): Promise<ReserveInfo> {
  // Stellar minimum balance check
  const server = getStellarServer();
  const account = await server.loadAccount(publicKey);

  // Base reserve: 2 * Base reserve (1 for account + 1 for signing key)
  const baseReserveXlm = (2 * BASE_RESERVE_STROOPS) / STROOPS_PER_XLM;

  // Count trustlines (non-native balance entries)
  const trustlineCount = account.balances.filter(
    (b) => b.asset_type !== "native",
  ).length;

  // Count other subentries (offers, data entries, etc)
  // We use the actual subentry_count if available, otherwise fallback to trustline count.
  const subentryCount = (account as any).subentry_count ?? trustlineCount;

  // Calculate trustline reserve
  const trustlineReserveStroops = subentryCount * SUBENTRY_RESERVE_STROOPS;
  const trustlineReserveXlm = trustlineReserveStroops / STROOPS_PER_XLM;

  // Total reserve
  const totalRequiredXlm = baseReserveXlm + trustlineReserveXlm;

  // Get native balance
  const nativeBalance = account.balances
    .filter((b) => b.asset_type === "native")
    .map((b) => parseFloat(b.balance))
    .reduce((a, b) => a + b, 0);

  // Available balance
  const availableXlm = nativeBalance - totalRequiredXlm;

  return {
    publicKey,
    baseReserve: baseReserveXlm,
    trustlineReserve: trustlineReserveXlm,
    totalRequired: totalRequiredXlm,
    nativeBalance,
    availableBalance: availableXlm,
    isBelowThreshold: availableXlm < minimumThreshold,
  };
}

/**
 * Format reserve info for logging
 */
export function formatReserveInfo(info: ReserveInfo): string {
  return (
    `Account: ${info.publicKey.slice(0, 8)}... | ` +
    `Balance: ${info.nativeBalance.toFixed(2)} XLM | ` +
    `Required: ${info.totalRequired.toFixed(2)} XLM | ` +
    `Available: ${info.availableBalance.toFixed(2)} XLM`
  );
}

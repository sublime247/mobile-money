import { getStellarServer } from "../config/stellar";
import { MobileMoneyProvider } from "../config/providers";
import {
  crossChainBalanceGauge,
  crossChainAnomalyTotal,
} from "../utils/metrics";
import logger from "../utils/logger";
import { MTNProvider } from "./mobilemoney/providers/mtn";
import { AirtelService } from "./mobilemoney/providers/airtel";

export interface ChainAssetSnapshot {
  chain: "stellar" | "mtn" | "airtel" | "orange";
  asset: string;
  address: string;
  balance: string;
  capturedAt: Date;
}

/**
 * Fetches the operational balance from a mobile money provider
 * @param provider - The mobile money provider (MTN, Airtel, Orange)
 * @param currency - The currency code (e.g., XAF, NGN)
 * @returns The current balance as a string
 */
async function getProviderBalance(
  provider: MobileMoneyProvider,
  currency: string,
): Promise<string> {
  try {
    let result;
    
    switch (provider) {
      case MobileMoneyProvider.MTN:
        const mtnProvider = new MTNProvider();
        result = await mtnProvider.getOperationalBalance();
        break;
        
      case MobileMoneyProvider.AIRTEL:
        const airtelService = new AirtelService();
        result = await airtelService.getOperationalBalance();
        break;
        
      case MobileMoneyProvider.ORANGE:
        logger.warn({ provider, currency }, "Orange balance checks are not implemented");
        return "0";
        
      default:
        logger.warn({ provider, currency }, 'Unknown provider for balance check');
        return "0";
    }
    
    if (result.success && result.data) {
      return result.data.availableBalance.toString();
    } else {
      logger.error({ provider, currency, error: result.error }, 'Failed to fetch provider balance');
      return "0";
    }
  } catch (error) {
    logger.error({ error, provider, currency }, 'Error fetching provider balance');
    return "0";
  }
}

function getStellarAddresses(): string[] {
  const extra = process.env.CROSS_CHAIN_STELLAR_ADDRESSES || "";
  const hot = process.env.HOT_WALLET_PUBLIC_KEYS || "";
  return [...extra.split(","), ...hot.split(",")]
    .map((k) => k.trim())
    .filter(Boolean);
}

function getDropThreshold(): number {
  const val = parseFloat(
    process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT || "20",
  );
  return isNaN(val) ? 20 : val;
}

export class CrossChainMonitorService {
  private static instance: CrossChainMonitorService;
  private lastSnapshot: ChainAssetSnapshot[] = [];

  static getInstance(): CrossChainMonitorService {
    if (!CrossChainMonitorService.instance) {
      CrossChainMonitorService.instance = new CrossChainMonitorService();
    }
    return CrossChainMonitorService.instance;
  }

  async snapshot(): Promise<ChainAssetSnapshot[]> {
    const capturedAt = new Date();
    const results: ChainAssetSnapshot[] = [];

    // --- Stellar balances ---
    const server = getStellarServer();
    const addresses = getStellarAddresses();

    for (const address of addresses) {
      try {
        const account = await server.loadAccount(address);
        for (const bal of account.balances) {
          const asset =
            bal.asset_type === "native"
              ? "XLM"
              : // cast: non-native balances always have asset_code
                (bal as { asset_code: string }).asset_code;
          results.push({
            chain: "stellar",
            asset,
            address,
            balance: bal.balance,
            capturedAt,
          });
        }
      } catch (err) {
        logger.error(
          { error: err, address },
          'Failed to load Stellar account'
        );
      }
    }

    // --- Mobile money provider balances ---
    const providerCurrencyMap: Array<{
      provider: MobileMoneyProvider;
      chain: ChainAssetSnapshot["chain"];
      currency: string;
    }> = [
      { provider: MobileMoneyProvider.MTN, chain: "mtn", currency: "XAF" },
      { provider: MobileMoneyProvider.AIRTEL, chain: "airtel", currency: "XAF" },
      { provider: MobileMoneyProvider.ORANGE, chain: "orange", currency: "XAF" },
    ];

    for (const { provider, chain, currency } of providerCurrencyMap) {
      const balance = await getProviderBalance(provider, currency);
      results.push({
        chain,
        asset: currency,
        address: provider,
        balance,
        capturedAt,
      });
    }

    // --- Update Prometheus gauges & detect anomalies ---
    const threshold = getDropThreshold();

    for (const snap of results) {
      crossChainBalanceGauge.set(
        { chain: snap.chain, asset: snap.asset, address: snap.address },
        parseFloat(snap.balance),
      );

      const prev = this.lastSnapshot.find(
        (s) =>
          s.chain === snap.chain &&
          s.asset === snap.asset &&
          s.address === snap.address,
      );

      if (prev) {
        const prevBal = parseFloat(prev.balance);
        const curBal = parseFloat(snap.balance);
        if (prevBal > 0) {
          const dropPct = ((prevBal - curBal) / prevBal) * 100;
          if (dropPct > threshold) {
            const reason = "balance_drop";
            crossChainAnomalyTotal.inc({
              chain: snap.chain,
              asset: snap.asset,
              reason,
            });
            logger.warn(
              {
                chain: snap.chain,
                asset: snap.asset,
                address: snap.address,
                previousBalance: prev.balance,
                currentBalance: snap.balance,
                dropPct: dropPct.toFixed(2),
                thresholdPct: threshold,
                reason,
              },
              'Cross-chain balance anomaly detected'
            );
          }
        }
      }
    }

    this.lastSnapshot = results;
    return results;
  }

  getLastSnapshot(): ChainAssetSnapshot[] {
    return this.lastSnapshot;
  }
}

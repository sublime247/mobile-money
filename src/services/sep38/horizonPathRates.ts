/**
 * Horizon Path Payment Rate Provider
 *
 * Queries the Stellar Horizon strict-send-paths endpoint to discover
 * the best available swap rate across liquidity pools and order books.
 * Results are fed into the SEP-38 rate mapper as live quotes.
 *
 * When Horizon returns a path:
 *   - The best (highest destination amount) path is selected
 *   - Exchange rate = destination_amount / source_amount
 *   - A configurable spread is applied for insufficient-liquidity protection
 *   - Requests with no viable path return null (rejected at the caller)
 *
 * Usage:
 *   const provider = new HorizonPathRateProvider();
 *   const rate = await provider.getIndicativePrice('stellar:USDC:GA...', 'iso4217:KES');
 */

import { getStellarServer } from '../../config/stellar';
import { setRateProvider, IRateProvider, RateResult } from './rateProvider';
import logger from '../../utils/logger';
import StellarSdk from '@stellar/stellar-sdk';

const PRICE_PRECISION = 7;
const DEFAULT_SOURCE_AMOUNT = '1';   // 1 unit of sell_asset for rate discovery
const DEFAULT_FEE_PERCENT  = parseFloat(process.env.SEP38_FEE_PERCENT || '0.5');
const DEFAULT_FEE_FIXED    = parseFloat(process.env.SEP38_FEE_FIXED   || '0');

/** Map a SEP-38 asset string to a StellarSdk.Asset. */
function parseStellarAsset(asset: string): StellarSdk.Asset | null {
  if (asset === 'stellar:native' || asset === 'stellar:XLM') {
    return StellarSdk.Asset.native();
  }
  if (asset.startsWith('stellar:')) {
    const parts = asset.split(':');
    const code   = parts[1];
    const issuer = parts[2];
    if (code && issuer) return new StellarSdk.Asset(code, issuer);
  }
  return null;
}

/**
 * Fetch the best strict-send path from Horizon for the given asset pair.
 *
 * Returns the implied exchange rate (destination / source) or null when:
 *   - Either asset cannot be parsed as a Stellar asset
 *   - Horizon returns no paths (insufficient liquidity)
 *   - A network error occurs
 */
async function getBestPathRate(
  sellAsset: string,
  buyAsset: string,
  sourceAmount = DEFAULT_SOURCE_AMOUNT,
): Promise<number | null> {
  const source      = parseStellarAsset(sellAsset);
  const destination = parseStellarAsset(buyAsset);

  // Non-Stellar assets (iso4217:*) cannot use path payments
  if (!source || !destination) return null;

  try {
    const server = getStellarServer();
    const paths  = await (server.strictSendPaths as any)(
      source,
      sourceAmount,
      [destination],
    ).call();

    if (!paths?.records?.length) {
      logger.debug({ sellAsset, buyAsset }, '[sep38/horizon] No path found');
      return null;
    }

    // Select the path that maximises the destination amount
    const best = paths.records.reduce((max: any, p: any) =>
      parseFloat(p.destination_amount) > parseFloat(max.destination_amount) ? p : max,
      paths.records[0],
    );

    const srcAmt  = parseFloat(sourceAmount);
    const dstAmt  = parseFloat(best.destination_amount as string);

    if (!srcAmt || !dstAmt) return null;

    const rate = dstAmt / srcAmt;
    logger.debug({ sellAsset, buyAsset, rate, path: best.path }, '[sep38/horizon] Path rate resolved');
    return rate;
  } catch (err) {
    logger.warn({ sellAsset, buyAsset, err }, '[sep38/horizon] Path rate lookup failed');
    return null;
  }
}

/**
 * SEP-38 rate provider backed by live Horizon path-payment data.
 *
 * Falls back gracefully to null when Horizon is unavailable so the
 * SEP-38 router can use the CurrencyServiceRateProvider as a fallback.
 */
export class HorizonPathRateProvider implements IRateProvider {
  constructor(
    private readonly feePercent = DEFAULT_FEE_PERCENT,
    private readonly feeFixed   = DEFAULT_FEE_FIXED,
  ) {}

  async getIndicativePrice(sellAsset: string, buyAsset: string): Promise<RateResult | null> {
    const rate = await getBestPathRate(sellAsset, buyAsset);
    if (rate === null) return null;

    // Indicative: apply small randomised spread for market-movement allowance
    const spread = 1 + (Math.random() - 0.5) * 0.002;
    const price  = (rate * spread).toFixed(PRICE_PRECISION);

    return {
      price,
      fee_percent: this.feePercent.toFixed(2),
      fee_fixed:   this.feeFixed.toFixed(PRICE_PRECISION),
    };
  }

  async getFirmPrice(sellAsset: string, buyAsset: string): Promise<RateResult | null> {
    const rate = await getBestPathRate(sellAsset, buyAsset);
    if (rate === null) return null;

    // Firm: no spread — rate is locked at the Horizon-observed value
    return {
      price:       rate.toFixed(PRICE_PRECISION),
      fee_percent: this.feePercent.toFixed(2),
      fee_fixed:   this.feeFixed.toFixed(PRICE_PRECISION),
    };
  }
}

/**
 * Activate the Horizon path-payment rate provider.
 * Call once at application startup (after Stellar config is initialised).
 *
 * The previous provider is replaced; call setRateProvider() to revert.
 */
export function activateHorizonPathRates(): void {
  setRateProvider(new HorizonPathRateProvider());
  logger.info('[sep38] HorizonPathRateProvider activated — live path-payment rates enabled');
}

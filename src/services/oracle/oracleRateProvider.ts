import { Address, StrKey } from "@stellar/stellar-sdk";
import logger from "../../utils/logger";
import { getNetworkPassphrase, STELLAR_NETWORKS } from "../../config/stellar";
import {
  IOracleClient,
  OracleError,
  SorobanOracleClient,
} from "./oracleClient";

/**
 * Local fiat rates from the on-chain oracle (contracts/oracle).
 *
 * `OracleRateProvider` turns oracle quotes into plain "units of `to` per unit
 * of `from`" rates, caches them, and refuses rates that would allow
 * arbitrage. It deliberately knows nothing about where the rates end up:
 * `CurrencyService` asks it for rates and keeps its static fallback table for
 * anything the oracle cannot supply.
 *
 * Configuration (all optional unless noted):
 *   ORACLE_RATES_ENABLED    "true" to use the oracle at all (default: off)
 *   ORACLE_CONTRACT_ID      oracle contract id (required when enabled)
 *   ORACLE_RPC_URL          Soroban RPC URL (required on mainnet; the public
 *                           testnet RPC is the default on testnet)
 *   ORACLE_ASSET_MAP        JSON object mapping currency code -> asset contract
 *                           address, e.g. {"USD":"C...","NGN":"C..."} (required)
 *   ORACLE_QUOTE_AMOUNT     amount_in used for quotes, in base units
 *                           (default 10000000 = 1 unit of a 7-decimal asset)
 *   ORACLE_MAX_SPREAD_BPS   largest tolerated spread, in basis points (100)
 *   ORACLE_CACHE_TTL_MS     how long a rate is reused (default 60000)
 *   ORACLE_TIMEOUT_MS       per-request RPC timeout (default 5000)
 *
 * Quotes are ratios of base units, so every mapped asset must use the same
 * number of decimals (7 for Stellar asset contracts).
 */

export interface OracleRateConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Currency code -> asset contract address. */
  assetMap: Record<string, string>;
  quoteAmount: bigint;
  maxSpreadBps: number;
  cacheTtlMs: number;
  timeoutMs: number;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_QUOTE_AMOUNT = 10_000_000n;
const DEFAULT_MAX_SPREAD_BPS = 100;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Round-trip gains above this are treated as arbitrage rather than rounding. */
const ARBITRAGE_TOLERANCE_BPS = 1n;

export function isOracleRatesEnabled(env = process.env): boolean {
  return env.ORACLE_RATES_ENABLED === "true";
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
}

/**
 * Read the oracle configuration from the environment. Returns null (and logs
 * why) when the oracle is disabled or misconfigured, so callers simply keep
 * using the existing rate source.
 */
export function loadOracleRateConfig(
  env = process.env,
): OracleRateConfig | null {
  if (!isOracleRatesEnabled(env)) return null;

  const fail = (reason: string): null => {
    logger.warn(`[OracleRates] Disabled: ${reason}`);
    return null;
  };

  const contractId = (env.ORACLE_CONTRACT_ID || "").trim();
  if (!StrKey.isValidContract(contractId)) {
    return fail("ORACLE_CONTRACT_ID is missing or not a valid contract id");
  }

  const isTestnet =
    (env.STELLAR_NETWORK || STELLAR_NETWORKS.TESTNET) !==
    STELLAR_NETWORKS.MAINNET;
  const rpcUrl = (
    env.ORACLE_RPC_URL || (isTestnet ? TESTNET_RPC_URL : "")
  ).trim();
  if (!rpcUrl) return fail("ORACLE_RPC_URL is required on mainnet");

  let assetMap: Record<string, string>;
  try {
    assetMap = JSON.parse(env.ORACLE_ASSET_MAP || "");
    if (
      assetMap === null ||
      typeof assetMap !== "object" ||
      Array.isArray(assetMap)
    ) {
      throw new Error("not an object");
    }
    for (const address of Object.values(assetMap)) new Address(address);
  } catch (err) {
    return fail(
      `ORACLE_ASSET_MAP must be a JSON object of currency code to contract address (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!assetMap.USD) {
    // Every CurrencyService rate is quoted against USD.
    return fail("ORACLE_ASSET_MAP must include a USD entry");
  }

  let quoteAmount: bigint;
  try {
    quoteAmount = env.ORACLE_QUOTE_AMOUNT
      ? BigInt(env.ORACLE_QUOTE_AMOUNT)
      : DEFAULT_QUOTE_AMOUNT;
  } catch {
    return fail("ORACLE_QUOTE_AMOUNT must be an integer");
  }
  if (quoteAmount <= 0n) return fail("ORACLE_QUOTE_AMOUNT must be positive");

  const maxSpreadBps = positiveInt(
    env.ORACLE_MAX_SPREAD_BPS,
    DEFAULT_MAX_SPREAD_BPS,
  );
  const cacheTtlMs = positiveInt(env.ORACLE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  const timeoutMs = positiveInt(env.ORACLE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  if (Number.isNaN(maxSpreadBps + cacheTtlMs + timeoutMs)) {
    return fail(
      "ORACLE_MAX_SPREAD_BPS, ORACLE_CACHE_TTL_MS and ORACLE_TIMEOUT_MS must be positive integers",
    );
  }

  return {
    contractId,
    rpcUrl,
    networkPassphrase: getNetworkPassphrase(),
    assetMap,
    quoteAmount,
    maxSpreadBps,
    cacheTtlMs,
    timeoutMs,
  };
}

interface CachedRate {
  rate: number;
  expiresAt: number;
}

export class OracleRateProvider {
  private readonly cache = new Map<string, CachedRate>();

  constructor(
    private readonly client: IOracleClient,
    private readonly config: Pick<
      OracleRateConfig,
      "assetMap" | "quoteAmount" | "maxSpreadBps" | "cacheTtlMs"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  supports(currency: string): boolean {
    return this.config.assetMap[currency] !== undefined;
  }

  /**
   * Units of `to` per one unit of `from`. Throws an `OracleError` if either
   * currency is unmapped, the oracle is unavailable, or the quote fails the
   * spread / arbitrage checks.
   */
  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;

    const key = `${from}>${to}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.rate;

    const assetIn = this.config.assetMap[from];
    const assetOut = this.config.assetMap[to];
    if (!assetIn || !assetOut) {
      throw new OracleError(
        `No oracle asset configured for ${!assetIn ? from : to}`,
        "NO_REGISTERED_POOLS",
      );
    }

    const { quoteAmount, maxSpreadBps } = this.config;

    // The contract rejects the quote when its own pools disagree by more than
    // maxSpreadBps (SPREAD_TOO_HIGH).
    const amountOut = await this.client.getRateWithSpread({
      assetIn,
      assetOut,
      amountIn: quoteAmount,
      maxSpreadBps,
    });

    // Sell the proceeds straight back. A round trip that returns more than we
    // put in is an arbitrage; one that loses more than the allowed spread is a
    // stale or manipulated quote. Either way the rate is not used.
    const amountBack = await this.client.getRateWithSpread({
      assetIn: assetOut,
      assetOut: assetIn,
      amountIn: amountOut,
      maxSpreadBps,
    });
    this.assertRoundTrip(from, to, quoteAmount, amountBack);

    const rate = Number(amountOut) / Number(quoteAmount);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new OracleError(
        `Oracle produced an unusable ${from}/${to} rate`,
        "INVALID_RESPONSE",
      );
    }

    this.cache.set(key, {
      rate,
      expiresAt: this.now() + this.config.cacheTtlMs,
    });
    return rate;
  }

  /**
   * Units of each currency per USD - the shape `CurrencyService` stores.
   * Currencies the oracle cannot price are left out (and logged) so the caller
   * can fall back to its own source for them.
   */
  async getUsdRates(
    currencies: readonly string[],
  ): Promise<Record<string, number>> {
    const targets = currencies.filter((c) => c !== "USD" && this.supports(c));
    if (!this.supports("USD") || targets.length === 0) return {};

    const settled = await Promise.allSettled(
      targets.map((currency) => this.getRate("USD", currency)),
    );

    const rates: Record<string, number> = {};
    settled.forEach((result, index) => {
      const currency = targets[index];
      if (result.status === "fulfilled") {
        rates[currency] = result.value;
      } else {
        const reason = result.reason;
        logger.warn(
          `[OracleRates] No oracle rate for USD/${currency}, using fallback: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    });
    return rates;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private assertRoundTrip(
    from: string,
    to: string,
    amountIn: bigint,
    amountBack: bigint,
  ): void {
    const lossBps = ((amountIn - amountBack) * 10_000n) / amountIn;
    const gainBps = ((amountBack - amountIn) * 10_000n) / amountIn;

    if (gainBps > ARBITRAGE_TOLERANCE_BPS) {
      throw new OracleError(
        `Oracle ${from}/${to} quote allows arbitrage: round trip gains ${gainBps} bps`,
        "SPREAD_TOO_HIGH",
      );
    }
    if (lossBps > BigInt(this.config.maxSpreadBps)) {
      throw new OracleError(
        `Oracle ${from}/${to} quote spread too wide: round trip loses ${lossBps} bps (max ${this.config.maxSpreadBps})`,
        "SPREAD_TOO_HIGH",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: OracleRateProvider | null | undefined;

/** The env-configured provider, or null when the oracle is not enabled. */
export function getOracleRateProvider(): OracleRateProvider | null {
  if (instance === undefined) {
    const config = loadOracleRateConfig();
    instance = config
      ? new OracleRateProvider(new SorobanOracleClient(config), config)
      : null;
  }
  return instance;
}

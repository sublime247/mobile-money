/**
 * Vodafone Cash Ghana payment routing (#1961)
 * ────────────────────────────────────────────
 * Mirrors waveSenegalRouting.ts's shape exactly: decides when a
 * payment/payout should go to {@link VodafoneGhanaProvider} and provides
 * thin, validated entry points that normalize the provider response to the
 * shape the rest of the bridge consumes.
 *
 * A request routes to Vodafone Ghana when either:
 *   • the caller explicitly selects the `vodafone_ghana` provider key, or
 *   • no provider is forced and the MSISDN is a valid Ghanaian number
 *     (`+233` + 9 digits).
 */

import {
  MobileMoneyProvider,
  validateProviderLimits,
} from "../../config/providers";
import { VodafoneGhanaProvider } from "./providers/vodafoneGhana";
import logger from "../../utils/logger";

export const VODAFONE_GHANA_PROVIDER_KEY = "vodafone_ghana";

const GHANA_PHONE_REGEX = /^\+233\d{9}$/;

export function isValidGhanaPhoneNumber(phoneNumber: string): boolean {
  return GHANA_PHONE_REGEX.test(phoneNumber.trim());
}

export interface VodafoneGhanaRouteQuery {
  /** Explicit provider key chosen by the caller, if any. */
  provider?: string | null;
  /** Destination / source MSISDN. */
  phoneNumber?: string | null;
}

export interface VodafoneGhanaRouteResult {
  success: boolean;
  data?: unknown;
  error?: unknown;
}

/** Returns true when the given request should be handled by Vodafone Ghana. */
export function isVodafoneGhanaRoute(query: VodafoneGhanaRouteQuery): boolean {
  const provider = query.provider?.trim().toLowerCase();
  if (provider) {
    return provider === VODAFONE_GHANA_PROVIDER_KEY;
  }
  return query.phoneNumber ? isValidGhanaPhoneNumber(query.phoneNumber) : false;
}

let cachedProvider: VodafoneGhanaProvider | null = null;

/** Lazily construct (and reuse) a single Vodafone Ghana provider instance. */
export function getVodafoneGhanaProvider(): VodafoneGhanaProvider {
  if (!cachedProvider) {
    cachedProvider = new VodafoneGhanaProvider();
  }
  return cachedProvider;
}

/** Test/DI seam — override or reset the cached provider instance. */
export function setVodafoneGhanaProvider(
  provider: VodafoneGhanaProvider | null,
): void {
  cachedProvider = provider;
}

function amountToNumber(amount: string | number): number {
  return typeof amount === "number" ? amount : Number.parseFloat(amount);
}

function guardAmount(amount: string | number): VodafoneGhanaRouteResult | null {
  const numeric = amountToNumber(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { success: false, error: new Error(`Invalid amount: ${amount}`) };
  }
  const limits = validateProviderLimits(
    MobileMoneyProvider.VODAFONE_GHANA,
    numeric,
  );
  if (!limits.valid) {
    return { success: false, error: new Error(limits.error) };
  }
  return null;
}

/**
 * Route a collection (customer pays in) through Vodafone Cash Ghana after
 * validating the MSISDN and the amount against the provider's configured
 * limits. `voucherCode` is forwarded to authorize the debit via a
 * merchant-generated voucher instead of a USSD PIN prompt.
 */
export async function routeVodafoneGhanaPayment(
  phoneNumber: string,
  amount: string | number,
  voucherCode?: string,
): Promise<VodafoneGhanaRouteResult> {
  if (!isValidGhanaPhoneNumber(phoneNumber)) {
    return {
      success: false,
      error: new Error(
        "Invalid Ghana phone number format. Use +233 followed by 9 digits.",
      ),
    };
  }

  const amountError = guardAmount(amount);
  if (amountError) return amountError;

  logger.info(
    { provider: VODAFONE_GHANA_PROVIDER_KEY, operation: "payment" },
    "VodafoneGhanaRouting: routing collection",
  );
  return getVodafoneGhanaProvider().requestPayment(
    phoneNumber,
    String(amount),
    voucherCode,
  );
}

/** Route a payout (bridge pays out) through Vodafone Cash Ghana. */
export async function routeVodafoneGhanaPayout(
  phoneNumber: string,
  amount: string | number,
): Promise<VodafoneGhanaRouteResult> {
  if (!isValidGhanaPhoneNumber(phoneNumber)) {
    return {
      success: false,
      error: new Error(
        "Invalid Ghana phone number format. Use +233 followed by 9 digits.",
      ),
    };
  }

  const amountError = guardAmount(amount);
  if (amountError) return amountError;

  logger.info(
    { provider: VODAFONE_GHANA_PROVIDER_KEY, operation: "payout" },
    "VodafoneGhanaRouting: routing payout",
  );
  return getVodafoneGhanaProvider().sendPayout(phoneNumber, String(amount));
}

/** Canonical settlement status for a Vodafone Ghana transaction id. */
export async function getVodafoneGhanaTransactionStatus(
  transactionId: string,
): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
  return getVodafoneGhanaProvider().getTransactionStatus(transactionId);
}

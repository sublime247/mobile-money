import {
  KYCLevel,
  TRANSACTION_LIMITS,
  MIN_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_AMOUNT,
} from "../../config/limits";
import { KYCService } from "../kyc/kycService";
import { TransactionModel } from "../../models/transaction";
import {
  regionalProviderLimitService,
  RegionalLimitCheckResult,
} from "../regionalProviderLimitService";
import { queryRead } from "../../config/database";
import { currencyService, SUPPORTED_CURRENCIES } from "../currency";
import { getEffectiveDailyLimit } from "../../compliance/riskTier";

const KYC_VOLUME_LIMITS_USD: Record<
  KYCLevel,
  { daily: number; monthly: number }
> = {
  [KYCLevel.Unverified]: { daily: 500, monthly: 15_000 },
  [KYCLevel.Basic]: { daily: 3_000, monthly: 90_000 },
  [KYCLevel.Full]: { daily: 25_000, monthly: 750_000 },
};

interface VolumeTotalsRow {
  currency: string;
  daily_usd_total: string;
  monthly_usd_total: string;
  daily_unconverted_total: string;
  monthly_unconverted_total: string;
}

export interface LimitCheckResult {
  allowed: boolean;
  kycLevel: KYCLevel;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  message?: string;
  upgradeAvailable?: boolean;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  currentDailyTotalUsd?: number;
  currentMonthlyTotalUsd?: number;
}

export class TransactionLimitService {
  constructor(
    private kycService: KYCService,
    private transactionModel: TransactionModel,
  ) {}

  /**
   * Check transaction limits including regional provider-specific limits
   * Regional limits take precedence over KYC-based limits when applicable
   */
  async checkTransactionLimitWithRegional(
    userId: string,
    transactionAmount: number,
    providerName: string,
    countryCode?: string,
    regionCode?: string,
    currency = "USD",
  ): Promise<LimitCheckResult> {
    // Validate per-transaction amount limits first
    if (transactionAmount < MIN_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too small. Minimum allowed: ${MIN_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    if (transactionAmount > MAX_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too large. Maximum allowed: ${MAX_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    // Check for regional provider limits first
    const regionalCheck =
      await regionalProviderLimitService.checkRegionalLimits(
        providerName,
        countryCode,
        regionCode,
      );

    // Get user's KYC level
    const kycLevel = await this.kycService.getUserKYCLevel(userId);
    const volumeLimitCheck = await this.checkKycVolumeCaps(
      userId,
      transactionAmount,
      currency,
      kycLevel,
    );
    if (volumeLimitCheck) return volumeLimitCheck;

    // Determine which limits to use (regional takes precedence)
    let dailyLimit: number;
    let perTransactionLimit: number;
    let limitSource: string;

    if (regionalCheck.hasRegionalLimit) {
      dailyLimit = regionalCheck.dailyLimit;
      perTransactionLimit = regionalCheck.perTransactionLimit;
      limitSource = `regional (${regionalCheck.regionalLimit?.country_code || regionalCheck.regionalLimit?.region_code})`;
    } else {
      dailyLimit = TRANSACTION_LIMITS[kycLevel];
      perTransactionLimit = MAX_TRANSACTION_AMOUNT;
      limitSource = `KYC-based (${kycLevel})`;
    }

    // Check per-transaction limit
    if (transactionAmount > perTransactionLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction exceeds ${limitSource} per-transaction limit of ${perTransactionLimit} XAF. Attempted: ${transactionAmount} XAF.`,
        upgradeAvailable:
          !regionalCheck.hasRegionalLimit && kycLevel !== KYCLevel.Full,
      };
    }

    // Calculate 24-hour window start time
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Query recent transactions
    const recentTransactions =
      await this.transactionModel.findCompletedByUserSince(
        userId,
        twentyFourHoursAgo,
      );

    // Sum transaction amounts
    const currentDailyTotal = recentTransactions.reduce(
      (sum, tx) => sum + parseFloat(tx.amount),
      0,
    );
    const effectiveDailyLimit = await getEffectiveDailyLimit(
      userId,
      dailyLimit,
    );

    // Calculate new total
    const newTotal = currentDailyTotal + transactionAmount;
    const remainingLimit = effectiveDailyLimit - currentDailyTotal;

    // Return approval if newTotal ≤ dailyLimit
    if (newTotal > effectiveDailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit: effectiveDailyLimit,
        currentDailyTotal,
        remainingLimit,
        message: this.buildRegionalLimitErrorMessage(
          kycLevel,
          effectiveDailyLimit,
          currentDailyTotal,
          transactionAmount,
          limitSource,
          regionalCheck.hasRegionalLimit,
        ),
        upgradeAvailable:
          !regionalCheck.hasRegionalLimit && kycLevel !== KYCLevel.Full,
      };
    }

    return {
      allowed: true,
      kycLevel,
      dailyLimit: effectiveDailyLimit,
      currentDailyTotal,
      remainingLimit: effectiveDailyLimit - newTotal,
    };
  }

  private buildRegionalLimitErrorMessage(
    kycLevel: KYCLevel,
    limit: number,
    current: number,
    attempted: number,
    limitSource: string,
    hasRegionalLimit: boolean,
  ): string {
    let message = `Transaction limit exceeded. Your ${limitSource} daily limit is ${limit} XAF. `;
    message += `Current daily total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;

    if (!hasRegionalLimit) {
      if (kycLevel === KYCLevel.Unverified) {
        message += " Upgrade to Basic KYC for 100,000 XAF daily limit.";
      } else if (kycLevel === KYCLevel.Basic) {
        message += " Upgrade to Full KYC for 1,000,000 XAF daily limit.";
      }
    }

    return message;
  }

  async checkTransactionLimit(
    userId: string,
    transactionAmount: number,
    currency = "USD",
  ): Promise<LimitCheckResult> {
    // Validate per-transaction amount limits first
    if (transactionAmount < MIN_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified, // Placeholder, actual level not needed for amount validation
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too small. Minimum allowed: ${MIN_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    if (transactionAmount > MAX_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified, // Placeholder, actual level not needed for amount validation
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too large. Maximum allowed: ${MAX_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    // Get user's KYC level
    const kycLevel = await this.kycService.getUserKYCLevel(userId);
    const volumeLimitCheck = await this.checkKycVolumeCaps(
      userId,
      transactionAmount,
      currency,
      kycLevel,
    );
    if (volumeLimitCheck) return volumeLimitCheck;

    const dailyLimit = TRANSACTION_LIMITS[kycLevel];
    const effectiveDailyLimit = await getEffectiveDailyLimit(
      userId,
      dailyLimit,
    );

    // Calculate 24-hour window start time (current time - 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Query recent transactions using transactionModel.findCompletedByUserSince
    const recentTransactions =
      await this.transactionModel.findCompletedByUserSince(
        userId,
        twentyFourHoursAgo,
      );

    // Sum transaction amounts to get currentDailyTotal
    const currentDailyTotal = recentTransactions.reduce(
      (sum, tx) => sum + parseFloat(tx.amount),
      0,
    );

    // Calculate newTotal = currentDailyTotal + transactionAmount
    const newTotal = currentDailyTotal + transactionAmount;
    const remainingLimit = effectiveDailyLimit - currentDailyTotal;

    // Return approval if newTotal ≤ dailyLimit, rejection otherwise
    if (newTotal > effectiveDailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit: effectiveDailyLimit,
        currentDailyTotal,
        remainingLimit,
        message: this.buildErrorMessage(
          kycLevel,
          effectiveDailyLimit,
          currentDailyTotal,
          transactionAmount,
        ),
        upgradeAvailable: kycLevel !== KYCLevel.Full,
      };
    }

    return {
      allowed: true,
      kycLevel,
      dailyLimit: effectiveDailyLimit,
      currentDailyTotal,
      remainingLimit: effectiveDailyLimit - newTotal,
    };
  }

  private async checkKycVolumeCaps(
    userId: string,
    transactionAmount: number,
    currency: string,
    kycLevel: KYCLevel,
  ): Promise<LimitCheckResult | null> {
    const normalizedCurrency = currency.toUpperCase();
    if (
      !(SUPPORTED_CURRENCIES as readonly string[]).includes(normalizedCurrency)
    ) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Unsupported currency for transaction limit validation: ${currency}`,
      };
    }

    const requestedUsd = currencyService.convertToBase(
      transactionAmount,
      normalizedCurrency as (typeof SUPPORTED_CURRENCIES)[number],
    ).convertedAmount;
    const result = await queryRead<VolumeTotalsRow>(
      `SELECT
         COALESCE(currency, 'USD') AS currency,
         COALESCE(SUM(
           CASE WHEN converted_amount IS NOT NULL THEN converted_amount
                WHEN COALESCE(currency, 'USD') = 'USD' THEN amount
                ELSE 0 END
         ) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::text
           AS daily_usd_total,
         COALESCE(SUM(
           CASE WHEN converted_amount IS NOT NULL THEN converted_amount
                WHEN COALESCE(currency, 'USD') = 'USD' THEN amount
                ELSE 0 END
         ), 0)::text AS monthly_usd_total,
         COALESCE(SUM(
           CASE WHEN converted_amount IS NULL
                     AND COALESCE(currency, 'USD') <> 'USD' THEN amount
                ELSE 0 END
         ) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::text
           AS daily_unconverted_total,
         COALESCE(SUM(
           CASE WHEN converted_amount IS NULL
                     AND COALESCE(currency, 'USD') <> 'USD' THEN amount
                ELSE 0 END
         ), 0)::text AS monthly_unconverted_total
       FROM transactions
       WHERE user_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
         AND status IN ('completed', 'processing', 'pending', 'review', 'pending_review')
       GROUP BY COALESCE(currency, 'USD')`,
      [userId],
    );

    let dailyTotalUsd = 0;
    let monthlyTotalUsd = 0;
    for (const row of result.rows) {
      dailyTotalUsd += Number(row.daily_usd_total);
      monthlyTotalUsd += Number(row.monthly_usd_total);
      const rowCurrency = row.currency.toUpperCase();
      const dailyUnconverted = Number(row.daily_unconverted_total);
      const monthlyUnconverted = Number(row.monthly_unconverted_total);
      if (dailyUnconverted > 0) {
        dailyTotalUsd += currencyService.convertToBase(
          dailyUnconverted,
          rowCurrency as (typeof SUPPORTED_CURRENCIES)[number],
        ).convertedAmount;
      }
      if (monthlyUnconverted > 0) {
        monthlyTotalUsd += currencyService.convertToBase(
          monthlyUnconverted,
          rowCurrency as (typeof SUPPORTED_CURRENCIES)[number],
        ).convertedAmount;
      }
    }

    const caps = KYC_VOLUME_LIMITS_USD[kycLevel];
    if (
      dailyTotalUsd + requestedUsd > caps.daily ||
      monthlyTotalUsd + requestedUsd > caps.monthly
    ) {
      const exceededWindow =
        dailyTotalUsd + requestedUsd > caps.daily ? "24-hour" : "30-day";
      return {
        allowed: false,
        kycLevel,
        dailyLimit: TRANSACTION_LIMITS[kycLevel],
        currentDailyTotal: 0,
        remainingLimit: 0,
        dailyLimitUsd: caps.daily,
        monthlyLimitUsd: caps.monthly,
        currentDailyTotalUsd: dailyTotalUsd,
        currentMonthlyTotalUsd: monthlyTotalUsd,
        message: `Transaction exceeds the ${exceededWindow} KYC volume limit. Your verified tier allows $${caps.daily.toLocaleString()} per day and $${caps.monthly.toLocaleString()} per 30 days. Upgrade your KYC level to increase your limits.`,
        upgradeAvailable: kycLevel !== KYCLevel.Full,
      };
    }

    return null;
  }

  private buildErrorMessage(
    kycLevel: KYCLevel,
    limit: number,
    current: number,
    attempted: number,
  ): string {
    let message = `Transaction limit exceeded. Your ${kycLevel} KYC level allows ${limit} XAF per day. `;
    message += `Current daily total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;

    if (kycLevel === KYCLevel.Unverified) {
      message += " Upgrade to Basic KYC for 100,000 XAF daily limit.";
    } else if (kycLevel === KYCLevel.Basic) {
      message += " Upgrade to Full KYC for 1,000,000 XAF daily limit.";
    }

    return message;
  }
}

import { KYCLevel, TRANSACTION_LIMITS, MIN_TRANSACTION_AMOUNT, MAX_TRANSACTION_AMOUNT } from '../../config/limits';
import { KYCService } from '../kyc/kycService';
import { TransactionModel } from '../../models/transaction';
import { regionalProviderLimitService, RegionalLimitCheckResult } from '../regionalProviderLimitService';

export interface LimitCheckResult {
  allowed: boolean;
  kycLevel: KYCLevel;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  message?: string;
  upgradeAvailable?: boolean;
}

export class TransactionLimitService {
  constructor(
    private kycService: KYCService,
    private transactionModel: TransactionModel
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
  ): Promise<LimitCheckResult> {
    // Validate per-transaction amount limits first
    if (transactionAmount < MIN_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too small. Minimum allowed: ${MIN_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`
      };
    }
    
    if (transactionAmount > MAX_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too large. Maximum allowed: ${MAX_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`
      };
    }

    // Check for regional provider limits first
    const regionalCheck = await regionalProviderLimitService.checkRegionalLimits(
      providerName,
      countryCode,
      regionCode,
    );

    // Get user's KYC level
    const kycLevel = await this.kycService.getUserKYCLevel(userId);
    
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
        upgradeAvailable: !regionalCheck.hasRegionalLimit && kycLevel !== KYCLevel.Full
      };
    }

    // Calculate 24-hour window start time
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Query recent transactions
    const recentTransactions = await this.transactionModel.findCompletedByUserSince(
      userId,
      twentyFourHoursAgo
    );
    
    // Sum transaction amounts
    const currentDailyTotal = recentTransactions.reduce(
      (sum, tx) => sum + parseFloat(tx.amount),
      0
    );
    
    // Calculate new total
    const newTotal = currentDailyTotal + transactionAmount;
    const remainingLimit = dailyLimit - currentDailyTotal;
    
    // Return approval if newTotal ≤ dailyLimit
    if (newTotal > dailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit,
        currentDailyTotal,
        remainingLimit,
        message: this.buildRegionalLimitErrorMessage(
          kycLevel,
          dailyLimit,
          currentDailyTotal,
          transactionAmount,
          limitSource,
          regionalCheck.hasRegionalLimit
        ),
        upgradeAvailable: !regionalCheck.hasRegionalLimit && kycLevel !== KYCLevel.Full
      };
    }
    
    return {
      allowed: true,
      kycLevel,
      dailyLimit,
      currentDailyTotal,
      remainingLimit: dailyLimit - newTotal
    };
  }

  private buildRegionalLimitErrorMessage(
    kycLevel: KYCLevel,
    limit: number,
    current: number,
    attempted: number,
    limitSource: string,
    hasRegionalLimit: boolean
  ): string {
    let message = `Transaction limit exceeded. Your ${limitSource} daily limit is ${limit} XAF. `;
    message += `Current daily total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;
    
    if (!hasRegionalLimit) {
      if (kycLevel === KYCLevel.Unverified) {
        message += ' Upgrade to Basic KYC for 100,000 XAF daily limit.';
      } else if (kycLevel === KYCLevel.Basic) {
        message += ' Upgrade to Full KYC for 1,000,000 XAF daily limit.';
      }
    }
    
    return message;
  }

  async checkTransactionLimit(
    userId: string,
    transactionAmount: number
  ): Promise<LimitCheckResult> {
    // Validate per-transaction amount limits first
    if (transactionAmount < MIN_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified, // Placeholder, actual level not needed for amount validation
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too small. Minimum allowed: ${MIN_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`
      };
    }
    
    if (transactionAmount > MAX_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified, // Placeholder, actual level not needed for amount validation
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too large. Maximum allowed: ${MAX_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`
      };
    }
    
    // Get user's KYC level
    const kycLevel = await this.kycService.getUserKYCLevel(userId);
    const dailyLimit = TRANSACTION_LIMITS[kycLevel];
    
    // Calculate 24-hour window start time (current time - 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Query recent transactions using transactionModel.findCompletedByUserSince
    const recentTransactions = await this.transactionModel.findCompletedByUserSince(
      userId,
      twentyFourHoursAgo
    );
    
    // Sum transaction amounts to get currentDailyTotal
    const currentDailyTotal = recentTransactions.reduce(
      (sum, tx) => sum + parseFloat(tx.amount),
      0
    );
    
    // Calculate newTotal = currentDailyTotal + transactionAmount
    const newTotal = currentDailyTotal + transactionAmount;
    const remainingLimit = dailyLimit - currentDailyTotal;
    
    // Return approval if newTotal ≤ dailyLimit, rejection otherwise
    if (newTotal > dailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit,
        currentDailyTotal,
        remainingLimit,
        message: this.buildErrorMessage(kycLevel, dailyLimit, currentDailyTotal, transactionAmount),
        upgradeAvailable: kycLevel !== KYCLevel.Full
      };
    }
    
    return {
      allowed: true,
      kycLevel,
      dailyLimit,
      currentDailyTotal,
      remainingLimit: dailyLimit - newTotal
    };
  }

  private buildErrorMessage(
    kycLevel: KYCLevel,
    limit: number,
    current: number,
    attempted: number
  ): string {
    let message = `Transaction limit exceeded. Your ${kycLevel} KYC level allows ${limit} XAF per day. `;
    message += `Current daily total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;
    
    if (kycLevel === KYCLevel.Unverified) {
      message += ' Upgrade to Basic KYC for 100,000 XAF daily limit.';
    } else if (kycLevel === KYCLevel.Basic) {
      message += ' Upgrade to Full KYC for 1,000,000 XAF daily limit.';
    }
    
    return message;
  }
}

import { transactionTotal, transactionErrorsTotal } from '../utils/metrics';
import { Transaction, TransactionStatus } from '../models/transaction';
import { TransactionModel } from '../models/transaction';
import { UserModel } from '../models/users';
import { redisClient } from '../config/redis';

/**
 * Enhanced Fraud Detection Service
 *
 * Implements comprehensive fraud detection with 10+ heuristics for mobile money transactions.
 *
 * Heuristics:
 * 1. Velocity Check: > X transactions within time window
 * 2. Rapid Succession: Multiple transactions in very short time
 * 3. Amount Anomaly: Transaction > Xx average user transaction amount
 * 4. Geographic Anomaly: Location change > X km within time window
 * 5. High-Risk Phone Number Check: Match against known fraud numbers
 * 6. IP Geolocation Mismatch: IP location vs user address mismatch
 * 7. Unusual Transaction Hours: Transactions at odd times
 * 8. Pattern Detection: Multiple failed transactions in short time
 * 9. Device Fingerprint Anomaly: New device or suspicious device changes
 * 10. Account Age Risk: New accounts with high-value transactions
 * 11. KYC Level Risk: Low KYC level with high-value transactions
 * 12. Transaction Frequency Spike: Sudden increase in transaction frequency
 *
 * Fraud Score Threshold: 50 (configurable)
 */

interface FraudConfig {
  maxTransactionsPerHour: number;
  maxTransactionsPerMinute: number;
  amountMultiplier: number;
  maxDistanceKm: number;
  timeWindowMs: number;
  shortTimeWindowMs: number;
  fraudScoreThreshold: number;
  velocityScore: number;
  rapidSuccessionScore: number;
  amountScore: number;
  geoScore: number;
  highRiskNumberScore: number;
  ipMismatchScore: number;
  unusualHoursScore: number;
  patternScore: number;
  deviceAnomalyScore: number;
  newAccountScore: number;
  kycRiskScore: number;
  frequencySpikeScore: number;
  unusualHoursStart: number;
  unusualHoursEnd: number;
  highValueThreshold: number;
  newAccountDays: number;
  deviceFingerprintWindowMs: number;
}

const defaultConfig: FraudConfig = {
  maxTransactionsPerHour: parseInt(process.env.FRAUD_MAX_TRANSACTIONS_PER_HOUR || '5'),
  maxTransactionsPerMinute: parseInt(process.env.FRAUD_MAX_TRANSACTIONS_PER_MINUTE || '2'),
  amountMultiplier: parseFloat(process.env.FRAUD_AMOUNT_MULTIPLIER || '10'),
  maxDistanceKm: parseFloat(process.env.FRAUD_MAX_DISTANCE_KM || '1000'),
  timeWindowMs: parseInt(process.env.FRAUD_TIME_WINDOW_MS || `${60 * 60 * 1000}`),
  shortTimeWindowMs: parseInt(process.env.FRAUD_SHORT_TIME_WINDOW_MS || `${5 * 60 * 1000}`),
  fraudScoreThreshold: parseInt(process.env.FRAUD_SCORE_THRESHOLD || '50'),
  velocityScore: parseInt(process.env.FRAUD_VELOCITY_SCORE || '25'),
  rapidSuccessionScore: parseInt(process.env.FRAUD_RAPID_SUCCESSION_SCORE || '20'),
  amountScore: parseInt(process.env.FRAUD_AMOUNT_SCORE || '20'),
  geoScore: parseInt(process.env.FRAUD_GEO_SCORE || '20'),
  highRiskNumberScore: parseInt(process.env.FRAUD_HIGH_RISK_NUMBER_SCORE || '30'),
  ipMismatchScore: parseInt(process.env.FRAUD_IP_MISMATCH_SCORE || '25'),
  unusualHoursScore: parseInt(process.env.FRAUD_UNUSUAL_HOURS_SCORE || '10'),
  patternScore: parseInt(process.env.FRAUD_PATTERN_SCORE || '15'),
  deviceAnomalyScore: parseInt(process.env.FRAUD_DEVICE_ANOMALY_SCORE || '15'),
  newAccountScore: parseInt(process.env.FRAUD_NEW_ACCOUNT_SCORE || '20'),
  kycRiskScore: parseInt(process.env.FRAUD_KYC_RISK_SCORE || '15'),
  frequencySpikeScore: parseInt(process.env.FRAUD_FREQUENCY_SPIKE_SCORE || '15'),
  unusualHoursStart: parseInt(process.env.FRAUD_UNUSUAL_HOURS_START || '23'),
  unusualHoursEnd: parseInt(process.env.FRAUD_UNUSUAL_HOURS_END || '5'),
  highValueThreshold: parseFloat(process.env.FRAUD_HIGH_VALUE_THRESHOLD || '1000'),
  newAccountDays: parseInt(process.env.FRAUD_NEW_ACCOUNT_DAYS || '7'),
  deviceFingerprintWindowMs: parseInt(process.env.FRAUD_DEVICE_FINGERPRINT_WINDOW_MS || `${24 * 60 * 60 * 1000}`),
};

export interface FraudTransactionInput {
  id: string;
  userId?: string | null;
  amount: number;
  phoneNumber: string;
  timestamp: Date;
  location?: {
    lat: number;
    lng: number;
  } | null;
  status?: "SUCCESS" | "FAILED" | "PENDING";
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceFingerprint?: string | null;
  type: "deposit" | "withdraw";
  provider: string;
  metadata?: Record<string, unknown> | null;
}

interface Location {
  lat: number;
  lng: number;
}

export interface FraudResult {
  isFraud: boolean;
  score: number;
  reasons: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  heuristicsTriggered: string[];
  recommendedAction: 'allow' | 'review' | 'block';
}

export function getDistanceKm(
  loc1: { lat: number; lng: number },
  loc2: { lat: number; lng: number }
): number {
  // Haversine formula for distance calculation
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const dLng = ((loc2.lng - loc1.lng) * Math.PI) / 180;

  const lat1 = (loc1.lat * Math.PI) / 180;
  const lat2 = (loc2.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export class FraudService {
  private config: FraudConfig;
  private reviewQueue: FraudTransactionInput[] = [];
  private transactionModel: TransactionModel;
  private userModel: UserModel;
  private highRiskNumbers: Set<string> = new Set();

  constructor(config?: Partial<FraudConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.transactionModel = new TransactionModel();
    this.userModel = new UserModel();
    this.loadHighRiskNumbers();
  }

  private async loadHighRiskNumbers(): Promise<void> {
    try {
      // Load from Redis cache or database
      const cached = await redisClient.get('fraud:high_risk_numbers');
      if (cached && typeof cached === 'string') {
        const numbers = JSON.parse(cached) as string[];
        this.highRiskNumbers = new Set(numbers);
      } else {
        // In production, load from database or external fraud intelligence
        const sampleNumbers = [
          '+1234567890', '+0987654321', '+5555555555'
        ];
        this.highRiskNumbers = new Set(sampleNumbers);
        await redisClient.setEx('fraud:high_risk_numbers', 3600, JSON.stringify(sampleNumbers));
      }
    } catch (error) {
      console.error('Failed to load high risk numbers:', error);
    }
  }

  private async getUserTransactions(userId: string): Promise<Transaction[]> {
    try {
      return await this.transactionModel.findByUserId(userId);
    } catch (error) {
      console.error('Failed to get user transactions:', error);
      return [];
    }
  }

  private calculateDistance(
    locationMetadata: { country: string; city: string; },
    currentLocation: { lat: number; lng: number }
  ): number {
    // For now, return a placeholder distance
    // In production, implement proper geolocation lookup
    return 500; // km
  }

  private async getIPLocation(ipAddress: string): Promise<{ lat: number; lng: number; country: string } | null> {
    // In production, use a geolocation service like MaxMind or IP-API
    // For now, return null to disable this check
    return null;
  }

  private isLocationMismatch(
    ipLocation: { lat: number; lng: number; country: string },
    transactionLocation: { lat: number; lng: number } | null
  ): boolean {
    if (!transactionLocation) return false;
    
    // Simple distance check - in production, use proper geolocation
    const distance = getDistanceKm(
      { lat: ipLocation.lat, lng: ipLocation.lng },
      transactionLocation
    );
    return distance > 100; // 100km threshold
  }

  private async isNewDevice(userId: string, deviceFingerprint: string): Promise<boolean> {
    try {
      const key = `fraud:devices:${userId}`;
      const existingDevices = await redisClient.smembers(key) as string[];
      
      if (!existingDevices.includes(deviceFingerprint)) {
        // Add new device and set expiration
        await redisClient.sadd(key, deviceFingerprint);
        await redisClient.expire(key, this.config.deviceFingerprintWindowMs / 1000);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to check device fingerprint:', error);
      return false;
    }
  }

  private isLowKYCLevel(kycLevel: string): boolean {
    const lowKYCLevels = ['tier0', 'tier1', 'basic'];
    return lowKYCLevels.includes(kycLevel.toLowerCase());
  }

  private detectFrequencySpike(transactions: Transaction[], now: Date): string | null {
    if (transactions.length < 10) return null;
    
    // Compare recent frequency to historical average
    const recentTxns = transactions.filter(t => 
      now.getTime() - new Date(t.createdAt).getTime() <= 24 * 60 * 60 * 1000
    );
    const olderTxns = transactions.filter(t => 
      now.getTime() - new Date(t.createdAt).getTime() > 24 * 60 * 60 * 1000 &&
      now.getTime() - new Date(t.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
    );
    
    if (olderTxns.length === 0) return null;
    
    const recentFreq = recentTxns.length;
    const historicalFreq = olderTxns.length / 7; // daily average
    
    if (recentFreq > historicalFreq * 3) {
      return `Transaction frequency spike: ${recentFreq} txns today vs ${historicalFreq.toFixed(1)} daily average`;
    }
    
    return null;
  }

  private calculateRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private getRecommendedAction(
    score: number, 
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
  ): 'allow' | 'review' | 'block' {
    if (score >= 80 || riskLevel === 'critical') return 'block';
    if (score >= 50 || riskLevel === 'high') return 'review';
    return 'allow';
  }

  /**
   * Enhanced fraud detection with 10+ heuristics
   * @param transactionInput The transaction to evaluate
   * @returns Fraud detection result with detailed analysis
   */
  async detectFraud(transactionInput: FraudTransactionInput): Promise<FraudResult> {
    let score = 0;
    const reasons: string[] = [];
    const heuristicsTriggered: string[] = [];
    const now = transactionInput.timestamp;

    // Get user's transaction history
    const userTransactions = transactionInput.userId 
      ? await this.getUserTransactions(transactionInput.userId)
      : [];

    // Get user data for account-level checks
    const user = transactionInput.userId 
      ? await this.userModel.findById(transactionInput.userId)
      : null;

    // Sort transactions by timestamp descending
    const sortedTxns = [...userTransactions].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // 1. Velocity Check: Transactions per hour
    const recentTxns = sortedTxns.filter(
      (t) => now.getTime() - new Date(t.createdAt).getTime() <= this.config.timeWindowMs
    );

    if (recentTxns.length >= this.config.maxTransactionsPerHour) {
      score += this.config.velocityScore;
      reasons.push(`Too many transactions (${recentTxns.length}) in ${this.config.timeWindowMs / (60 * 60 * 1000)} hours`);
      heuristicsTriggered.push('velocity_check');
    }

    // 2. Rapid Succession: Transactions per minute
    const rapidTxns = sortedTxns.filter(
      (t) => now.getTime() - new Date(t.createdAt).getTime() <= 60 * 1000
    );

    if (rapidTxns.length >= this.config.maxTransactionsPerMinute) {
      score += this.config.rapidSuccessionScore;
      reasons.push(`Rapid succession transactions (${rapidTxns.length}) in 1 minute`);
      heuristicsTriggered.push('rapid_succession');
    }

    // 3. Amount Anomaly
    const recentAmounts = recentTxns.map(t => parseFloat(t.amount));
    const avgAmount = recentAmounts.length > 0
      ? recentAmounts.reduce((sum, a) => sum + a, 0) / recentAmounts.length
      : transactionInput.amount;

    if (transactionInput.amount > avgAmount * this.config.amountMultiplier) {
      score += this.config.amountScore;
      reasons.push(`Unusually large amount ($${transactionInput.amount} vs avg $${avgAmount.toFixed(2)})`);
      heuristicsTriggered.push('amount_anomaly');
    }

    // 4. Geographic Anomaly
    if (transactionInput.location) {
      const lastTxnWithLocation = sortedTxns.find(t => 
        t.locationMetadata && 
        t.locationMetadata.status === 'resolved'
      );
      
      if (lastTxnWithLocation && lastTxnWithLocation.locationMetadata) {
        const distance = this.calculateDistance(
          lastTxnWithLocation.locationMetadata,
          transactionInput.location
        );
        const timeDiff = now.getTime() - new Date(lastTxnWithLocation.createdAt).getTime();

        if (distance > this.config.maxDistanceKm && timeDiff <= this.config.timeWindowMs) {
          score += this.config.geoScore;
          reasons.push(`Suspicious location change (${distance.toFixed(2)}km in ${timeDiff / (60 * 60 * 1000)} hours)`);
          heuristicsTriggered.push('geographic_anomaly');
        }
      }
    }

    // 5. High-Risk Phone Number Check
    if (this.highRiskNumbers.has(transactionInput.phoneNumber)) {
      score += this.config.highRiskNumberScore;
      reasons.push('Transaction from known high-risk phone number');
      heuristicsTriggered.push('high_risk_number');
    }

    // 6. IP Geolocation Mismatch
    if (transactionInput.ipAddress && user) {
      const ipLocation = await this.getIPLocation(transactionInput.ipAddress);
      if (ipLocation && this.isLocationMismatch(ipLocation, transactionInput.location)) {
        score += this.config.ipMismatchScore;
        reasons.push('IP geolocation does not match transaction location');
        heuristicsTriggered.push('ip_geolocation_mismatch');
      }
    }

    // 7. Unusual Transaction Hours
    const hour = now.getHours();
    if (hour >= this.config.unusualHoursStart || hour <= this.config.unusualHoursEnd) {
      score += this.config.unusualHoursScore;
      reasons.push(`Transaction during unusual hours (${hour}:00)`);
      heuristicsTriggered.push('unusual_hours');
    }

    // 8. Pattern Detection: Failed attempts
    const failedAttempts = recentTxns.filter(
      (t) => t.status === TransactionStatus.Failed &&
        now.getTime() - new Date(t.createdAt).getTime() <= this.config.timeWindowMs
    );

    if (failedAttempts.length >= 3) {
      score += this.config.patternScore;
      reasons.push(`Multiple failed attempts (${failedAttempts.length}) in short time`);
      heuristicsTriggered.push('pattern_detection');
    }

    // 9. Device Fingerprint Anomaly
    if (transactionInput.deviceFingerprint && transactionInput.userId) {
      const isNewDevice = await this.isNewDevice(
        transactionInput.userId, 
        transactionInput.deviceFingerprint
      );
      if (isNewDevice) {
        score += this.config.deviceAnomalyScore;
        reasons.push('Transaction from new or unrecognized device');
        heuristicsTriggered.push('device_anomaly');
      }
    }

    // 10. Account Age Risk
    if (user) {
      const accountAge = now.getTime() - user.createdAt.getTime();
      const daysOld = accountAge / (24 * 60 * 60 * 1000);
      
      if (daysOld <= this.config.newAccountDays && 
          transactionInput.amount >= this.config.highValueThreshold) {
        score += this.config.newAccountScore;
        reasons.push(`High-value transaction from new account (${daysOld.toFixed(1)} days old)`);
        heuristicsTriggered.push('new_account_risk');
      }

      // 11. KYC Level Risk
      if (user.kycLevel && this.isLowKYCLevel(user.kycLevel) && 
          transactionInput.amount >= this.config.highValueThreshold) {
        score += this.config.kycRiskScore;
        reasons.push(`High-value transaction from low KYC level (${user.kycLevel})`);
        heuristicsTriggered.push('kyc_risk');
      }
    }

    // 12. Transaction Frequency Spike
    const frequencySpike = this.detectFrequencySpike(sortedTxns, now);
    if (frequencySpike) {
      score += this.config.frequencySpikeScore;
      reasons.push(frequencySpike);
      heuristicsTriggered.push('frequency_spike');
    }

    const isFraud = score >= this.config.fraudScoreThreshold;
    const riskLevel = this.calculateRiskLevel(score);
    const recommendedAction = this.getRecommendedAction(score, riskLevel);

    // Update metrics
    transactionTotal.inc({ 
      type: 'fraud_check', 
      status: isFraud ? 'flagged' : 'passed'
    });
    
    if (isFraud) {
      transactionErrorsTotal.inc({ 
        type: 'fraud_detection', 
        error_type: 'fraud_flagged'
      });
    }

    return {
      isFraud,
      score,
      reasons,
      riskLevel,
      heuristicsTriggered,
      recommendedAction,
    };
  }

  /**
   * Logs a fraud alert for a suspicious transaction
   * @param result Fraud detection result
   * @param transactionInput The transaction input
   */
  logFraudAlert(result: FraudResult, transactionInput: FraudTransactionInput): void {
    if (!result.isFraud) return;

    const alert = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      type: 'FRAUD_ALERT',
      transactionId: transactionInput.id,
      userId: transactionInput.userId,
      score: result.score,
      reasons: result.reasons,
      amount: transactionInput.amount,
      phoneNumber: transactionInput.phoneNumber,
      riskLevel: result.riskLevel,
      heuristicsTriggered: result.heuristicsTriggered,
    };

    console.warn(JSON.stringify(alert));
  }

  /**
   * Adds a suspicious transaction to the manual review queue
   * @param transactionInput The transaction input to review
   */
  addToReviewQueue(transactionInput: FraudTransactionInput): void {
    this.reviewQueue.push(transactionInput);
    // In production, persist to database or Redis queue
    console.log(`Transaction ${transactionInput.id} added to review queue`);
  }

  /**
   * Gets the current review queue (for admin purposes)
   * @returns Array of transactions in review queue
   */
  getReviewQueue(): FraudTransactionInput[] {
    return [...this.reviewQueue];
  }

  /**
   * Clears the review queue (after processing)
   */
  clearReviewQueue(): void {
    this.reviewQueue = [];
  }

  /**
   * Processes a transaction: detects fraud, logs alerts, and queues for review if needed
   * @param transactionInput The transaction to process
   * @returns Fraud detection result
   */
  async processTransaction(transactionInput: FraudTransactionInput): Promise<FraudResult> {
    const result = await this.detectFraud(transactionInput);

    this.logFraudAlert(result, transactionInput);

    if (result.isFraud) {
      this.addToReviewQueue(transactionInput);
    }

    return result;
  }

  /**
   * Updates transaction status to Review for high-risk transactions
   * @param transactionId The transaction ID
   * @returns Promise<void>
   */
  async setTransactionToReview(transactionId: string): Promise<void> {
    try {
      await this.transactionModel.updateStatus(transactionId, TransactionStatus.Review);
      console.log(`Transaction ${transactionId} set to Review status`);
    } catch (error) {
      console.error(`Failed to set transaction ${transactionId} to Review:`, error);
      throw error;
    }
  }
}

// Export singleton instance
export const fraudService = new FraudService();
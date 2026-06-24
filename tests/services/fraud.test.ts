import * as metrics from '../../src/utils/metrics';
import { FraudService, FraudTransactionInput, FraudResult } from '../../src/services/fraud';
import { TransactionModel } from '../../src/models/transaction';
import { UserModel } from '../../src/models/users';
import { redisClient } from '../../src/config/redis';

// Mock the database models and redis
jest.mock('../../src/models/transaction');
jest.mock('../../src/models/users');

describe('FraudService', () => {
  let fraudService: FraudService;
  let lowThresholdService: FraudService;
  let transactionTotalSpy: jest.SpyInstance;
  let transactionErrorsTotalSpy: jest.SpyInstance;
  const baseNow = new Date('2026-03-28T10:00:00.000Z');

  const baseInput: FraudTransactionInput = {
    id: 'txn-1',
    userId: 'user-1',
    amount: 100,
    phoneNumber: '+2348012345678',
    timestamp: baseNow,
    location: { lat: 0, lng: 0 },
    status: 'SUCCESS',
    type: 'deposit',
    provider: 'mtn',
  };

  beforeEach(() => {
    // Mock TransactionModel.findByUserId to return empty by default
    (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue([]);
    // Mock UserModel.findById to return null by default
    (UserModel.prototype.findById as jest.Mock).mockResolvedValue(null);
    // Mock redisClient.get to return null (no cached high risk numbers)
    jest.spyOn(redisClient, 'get').mockResolvedValue(null);
    jest.spyOn(redisClient, 'setEx').mockResolvedValue('OK');

    fraudService = new FraudService();
    lowThresholdService = new FraudService({ fraudScoreThreshold: 20 });
    transactionTotalSpy = jest.spyOn(metrics.transactionTotal, 'inc').mockImplementation(() => metrics.transactionTotal);
    transactionErrorsTotalSpy = jest.spyOn(metrics.transactionErrorsTotal, 'inc').mockImplementation(() => metrics.transactionErrorsTotal);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('detectFraud', () => {
    it('should not flag normal transaction', async () => {
      const dbTransactions = [
        { id: 'txn-0', userId: 'user-1', amount: '100', createdAt: new Date(baseNow.getTime() - 2 * 60 * 60 * 1000), status: 'completed' },
      ];
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue(dbTransactions);

      const result = await fraudService.detectFraud(baseInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toHaveLength(0);
      expect(transactionTotalSpy).toHaveBeenCalledWith({ type: 'fraud_check', status: 'passed' });
      expect(transactionErrorsTotalSpy).not.toHaveBeenCalled();
    });

    it('should flag velocity anomaly', async () => {
      const dbTransactions = Array.from({ length: 6 }, (_, i) => ({
        id: `txn-${i}`,
        userId: 'user-1',
        amount: '100',
        createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        status: 'completed',
      }));
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue(dbTransactions);

      const result = await lowThresholdService.detectFraud(baseInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(25);
      expect(result.reasons.some(r => /Too many transactions/.test(r))).toBe(true);
      expect(transactionTotalSpy).toHaveBeenCalledWith({ type: 'fraud_check', status: 'flagged' });
      expect(transactionErrorsTotalSpy).toHaveBeenCalledWith({ type: 'fraud_detection', error_type: 'fraud_flagged' });
    });

    it('should flag amount anomaly', async () => {
      const dbTransactions = [
        { id: 'txn-0', userId: 'user-1', amount: '10', createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000), status: 'completed' },
      ];
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue(dbTransactions);

      const largeInput = { ...baseInput, amount: 200 }; // 20x average
      const result = await lowThresholdService.detectFraud(largeInput);

      expect(result.isFraud).toBe(true);
      expect(result.reasons.some(r => /Unusually large amount/.test(r))).toBe(true);
    });

    it('should handle empty transaction history', async () => {
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue([]);

      const result = await fraudService.detectFraud(baseInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it('should flag failed attempts pattern', async () => {
      const lowScoreService = new FraudService({ fraudScoreThreshold: 10 });
      const dbTransactions = Array.from({ length: 3 }, (_, i) => ({
        id: `txn-${i}`,
        userId: 'user-1',
        amount: '100',
        createdAt: new Date(baseNow.getTime() - i * 10 * 60 * 1000),
        status: 'failed',
      }));
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue(dbTransactions);

      const result = await lowScoreService.detectFraud(baseInput);

      expect(result.isFraud).toBe(true);
      expect(result.reasons.some(r => /Multiple failed attempts/.test(r))).toBe(true);
    });

    it('should handle no userId', async () => {
      (TransactionModel.prototype.findByUserId as jest.Mock).mockClear();
      const noUserInput = { ...baseInput, userId: null };

      const result = await fraudService.detectFraud(noUserInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(TransactionModel.prototype.findByUserId).not.toHaveBeenCalled();
    });
  });

  describe('logFraudAlert', () => {
    it('logs only flagged transactions', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const nonFraudResult: FraudResult = {
        isFraud: false,
        score: 0,
        reasons: [],
        riskLevel: 'low',
        heuristicsTriggered: [],
        recommendedAction: 'allow',
      };

      fraudService.logFraudAlert(nonFraudResult, baseInput);
      expect(warnSpy).not.toHaveBeenCalled();

      const fraudResult: FraudResult = {
        isFraud: true,
        score: 55,
        reasons: ['test reason'],
        riskLevel: 'high',
        heuristicsTriggered: ['velocity_check'],
        recommendedAction: 'review',
      };

      fraudService.logFraudAlert(fraudResult, baseInput);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warnSpy.mock.calls[0][0])).toMatchObject({
        level: 'WARN',
        type: 'FRAUD_ALERT',
        transactionId: 'txn-1',
        userId: 'user-1',
        score: 55,
        reasons: ['test reason'],
      });
    });
  });

  describe('processTransaction', () => {
    it('should process and queue fraudulent transaction', async () => {
      const dbTransactions = Array.from({ length: 6 }, (_, i) => ({
        id: `txn-${i}`,
        userId: 'user-1',
        amount: '1000',
        createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        status: 'completed',
      }));
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue(dbTransactions);

      const result = await lowThresholdService.processTransaction(baseInput);

      expect(result.isFraud).toBe(true);
      expect(lowThresholdService.getReviewQueue()).toHaveLength(1);
    });

    it('should not queue non-fraudulent transactions', async () => {
      (TransactionModel.prototype.findByUserId as jest.Mock).mockResolvedValue([]);

      const result = await fraudService.processTransaction(baseInput);

      expect(result.isFraud).toBe(false);
      expect(fraudService.getReviewQueue()).toEqual([]);
    });
  });

  describe('review queue', () => {
    it('should manage review queue', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      fraudService.addToReviewQueue(baseInput);
      expect(fraudService.getReviewQueue()).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith('Transaction txn-1 added to review queue');

      fraudService.clearReviewQueue();
      expect(fraudService.getReviewQueue()).toHaveLength(0);
    });
  });
});

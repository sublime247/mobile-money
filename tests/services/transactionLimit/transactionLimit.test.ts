import { TransactionLimitService } from '../../../src/services/transactionLimit/transactionLimitService';
import { KYCService } from '../../../src/services/kyc/kycService';
import { TransactionModel, TransactionStatus } from '../../../src/models/transaction';
import { KYCLevel } from '../../../src/config/limits';

// Mock dependencies
jest.mock('../../../src/services/kyc/kycService');
jest.mock('../../../src/models/transaction');

describe('TransactionLimitService', () => {
  let service: TransactionLimitService;
  let mockKycService: jest.Mocked<KYCService>;
  let mockTransactionModel: jest.Mocked<TransactionModel>;

  beforeEach(() => {
    mockKycService = new KYCService() as jest.Mocked<KYCService>;
    mockTransactionModel = new TransactionModel() as jest.Mocked<TransactionModel>;
    service = new TransactionLimitService(mockKycService, mockTransactionModel);
  });

  describe('checkTransactionLimit', () => {
    it('should reject transaction below minimum amount', async () => {
      const userId = 'user-123';
      const transactionAmount = 50; // Below MIN_TRANSACTION_AMOUNT (100)

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Transaction amount too small');
      expect(result.message).toContain('Minimum allowed: 100 XAF');
      expect(result.message).toContain('Attempted: 50 XAF');
      // Should not call KYC service since amount validation happens first
      expect(mockKycService.getUserKYCLevel).not.toHaveBeenCalled();
    });

    it('should reject transaction above maximum amount', async () => {
      const userId = 'user-123';
      const transactionAmount = 2000000; // Above MAX_TRANSACTION_AMOUNT (1000000)

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Transaction amount too large');
      expect(result.message).toContain('Maximum allowed: 1000000 XAF');
      expect(result.message).toContain('Attempted: 2000000 XAF');
      // Should not call KYC service since amount validation happens first
      expect(mockKycService.getUserKYCLevel).not.toHaveBeenCalled();
    });

    it('should proceed to KYC check when amount is within min/max range', async () => {
      const userId = 'user-123';
      const transactionAmount = 5000; // Within range

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      await service.checkTransactionLimit(userId, transactionAmount);

      // Should call KYC service since amount validation passed
      expect(mockKycService.getUserKYCLevel).toHaveBeenCalledWith(userId);
    });

    it('should allow transaction at exactly minimum amount', async () => {
      const userId = 'user-123';
      const transactionAmount = 100; // Exactly MIN_TRANSACTION_AMOUNT

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(true);
      expect(mockKycService.getUserKYCLevel).toHaveBeenCalled();
    });

    it('should allow transaction at exactly maximum amount', async () => {
      const userId = 'user-123';
      const transactionAmount = 1000000; // Exactly MAX_TRANSACTION_AMOUNT

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Full);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(true);
      expect(mockKycService.getUserKYCLevel).toHaveBeenCalled();
    });

    it('should allow transaction when within limit', async () => {
      const userId = 'user-123';
      const transactionAmount = 5000;

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([
        { amount: '3000', status: TransactionStatus.Completed } as any
      ]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(true);
      expect(result.kycLevel).toBe(KYCLevel.Unverified);
      expect(result.dailyLimit).toBe(10000);
      expect(result.currentDailyTotal).toBe(3000);
      expect(result.remainingLimit).toBe(2000);
    });

    it('should reject transaction when exceeding limit', async () => {
      const userId = 'user-123';
      const transactionAmount = 8000;

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([
        { amount: '5000', status: TransactionStatus.Completed } as any
      ]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.kycLevel).toBe(KYCLevel.Unverified);
      expect(result.dailyLimit).toBe(10000);
      expect(result.currentDailyTotal).toBe(5000);
      expect(result.remainingLimit).toBe(5000);
      expect(result.message).toContain('Transaction limit exceeded');
      expect(result.upgradeAvailable).toBe(true);
    });

    it('should calculate daily total from multiple transactions', async () => {
      const userId = 'user-123';
      const transactionAmount = 2000;

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Basic);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([
        { amount: '30000', status: TransactionStatus.Completed } as any,
        { amount: '20000', status: TransactionStatus.Completed } as any,
        { amount: '15000', status: TransactionStatus.Completed } as any
      ]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(true);
      expect(result.currentDailyTotal).toBe(65000);
      expect(result.remainingLimit).toBe(33000);
    });

    it('should include upgrade suggestion for Unverified users', async () => {
      const userId = 'user-123';
      const transactionAmount = 15000;

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Upgrade to Basic KYC for 100,000 XAF daily limit');
      expect(result.upgradeAvailable).toBe(true);
    });

    it('should include upgrade suggestion for Basic users', async () => {
      const userId = 'user-123';
      const transactionAmount = 150000;

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Basic);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Upgrade to Full KYC for 1,000,000 XAF daily limit');
      expect(result.upgradeAvailable).toBe(true);
    });

    it('should not include upgrade suggestion for Full KYC users', async () => {
      const userId = 'user-123';
      const transactionAmount = 500000; // Within amount limits but will exceed Full KYC daily limit

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Full);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([
        { amount: '600000', status: TransactionStatus.Completed } as any
      ]);

      const result = await service.checkTransactionLimit(userId, transactionAmount);

      expect(result.allowed).toBe(false);
      expect(result.message).not.toContain('Upgrade');
      expect(result.upgradeAvailable).toBe(false);
    });

    it('should query transactions from 24-hour window', async () => {
      const userId = 'user-123';
      const transactionAmount = 1000;
      const now = Date.now();

      mockKycService.getUserKYCLevel.mockResolvedValue(KYCLevel.Unverified);
      mockTransactionModel.findCompletedByUserSince.mockResolvedValue([]);

      await service.checkTransactionLimit(userId, transactionAmount);

      expect(mockTransactionModel.findCompletedByUserSince).toHaveBeenCalledWith(
        userId,
        expect.any(Date)
      );

      const callDate = mockTransactionModel.findCompletedByUserSince.mock.calls[0][1] as Date;
      const expectedTime = now - 24 * 60 * 60 * 1000;
      expect(callDate.getTime()).toBeGreaterThanOrEqual(expectedTime - 100);
      expect(callDate.getTime()).toBeLessThanOrEqual(expectedTime + 100);
    });
  });
});

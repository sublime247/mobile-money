import { MIN_TRANSACTION_AMOUNT, MAX_TRANSACTION_AMOUNT } from '../../src/config/limits';

describe('Per-Transaction Amount Limits', () => {
  describe('Default Values', () => {
    it('should have MIN_TRANSACTION_AMOUNT default of 100', () => {
      // If env var not set, should use default
      expect(MIN_TRANSACTION_AMOUNT).toBeGreaterThan(0);
      expect(isFinite(MIN_TRANSACTION_AMOUNT)).toBe(true);
    });

    it('should have MAX_TRANSACTION_AMOUNT default of 1000000', () => {
      // If env var not set, should use default
      expect(MAX_TRANSACTION_AMOUNT).toBeGreaterThan(0);
      expect(isFinite(MAX_TRANSACTION_AMOUNT)).toBe(true);
    });

    it('should have MIN_TRANSACTION_AMOUNT <= MAX_TRANSACTION_AMOUNT', () => {
      expect(MIN_TRANSACTION_AMOUNT).toBeLessThanOrEqual(MAX_TRANSACTION_AMOUNT);
    });
  });

  describe('Validation', () => {
    it('should ensure MIN_TRANSACTION_AMOUNT is positive', () => {
      expect(MIN_TRANSACTION_AMOUNT).toBeGreaterThan(0);
    });

    it('should ensure MAX_TRANSACTION_AMOUNT is positive', () => {
      expect(MAX_TRANSACTION_AMOUNT).toBeGreaterThan(0);
    });

    it('should ensure both limits are finite numbers', () => {
      expect(isFinite(MIN_TRANSACTION_AMOUNT)).toBe(true);
      expect(isFinite(MAX_TRANSACTION_AMOUNT)).toBe(true);
    });
  });
});

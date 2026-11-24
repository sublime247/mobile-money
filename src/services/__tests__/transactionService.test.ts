import { TransactionService, MIN_WITHDRAWAL_AMOUNT } from "../transactionService";

describe("TransactionService Unit Tests", () => {
  let mockTxModel: any;
  let service: TransactionService;

  beforeEach(() => {
    mockTxModel = {
      findByUserId: jest.fn(),
      createTransaction: jest.fn(),
    };
    service = new TransactionService(mockTxModel);
  });

  describe("findByUserId", () => {
    it("should delegate to transaction model and return results", async () => {
      const mockResult = [{ id: "tx_123", userId: "user_1" }];
      mockTxModel.findByUserId.mockResolvedValue(mockResult);

      const res = await service.findByUserId("user_1");

      expect(mockTxModel.findByUserId).toHaveBeenCalledWith("user_1");
      expect(res).toBe(mockResult);
    });
  });

  describe("withdraw", () => {
    it("should throw 'Amount too small' when amount is less than 1 (0.99)", async () => {
      await expect(
        service.withdraw({
          userId: "user_1",
          amount: 0.99,
          currency: "USD",
        })
      ).rejects.toThrow("Amount too small");
    });

    it("should throw 'Amount too small' when amount is 0", async () => {
      await expect(
        service.withdraw({
          userId: "user_1",
          amount: 0,
          currency: "USD",
        })
      ).rejects.toThrow("Amount too small");
    });

    it("should throw 'Amount too small' when amount is negative (-5)", async () => {
      await expect(
        service.withdraw({
          userId: "user_1",
          amount: -5,
          currency: "USD",
        })
      ).rejects.toThrow("Amount too small");
    });

    it("should allow withdrawal when amount is exactly 1 (boundary condition)", async () => {
      const result = await service.withdraw({
        userId: "user_1",
        amount: 1,
        currency: "USD",
      });
      expect(result).toBeUndefined();
    });

    it("should allow withdrawal when amount is greater than 1 (e.g., 100)", async () => {
      const result = await service.withdraw({
        userId: "user_1",
        amount: 100,
        currency: "USD",
      });
      expect(result).toBeUndefined();
    });
  });

  describe("MIN_WITHDRAWAL_AMOUNT constant", () => {
    it("should equal 1", () => {
      expect(MIN_WITHDRAWAL_AMOUNT).toBe(1);
    });
  });
});

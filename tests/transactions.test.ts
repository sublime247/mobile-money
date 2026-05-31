import request from "supertest";

const mockList = jest.fn();
const mockCount = jest.fn();

jest.mock("../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    list: mockList,
    count: mockCount,
    findById: jest.fn(),
    updateStatus: jest.fn(),
    updateNotes: jest.fn(),
    updateAdminNotes: jest.fn(),
    searchByPhoneNumber: jest.fn(),
    countByStatuses: jest.fn(),
    findByStatuses: jest.fn(),
    releaseExpiredIdempotencyKey: jest.fn(),
    findActiveByIdempotencyKey: jest.fn(),
    create: jest.fn(),
  })),
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled",
  },
}));

import app from "../src/index";

describe("Transaction History Integration Tests", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockCount.mockReset();
    mockList.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
  });

  it("should return 400 for invalid date formats", async () => {
    const res = await request(app).get(
      "/api/transactions?startDate=01-01-2026",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid date format");
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("should return 400 if startDate is after endDate", async () => {
    const res = await request(app).get(
      "/api/transactions?startDate=2026-03-31&endDate=2026-03-01",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("startDate cannot be greater than endDate");
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("should return 200 and paginated data for valid ranges", async () => {
    mockList.mockResolvedValue([{ id: "txn-1", amount: "100" }]);
    mockCount.mockResolvedValue(1);

    const res = await request(app).get(
      "/api/transactions?startDate=2026-03-01&endDate=2026-03-31&offset=0&limit=5",
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({
      total: 1,
      limit: 5,
      offset: 0,
      hasMore: false,
    });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockCount).toHaveBeenCalledTimes(1);
  });
});

describe("Minimum Withdrawal Threshold", () => {
  it("should reject withdrawals smaller than $1 to save on fees", async () => {
    const microTransactionAmount = 0.5; // $0.50

    // Note: Adjust the method name/payload to match your actual service signature
    await expect(
      TransactionService.withdraw({
        userId: "test-user-123",
        amount: microTransactionAmount,
        currency: "USD",
      }),
    ).rejects.toThrow("Amount too small");
  });

  it("should allow withdrawals of exactly $1 or more", async () => {
    const validAmount = 1.0;

    // Mock the successful execution if necessary, then call the service
    const result = await TransactionService.withdraw({
      userId: "test-user-123",
      amount: validAmount,
      currency: "USD",
    });

    expect(result).toBeDefined(); // Or check status === 'PENDING'/'SUCCESS'
  });
});

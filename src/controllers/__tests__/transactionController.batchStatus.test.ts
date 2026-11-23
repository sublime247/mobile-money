import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Request, Response } from "express";

const mockFindByIds = jest.fn();

jest.mock("../../models/transaction", () => {
  const actual = jest.requireActual("../../models/transaction") as any;
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => ({
      findByIds: mockFindByIds,
    })),
  };
});

import { batchStatusHandler } from "../transactionController";
import { TransactionStatus } from "../../models/transaction";

function mockRes(): Response {
  const res: Partial<Response> = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe("batchStatusHandler (#2370)", () => {
  beforeEach(() => {
    mockFindByIds.mockReset();
  });

  it("returns a status map keyed by transaction id for found transactions", async () => {
    mockFindByIds.mockResolvedValue([
      {
        id: "tx-1",
        status: TransactionStatus.Completed,
        amount: "100",
        convertedAmount: "99.50",
        currency: "USD",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "tx-2",
        status: TransactionStatus.Pending,
        amount: "50",
        convertedAmount: null,
        currency: "USD",
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const req = { body: { transaction_ids: ["tx-1", "tx-2"] } } as Request;
    const res = mockRes();

    await batchStatusHandler(req, res);

    expect(mockFindByIds).toHaveBeenCalledWith(["tx-1", "tx-2"]);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: 2,
        found: 2,
        data: expect.objectContaining({
          "tx-1": expect.objectContaining({ status: TransactionStatus.Completed }),
          "tx-2": expect.objectContaining({ status: TransactionStatus.Pending }),
        }),
      }),
    );
  });

  it("omits IDs with no matching transaction rather than failing the request", async () => {
    mockFindByIds.mockResolvedValue([
      {
        id: "tx-1",
        status: TransactionStatus.Completed,
        amount: "100",
        convertedAmount: null,
        currency: "USD",
        updatedAt: new Date(),
      },
    ]);

    const req = {
      body: { transaction_ids: ["tx-1", "does-not-exist"] },
    } as Request;
    const res = mockRes();

    await batchStatusHandler(req, res);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.requested).toBe(2);
    expect(payload.found).toBe(1);
    expect(payload.data["tx-1"]).toBeDefined();
    expect(payload.data["does-not-exist"]).toBeUndefined();
  });

  it("de-duplicates repeated IDs before querying", async () => {
    mockFindByIds.mockResolvedValue([]);

    const req = {
      body: { transaction_ids: ["tx-1", "tx-1", "tx-1"] },
    } as Request;
    const res = mockRes();

    await batchStatusHandler(req, res);

    expect(mockFindByIds).toHaveBeenCalledWith(["tx-1"]);
  });

  it("rejects an empty transaction_ids array", async () => {
    const req = { body: { transaction_ids: [] } } as Request;
    const res = mockRes();

    await expect(batchStatusHandler(req, res)).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than 50 transaction_ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `tx-${i}`);
    const req = { body: { transaction_ids: ids } } as Request;
    const res = mockRes();

    await expect(batchStatusHandler(req, res)).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 transaction_ids", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `tx-${i}`);
    mockFindByIds.mockResolvedValue([]);
    const req = { body: { transaction_ids: ids } } as Request;
    const res = mockRes();

    await batchStatusHandler(req, res);

    expect(mockFindByIds).toHaveBeenCalledWith(ids);
  });

  it("rejects a missing transaction_ids field", async () => {
    const req = { body: {} } as Request;
    const res = mockRes();

    await expect(batchStatusHandler(req, res)).rejects.toMatchObject({
      code: expect.any(String),
    });
  });
});

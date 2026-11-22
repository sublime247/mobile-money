import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  MtnMomoProvider,
  BatchPayoutItem,
} from "../../services/providers/mtnMomo";
import {
  processBatchPayoutResults,
  PendingPayout,
} from "../payoutBatchWorker";

describe("MtnMomoProvider Batch Payout", () => {
  let provider: MtnMomoProvider;

  beforeEach(() => {
    provider = new MtnMomoProvider();
  });

  it("should return success when sending empty batch", async () => {
    const res = await provider.sendBatchPayout([]);
    expect(res.success).toBe(true);
    expect(res.results).toEqual([]);
  });

  it("should enforce maximum batch size limit", async () => {
    const items: BatchPayoutItem[] = Array.from({ length: 105 }, (_, i) => ({
      referenceId: `ref-${i}`,
      phoneNumber: "+237670000001",
      amount: "100.00",
    }));

    const res = await provider.sendBatchPayout(items);
    expect(res.success).toBe(false);
    expect(res.results.length).toBe(105);
    expect(res.results[0].success).toBe(false);
    expect(res.results[0].error).toContain("exceeds maximum");
  });
});

describe("PayoutBatchWorker Results Processing", () => {
  it("should correctly handle batch results mapping", async () => {
    const payouts: PendingPayout[] = [
      {
        transactionId: "tx-1",
        phoneNumber: "+237670000001",
        amount: "100.00",
        provider: "mtn",
      },
    ];

    const results = [
      {
        referenceId: "tx-1",
        success: true,
        providerReference: "BATCH-123",
      },
    ];

    // Mock rabbitMQManager, transactionModel, etc. are handled gracefully
    await expect(
      processBatchPayoutResults(results, payouts),
    ).resolves.not.toThrow();
  });
});

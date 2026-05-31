import * as metrics from "../../src/utils/metrics";
import { FraudService, Transaction } from "../../src/services/fraud";

describe("FraudService", () => {
  let fraudService: FraudService;
  let lowThresholdService: FraudService;
  let transactionTotalSpy: jest.SpyInstance;
  let transactionErrorsTotalSpy: jest.SpyInstance;
  const baseNow = new Date("2026-03-28T10:00:00.000Z");
  const baseTransaction: Transaction = {
    id: "txn-1",
    userId: "user-1",
    amount: 100,
    timestamp: baseNow,
    location: { lat: 0, lng: 0 },
    status: "SUCCESS",
  };

  beforeEach(() => {
    fraudService = new FraudService();
    lowThresholdService = new FraudService({ fraudScoreThreshold: 20 });
    transactionTotalSpy = jest
      .spyOn(metrics.transactionTotal, "inc")
      .mockImplementation(() => metrics.transactionTotal);
    transactionErrorsTotalSpy = jest
      .spyOn(metrics.transactionErrorsTotal, "inc")
      .mockImplementation(() => metrics.transactionErrorsTotal);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("detectFraud", () => {
    it("should not flag normal transaction", () => {
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          id: "txn-0",
          timestamp: new Date(baseNow.getTime() - 2 * 60 * 60 * 1000),
        },
      ];

      const result = fraudService.detectFraud(
        baseTransaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toHaveLength(0);
      expect(transactionTotalSpy).toHaveBeenCalledWith({
        type: "fraud_check",
        status: "passed",
      });
      expect(transactionErrorsTotalSpy).not.toHaveBeenCalled();
    });

    it("should flag velocity anomaly", () => {
      const userTransactions: Transaction[] = Array.from(
        { length: 6 },
        (_, i) => ({
          ...baseTransaction,
          id: `txn-${i}`,
          timestamp: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        }),
      );

      const result = lowThresholdService.detectFraud(
        baseTransaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(30);
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toBe("Too many transactions (6) in 60 minutes");
      expect(transactionTotalSpy).toHaveBeenCalledWith({
        type: "fraud_check",
        status: "flagged",
      });
      expect(transactionErrorsTotalSpy).toHaveBeenCalledWith({
        type: "fraud_detection",
        error_type: "fraud_flagged",
      });
    });

    it("should flag amount anomaly", () => {
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 30 * 60 * 1000),
        },
      ];

      const largeTransaction = { ...baseTransaction, amount: 200 }; // 20x average

      const result = lowThresholdService.detectFraud(
        largeTransaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(30);
      expect(result.reasons.some((r) => /Unusually large amount/.test(r))).toBe(
        true,
      );
    });

    it("does not flag an amount exactly at the anomaly threshold", () => {
      const service = new FraudService({ fraudScoreThreshold: 100 });
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 30 * 60 * 1000),
        },
      ];

      const result = service.detectFraud(
        { ...baseTransaction, amount: 100 },
        userTransactions,
      );

      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it("should flag geographic anomaly", () => {
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          location: { lat: 0, lng: 0 },
          timestamp: new Date(baseNow.getTime() - 30 * 60 * 1000),
        },
      ];

      const farTransaction = {
        ...baseTransaction,
        location: { lat: 10, lng: 10 }, // ~1400km away
      };

      const result = lowThresholdService.detectFraud(
        farTransaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(25);
      expect(result.reasons[0]).toBe(
        "Suspicious location change (1568.52km in 30 minutes)",
      );
    });

    it("should flag failed attempts pattern", () => {
      const lowScoreService = new FraudService({ fraudScoreThreshold: 10 });
      const userTransactions: Transaction[] = Array.from(
        { length: 3 },
        (_, i) => ({
          ...baseTransaction,
          id: `txn-${i}`,
          status: "FAILED" as const,
          timestamp: new Date(baseNow.getTime() - i * 10 * 60 * 1000),
        }),
      );

      const result = lowScoreService.detectFraud(
        baseTransaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(15);
      expect(
        result.reasons.some((r) => /Multiple failed attempts/.test(r)),
      ).toBe(true);
    });

    it("should handle empty transaction history", () => {
      const result = fraudService.detectFraud(baseTransaction, []);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it("includes transactions exactly on the time-window boundary", () => {
      const service = new FraudService({ fraudScoreThreshold: 20 });
      const userTransactions: Transaction[] = Array.from(
        { length: 5 },
        (_, i) => ({
          ...baseTransaction,
          id: `boundary-${i}`,
          timestamp: new Date(baseNow.getTime() - 60 * 60 * 1000 + i * 1000),
        }),
      );

      const result = service.detectFraud(baseTransaction, userTransactions);

      expect(result.score).toBe(30);
      expect(result.reasons).toContain(
        "Too many transactions (5) in 60 minutes",
      );
    });

    it("ignores old transactions outside the time window", () => {
      const userTransactions: Transaction[] = Array.from(
        { length: 6 },
        (_, i) => ({
          ...baseTransaction,
          id: `old-${i}`,
          amount: 10,
          status: "FAILED" as const,
          timestamp: new Date(
            baseNow.getTime() - (2 * 60 * 60 * 1000 + i * 60 * 1000),
          ),
        }),
      );

      const result = fraudService.detectFraud(
        baseTransaction,
        userTransactions,
      );

      expect(result).toEqual({ isFraud: false, score: 0, reasons: [] });
    });

    it("uses the most recent location when evaluating geographic anomalies", () => {
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          id: "older-far",
          location: { lat: 10, lng: 10 },
          timestamp: new Date(baseNow.getTime() - 50 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "recent-near",
          location: { lat: 0.01, lng: 0.01 },
          timestamp: new Date(baseNow.getTime() - 5 * 60 * 1000),
        },
      ];

      const result = fraudService.detectFraud(
        baseTransaction,
        userTransactions,
      );

      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it("flags fraud exactly at the configured score threshold", () => {
      const thresholdService = new FraudService({ fraudScoreThreshold: 50 });
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          id: "txn-a",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 10 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-b",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 20 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-c",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 30 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-d",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 40 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-e",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 50 * 60 * 1000),
        },
      ];

      const result = thresholdService.detectFraud(
        { ...baseTransaction, amount: 200 },
        userTransactions,
      );

      expect(result.score).toBe(60);
      expect(result.isFraud).toBe(true);
    });

    it("should accumulate multiple fraud signals into a combined score", () => {
      const transaction: Transaction = {
        ...baseTransaction,
        amount: 300,
        location: { lat: 12, lng: 12 },
      };
      const userTransactions: Transaction[] = [
        {
          ...baseTransaction,
          id: "txn-0",
          amount: 10,
          status: "FAILED",
          timestamp: new Date(baseNow.getTime() - 5 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-1",
          amount: 10,
          status: "FAILED",
          timestamp: new Date(baseNow.getTime() - 10 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-2",
          amount: 10,
          status: "FAILED",
          timestamp: new Date(baseNow.getTime() - 15 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-3",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 20 * 60 * 1000),
        },
        {
          ...baseTransaction,
          id: "txn-4",
          amount: 10,
          timestamp: new Date(baseNow.getTime() - 25 * 60 * 1000),
        },
      ];

      const result = lowThresholdService.detectFraud(
        transaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(100);
      expect(result.reasons).toEqual([
        "Too many transactions (5) in 60 minutes",
        "Unusually large amount (300 vs avg 10.00)",
        "Suspicious location change (1880.09km in 5 minutes)",
        "Multiple failed attempts (3) in short time",
      ]);
    });
  });

  describe("logFraudAlert", () => {
    it("logs only flagged transactions", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const transaction: Transaction = {
        id: "txn-1",
        userId: "user-1",
        amount: 100,
        timestamp: new Date(),
        location: { lat: 0, lng: 0 },
      };

      fraudService.logFraudAlert(
        { isFraud: false, score: 0, reasons: [] },
        transaction,
      );
      expect(warnSpy).not.toHaveBeenCalled();

      fraudService.logFraudAlert(
        { isFraud: true, score: 55, reasons: ["test reason"] },
        transaction,
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warnSpy.mock.calls[0][0])).toMatchObject({
        level: "WARN",
        type: "FRAUD_ALERT",
        transactionId: "txn-1",
        userId: "user-1",
        score: 55,
        reasons: ["test reason"],
      });
    });
  });

  describe("processTransaction", () => {
    it("should process and queue fraudulent transaction", () => {
      const transaction: Transaction = {
        id: "txn-1",
        userId: "user-1",
        amount: 1000,
        timestamp: baseNow,
        location: { lat: 0, lng: 0 },
      };

      const userTransactions: Transaction[] = Array.from(
        { length: 6 },
        (_, i) => ({
          ...transaction,
          id: `txn-${i}`,
          timestamp: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        }),
      );

      const result = lowThresholdService.processTransaction(
        transaction,
        userTransactions,
      );

      expect(result.isFraud).toBe(true);
      expect(lowThresholdService.getReviewQueue()).toHaveLength(1);
    });

    it("should not queue non-fraudulent transactions", () => {
      const transaction: Transaction = {
        id: "txn-2",
        userId: "user-1",
        amount: 100,
        timestamp: baseNow,
        location: { lat: 0, lng: 0 },
      };

      const result = fraudService.processTransaction(transaction, []);

      expect(result.isFraud).toBe(false);
      expect(fraudService.getReviewQueue()).toEqual([]);
    });
  });

  describe("review queue", () => {
    it("should manage review queue", () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const transaction: Transaction = {
        id: "txn-1",
        userId: "user-1",
        amount: 100,
        timestamp: new Date(),
        location: { lat: 0, lng: 0 },
      };

      fraudService.addToReviewQueue(transaction);
      expect(fraudService.getReviewQueue()).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        "Transaction txn-1 added to review queue",
      );

      fraudService.clearReviewQueue();
      expect(fraudService.getReviewQueue()).toHaveLength(0);
    });
  });
});

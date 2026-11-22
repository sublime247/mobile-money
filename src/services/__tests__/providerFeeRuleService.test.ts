jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
  pool: { connect: jest.fn() },
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import type { FeeRuleRepository, ProviderFeeRule } from "../../models/feeRule";
import { ProviderFeeRuleService } from "../providerFeeRuleService";

function rule(overrides: Partial<ProviderFeeRule> = {}): ProviderFeeRule {
  return {
    id: "rule-mtn-xaf",
    provider: "mtn",
    currency: "XAF",
    feeType: "percent",
    fixedAmount: null,
    basisPoints: 150,
    minFee: 50,
    maxFee: 5000,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("ProviderFeeRuleService", () => {
  let clock: number;
  let repo: {
    listActive: jest.Mock;
    replaceActive: jest.Mock;
    deactivate: jest.Mock;
  };
  let service: ProviderFeeRuleService;

  beforeEach(() => {
    clock = 1_000;
    repo = {
      listActive: jest.fn().mockResolvedValue([
        rule(),
        rule({
          id: "rule-airtel-kes",
          provider: "airtel",
          currency: "KES",
          feeType: "fixed",
          fixedAmount: 25,
          basisPoints: null,
          minFee: 0,
          maxFee: null,
        }),
      ]),
      replaceActive: jest.fn(),
      deactivate: jest.fn().mockResolvedValue(true),
    };
    service = new ProviderFeeRuleService(
      repo as unknown as FeeRuleRepository,
      60_000,
      () => clock,
    );
  });

  describe("calculateFee with database-driven rules", () => {
    it("applies a percent rule with min/max clamping", async () => {
      await expect(service.calculateFee("mtn", "XAF", 10_000)).resolves.toEqual(
        { fee: 150, ruleId: "rule-mtn-xaf", feeType: "percent" },
      );
      expect((await service.calculateFee("mtn", "XAF", 100))?.fee).toBe(50);
      expect((await service.calculateFee("mtn", "XAF", 10_000_000))?.fee).toBe(
        5000,
      );
    });

    it("applies a fixed rule", async () => {
      await expect(
        service.calculateFee("airtel", "KES", 99_999),
      ).resolves.toEqual({
        fee: 25,
        ruleId: "rule-airtel-kes",
        feeType: "fixed",
      });
    });

    it("matches provider and currency case-insensitively", async () => {
      expect((await service.calculateFee(" MTN ", "xaf", 10_000))?.fee).toBe(
        150,
      );
    });

    it("returns null when no rule is configured", async () => {
      await expect(
        service.calculateFee("orange", "XOF", 1_000),
      ).resolves.toBeNull();
    });
  });

  describe("caching", () => {
    it("serves repeated lookups from memory within the TTL", async () => {
      await service.getActiveRule("mtn", "XAF");
      clock += 59_999;
      await service.getActiveRule("airtel", "KES");

      expect(repo.listActive).toHaveBeenCalledTimes(1);
    });

    it("reloads after the TTL expires", async () => {
      await service.getActiveRule("mtn", "XAF");
      clock += 60_000;
      await service.getActiveRule("mtn", "XAF");

      expect(repo.listActive).toHaveBeenCalledTimes(2);
    });

    it("shares one query across concurrent cold lookups", async () => {
      await Promise.all([
        service.getActiveRule("mtn", "XAF"),
        service.getActiveRule("airtel", "KES"),
        service.calculateFee("mtn", "XAF", 1),
      ]);

      expect(repo.listActive).toHaveBeenCalledTimes(1);
    });

    it("picks up a new rule immediately after setRule", async () => {
      expect((await service.calculateFee("mtn", "XAF", 10_000))?.fee).toBe(150);

      const updated = rule({ id: "rule-mtn-xaf-v2", basisPoints: 120 });
      repo.replaceActive.mockResolvedValueOnce(updated);
      repo.listActive.mockResolvedValueOnce([updated]);
      await service.setRule({
        provider: "mtn",
        currency: "XAF",
        feeType: "percent",
        basisPoints: 120,
        minFee: 50,
        maxFee: 5000,
      });

      await expect(service.calculateFee("mtn", "XAF", 10_000)).resolves.toEqual(
        { fee: 120, ruleId: "rule-mtn-xaf-v2", feeType: "percent" },
      );
    });

    it("drops a deactivated rule immediately", async () => {
      await service.getActiveRule("mtn", "XAF");
      repo.listActive.mockResolvedValueOnce([]);

      await service.deactivateRule("rule-mtn-xaf", "admin-1");

      await expect(service.getActiveRule("mtn", "XAF")).resolves.toBeNull();
    });

    it("does not cache a load that raced with an invalidation", async () => {
      let resolveStale!: (rules: ProviderFeeRule[]) => void;
      repo.listActive.mockReturnValueOnce(
        new Promise<ProviderFeeRule[]>((resolve) => {
          resolveStale = resolve;
        }),
      );

      const staleLookup = service.getActiveRule("mtn", "XAF");
      service.invalidate();
      resolveStale([rule({ basisPoints: 999 })]);
      await staleLookup;

      repo.listActive.mockResolvedValueOnce([rule({ basisPoints: 120 })]);
      expect((await service.getActiveRule("mtn", "XAF"))?.basisPoints).toBe(
        120,
      );
    });

    it("serves stale rules when a reload fails", async () => {
      await service.getActiveRule("mtn", "XAF");
      clock += 60_000;
      repo.listActive.mockRejectedValueOnce(new Error("db down"));

      expect((await service.calculateFee("mtn", "XAF", 10_000))?.fee).toBe(150);
    });

    it("propagates the error when there is nothing cached", async () => {
      repo.listActive.mockRejectedValueOnce(new Error("db down"));

      await expect(service.getActiveRule("mtn", "XAF")).rejects.toThrow(
        "db down",
      );
    });
  });
});

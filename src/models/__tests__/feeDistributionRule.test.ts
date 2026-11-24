const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

import { FeeDistributionRuleModel, FeeDistributionRuleRow } from "../feeDistributionRule";
import type { FeeDistributionShare } from "../../services/feeDistributionEngine";

describe("FeeDistributionRuleModel", () => {
  const model = new FeeDistributionRuleModel();

  const validShares: FeeDistributionShare[] = [
    { recipientType: "platform_treasury", percentage: 70 },
    { recipientType: "referral_program", percentage: 30 },
  ];

  const row: FeeDistributionRuleRow = {
    id: "rule-1",
    name: "Standard Split",
    description: "70/30 split",
    shares: validShares,
    is_active: true,
    created_by: "admin-1",
    updated_by: "admin-1",
    created_at: new Date("2026-08-27T00:00:00.000Z"),
    updated_at: new Date("2026-08-27T00:00:00.000Z"),
  };

  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
  });

  describe("createRule", () => {
    it("inserts a valid rule and maps it back", async () => {
      mockQueryWrite.mockResolvedValueOnce({ rows: [row] });

      const result = await model.createRule({
        name: "Standard Split",
        description: "70/30 split",
        shares: validShares,
        createdBy: "admin-1",
      });

      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_distribution_rules"),
        ["Standard Split", "70/30 split", JSON.stringify(validShares), "admin-1"],
      );
      expect(result.name).toBe("Standard Split");
      expect(result.shares).toEqual(validShares);
    });

    it("rejects a rule whose shares don't sum to 100 without hitting the database", async () => {
      await expect(
        model.createRule({
          name: "Bad Split",
          shares: [{ recipientType: "platform_treasury", percentage: 50 }],
          createdBy: "admin-1",
        }),
      ).rejects.toThrow(/Invalid fee distribution shares/);

      expect(mockQueryWrite).not.toHaveBeenCalled();
    });
  });

  describe("getActiveRuleByName", () => {
    it("returns the rule when found", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [row] });
      const result = await model.getActiveRuleByName("Standard Split");
      expect(result?.id).toBe("rule-1");
    });

    it("returns null when not found", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [] });
      const result = await model.getActiveRuleByName("Nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("listActiveRules", () => {
    it("parses JSON-string shares from the database driver", async () => {
      mockQueryRead.mockResolvedValueOnce({
        rows: [{ ...row, shares: JSON.stringify(validShares) }],
      });
      const rules = await model.listActiveRules();
      expect(rules[0].shares).toEqual(validShares);
    });
  });

  describe("updateShares", () => {
    it("rejects invalid shares without hitting the database", async () => {
      await expect(
        model.updateShares(
          "rule-1",
          [{ recipientType: "platform_treasury", percentage: 200 }],
          "admin-1",
        ),
      ).rejects.toThrow(/Invalid fee distribution shares/);

      expect(mockQueryWrite).not.toHaveBeenCalled();
    });

    it("updates valid shares", async () => {
      mockQueryWrite.mockResolvedValueOnce({});
      await model.updateShares("rule-1", validShares, "admin-1");
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE fee_distribution_rules"),
        ["rule-1", JSON.stringify(validShares), "admin-1"],
      );
    });
  });

  describe("deactivateRule", () => {
    it("sets is_active to false", async () => {
      mockQueryWrite.mockResolvedValueOnce({});
      await model.deactivateRule("rule-1", "admin-1");
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("is_active = false"),
        ["rule-1", "admin-1"],
      );
    });
  });
});

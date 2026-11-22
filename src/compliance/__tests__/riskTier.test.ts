import { pool, queryRead } from "../../config/database";
import {
  calculateRiskScore,
  evaluateCustomerRisk,
  getEffectiveDailyLimit,
} from "../riskTier";

jest.mock("../../config/database", () => ({
  pool: { connect: jest.fn() },
  queryRead: jest.fn(),
}));

describe("customer PEP risk tier recalculation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("assigns high risk to a confirmed PEP match", () => {
    const score = calculateRiskScore({
      userId: "user-1",
      kycLevel: "full",
      txCountLastHour: 0,
      txCountLast24h: 0,
      txVolumeLastWeekXaf: 0,
      completedTxLast30Days: 0,
      openDisputesLast30Days: 0,
      amlAlertsLast30Days: 0,
      highSeverityAmlAlertsLast30Days: 0,
      pepMatchesLast30Days: 1,
    });

    expect(score.tier).toBe("high");
    expect(score.factors).toContainEqual(
      expect.objectContaining({ name: "pep_match" }),
    );
  });

  it("halves a high-risk customer's otherwise applicable daily limit", async () => {
    (queryRead as jest.Mock).mockResolvedValueOnce({
      rows: [{ risk_tier: "high" }],
    });

    await expect(getEffectiveDailyLimit("user-1", 200_000)).resolves.toBe(
      100_000,
    );
  });

  it("writes a compliance audit record when a customer's tier changes", async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ risk_tier: "low", risk_score: 0 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValueOnce(client);
    (queryRead as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ kyc_level: "full" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            count_last_hour: "0",
            count_last_24h: "0",
            volume_last_week: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ completed: "0", disputed: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { total: "1", high_severity: "1", pep_matches: "1" },
        ],
      });

    const score = await evaluateCustomerRisk("user-1");

    expect(score.tier).toBe("high");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO customer_risk_audit"),
      expect.arrayContaining(["user-1", "low", "high"]),
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
});

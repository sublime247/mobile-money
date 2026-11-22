import { StatsService } from "../statsService";
import { pool } from "../../config/database";

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

jest.mock("../../utils/stellarReserveCalculator", () => ({
  calculateStellarReserve: jest.fn(),
}));

const mockQuery = pool.query as jest.Mock;

const day1 = new Date("2026-09-10T00:00:00.000Z");
const day2 = new Date("2026-09-11T00:00:00.000Z");

describe("StatsService", () => {
  let service: StatsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StatsService();
  });

  describe("getOverview", () => {
    it("returns totals, success rate and active users from one query", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            total: "20",
            successful: "16",
            volume: "1234.567",
            average: "77.1604375",
            active_users: "5",
          },
        ],
      });

      const start = new Date("2026-09-01T00:00:00.000Z");
      const end = new Date("2026-09-30T23:59:59.999Z");
      const result = await service.getOverview(start, end);

      expect(result).toEqual({
        totalTransactions: 20,
        successRate: 80,
        totalVolume: 1234.567,
        averageAmount: 77.1604375,
        activeUsers: 5,
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(params).toEqual([start, end]);
      expect(sql).toContain("COUNT(DISTINCT user_id) as active_users");
      expect(sql).toContain("WHERE created_at >= $1 AND created_at <= $2");
      // amount is already DECIMAL(20,7) — no per-row coercion needed
      expect(sql).not.toContain("::numeric");
      expect(sql).not.toMatch(/WHERE\s+WHERE/);
    });

    it("reports a zero success rate when there are no transactions", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            total: "0",
            successful: "0",
            volume: "0",
            average: "0",
            active_users: "0",
          },
        ],
      });

      const result = await service.getOverview();

      expect(result.successRate).toBe(0);
      expect(result.activeUsers).toBe(0);
      expect(mockQuery.mock.calls[0][1]).toEqual([]);
    });

    it("applies only the bounds it was given", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            total: "1",
            successful: "1",
            volume: "10",
            average: "10",
            active_users: "1",
          },
        ],
      });

      const start = new Date("2026-09-01T00:00:00.000Z");
      await service.getOverview(start);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(params).toEqual([start]);
      expect(sql).toContain("WHERE created_at >= $1");
      expect(sql).not.toContain("created_at <=");
    });
  });

  describe("getVolumeBreakdown", () => {
    it("folds provider rows and day rows out of a single grouped scan", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { provider: "mpesa", period: day1, volume: "100.5" },
          { provider: "airtel", period: day1, volume: "50.25" },
          { provider: "mpesa", period: day2, volume: "20" },
          { provider: "wave", period: day2, volume: "7.125" },
        ],
      });

      const start = new Date("2026-09-10T00:00:00.000Z");
      const end = new Date("2026-09-11T23:59:59.999Z");
      const result = await service.getVolumeBreakdown("day", start, end);

      expect(result.byProvider).toEqual({
        mpesa: 120.5,
        airtel: 50.25,
        wave: 7.125,
      });
      expect(result.trends).toEqual([
        { period: day1, volume: 150.75 },
        { period: day2, volume: 27.125 },
      ]);

      const [sql, params] = mockQuery.mock.calls[0];
      // $1 is the DATE_TRUNC unit, so the window starts at $2
      expect(params).toEqual(["day", start, end]);
      expect(sql).toContain("DATE_TRUNC($1, created_at) as period");
      expect(sql).toContain("GROUP BY provider, period");
      expect(sql).toContain("ORDER BY period ASC");
      expect(sql).toContain("AND created_at >= $2 AND created_at <= $3");
      expect(sql).not.toMatch(/WHERE\s+WHERE/);
      expect(sql).not.toContain("::numeric");
    });

    it("returns empty results when no rows match", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await service.getVolumeBreakdown("week");

      expect(result).toEqual({ byProvider: {}, trends: [] });
      expect(mockQuery.mock.calls[0][1]).toEqual(["week"]);
    });
  });
});

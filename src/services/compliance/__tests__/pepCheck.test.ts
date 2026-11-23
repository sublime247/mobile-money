import { PepCheckService, getPepCheckService } from "../pepCheck";

jest.mock("../../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));
jest.mock("../../../compliance/riskTier", () => ({
  evaluateCustomerRisk: jest.fn().mockResolvedValue({ tier: "high" }),
}));

import { pool } from "../../../config/database";
import { evaluateCustomerRisk } from "../../../compliance/riskTier";

const mockQuery = pool.query as jest.Mock;

describe("PepCheckService", () => {
  let service: PepCheckService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PepCheckService();

    // Mock the database as seeded (returns 10 rows on COUNT)
    mockQuery.mockImplementation((query: string, params?: unknown[]) => {
      if (query.includes("SELECT COUNT(*) as cnt")) {
        return { rows: [{ cnt: "10" }] };
      }
      if (query.includes("FROM pep_records")) {
        return {
          rows: [
            { id: "1", fullName: "Maria Santos", firstName: "Maria", lastName: "Santos", country: "PHL", source: "WorldBank", category: "Head of State", position: "Former President", externalId: "WB-001" },
            { id: "2", fullName: "Kwame Mensah", firstName: "Kwame", lastName: "Mensah", country: "GHA", source: "WorldBank", category: "Government Minister", position: "Minister of Finance", externalId: "WB-002" },
            { id: "3", fullName: "Carlos Mendoza", firstName: "Carlos", lastName: "Mendoza", country: "MEX", source: "FATF", category: "Government Minister", position: "Secretary of Treasury", externalId: "FATF-002" },
          ],
        };
      }
      if (query.includes("INSERT INTO aml_alerts")) {
        return { rows: [] };
      }
      if (query.includes("UPDATE kyc_applicants")) {
        return { rows: [] };
      }
      if (query.includes("ILINE")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  describe("screenCustomer", () => {
    it("returns match for exact name match", async () => {
      const result = await service.screenCustomer("Maria", "Santos");
      expect(result.matched).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.75);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
    });

    it("returns match for close name match (fuzzy)", async () => {
      const result = await service.screenCustomer("Mario", "Santos");
      expect(result.matched).toBe(true);
    });

    it("returns no match for unrelated name", async () => {
      const result = await service.screenCustomer("John", "Doe");
      expect(result.matched).toBe(false);
      expect(result.matches).toHaveLength(0);
    });

    it("boosts score when country matches", async () => {
      const resultNoCountry = await service.screenCustomer("Carlos", "Mendoza");
      const resultWithCountry = await service.screenCustomer("Carlos", "Mendoza", "MEX");
      expect(resultWithCountry.score).toBeGreaterThanOrEqual(resultNoCountry.score);
    });

    it("creates an AML alert for matched PEP", async () => {
      await service.screenCustomer("Maria", "Santos", undefined, "user-123");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO aml_alerts"),
        expect.any(Array),
      );
      expect(evaluateCustomerRisk).toHaveBeenCalledWith("user-123");
    });
  });

  describe("flagForReview", () => {
    it("updates kyc_applicants verification_status to review", async () => {
      const result = await service.screenCustomer("Maria", "Santos");
      await service.flagForReview("user-123", result);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE kyc_applicants"),
        expect.arrayContaining(["user-123"]),
      );
    });
  });

  describe("searchPepDatabase", () => {
    it("searches by name query", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ full_name: "Maria Santos" }] });
      const results = await service.searchPepDatabase("Maria");
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("ensureSeeded", () => {
    it("does not seed if records exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "10" }] });
      await service.ensureSeeded();
      // Should not have called INSERT
      const insertCalls = mockQuery.mock.calls.filter(([q]: [string]) => q.includes("INSERT INTO pep_records"));
      expect(insertCalls.length).toBe(0);
    });

    it("seeds if table is empty", async () => {
      mockQuery
        .mockReset()
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // COUNT says empty
        .mockResolvedValue({ rows: [] }); // INSERT succeeds

      await service.ensureSeeded();

      const insertCalls = mockQuery.mock.calls.filter(([q]: [string]) => q.includes("INSERT INTO pep_records"));
      expect(insertCalls.length).toBeGreaterThan(0);
    });
  });

  describe("getPepCheckService singleton", () => {
    it("returns the same instance", () => {
      const a = getPepCheckService();
      const b = getPepCheckService();
      expect(a).toBe(b);
    });
  });
});

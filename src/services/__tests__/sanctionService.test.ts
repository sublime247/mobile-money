import { sanctionService, SanctionScreeningError } from "../sanctionService";
import { pool } from "../../config/database";

// Mock the pool.query and pool.connect
jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

describe("SanctionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("jaroWinkler", () => {
    it("should return 1.0 for exact matches", () => {
      const score = (sanctionService as any).jaroWinkler(
        "OSAMA BIN LADEN",
        "OSAMA BIN LADEN",
      );
      expect(score).toBe(1.0);
    });

    it("should return 0.0 for completely different strings", () => {
      const score = (sanctionService as any).jaroWinkler("ABC", "XYZ");
      expect(score).toBe(0.0);
    });

    it("should return a high score for similar names", () => {
      const score = (sanctionService as any).jaroWinkler(
        "Osama bin Laden",
        "Usama bin Laden",
      );
      expect(score).toBeGreaterThan(0.9);
    });

    it("should return a lower score for less similar names", () => {
      const score = (sanctionService as any).jaroWinkler(
        "John Doe",
        "Jane Doe",
      );
      expect(score).toBeGreaterThan(0.8);
      expect(score).toBeLessThan(0.95);
    });
  });

  describe("searchSanctions", () => {
    it("should return matches above threshold", async () => {
      (pool.query as jest.fn).mockResolvedValue({
        rows: [
          {
            name: "Osama bin Laden",
            country: "Saudi Arabia",
            source: "UN",
            category: "Individual",
            external_id: "UN-001",
          },
          {
            name: "John Doe",
            country: "USA",
            source: "OFAC",
            category: "Individual",
            external_id: "OFAC-123",
          },
        ],
      });

      const matches = await sanctionService.searchSanctions(
        "Usama bin Laden",
        0.85,
      );
      expect(matches.length).toBe(1);
      expect(matches[0].entity.name).toBe("Osama bin Laden");
      expect(matches[0].score).toBeGreaterThan(0.9);
    });

    it("should return empty array if no matches above threshold", async () => {
      (pool.query as jest.fn).mockResolvedValue({
        rows: [
          {
            name: "Osama bin Laden",
            country: "Saudi Arabia",
            source: "UN",
            category: "Individual",
            external_id: "UN-001",
          },
        ],
      });

      const matches = await sanctionService.searchSanctions(
        "Santa Claus",
        0.85,
      );
      expect(matches.length).toBe(0);
    });
  });

  describe("updateSanctionList", () => {
    it("should execute batch updates within a transaction", async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      (pool.connect as jest.fn).mockResolvedValue(mockClient);

      const entities = [
        { name: "Entity 1", source: "UN", external_id: "E1" },
        { name: "Entity 2", source: "UN", external_id: "E2" },
      ];

      await sanctionService.updateSanctionList(entities);

      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sanction_list"),
        expect.any(Array),
      );
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should rollback on error", async () => {
      const mockClient = {
        query: jest.fn().mockImplementation((q) => {
          if (q.includes("INSERT")) throw new Error("DB Error");
        }),
        release: jest.fn(),
      };
      (pool.connect as jest.fn).mockResolvedValue(mockClient);

      await expect(
        sanctionService.updateSanctionList([
          { name: "E1", source: "UN", external_id: "E1" },
        ]),
      ).rejects.toThrow("DB Error");

      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("checkParties", () => {
    it("should resolve without error when neither party is sanctioned", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });
      await expect(
        sanctionService.checkParties("Alice Clean", "Bob Safe"),
      ).resolves.toBeUndefined();
    });

    it("should throw SanctionScreeningError for a sanctioned sender", async () => {
      (pool.query as jest.fn).mockResolvedValue({
        rows: [
          {
            name: "Osama bin Laden",
            country: "SA",
            source: "UN",
            category: "Individual",
            external_id: "UN-001",
          },
        ],
      });

      await expect(
        sanctionService.checkParties("Usama bin Laden", "Bob Safe"),
      ).rejects.toThrow(SanctionScreeningError);

      await expect(
        sanctionService.checkParties("Usama bin Laden", "Bob Safe"),
      ).rejects.toMatchObject({
        party: "sender",
        screenedName: "Usama bin Laden",
      });
    });

    it("should throw SanctionScreeningError for a sanctioned receiver", async () => {
      (pool.query as jest.fn)
        .mockResolvedValueOnce({ rows: [] }) // sender passes
        .mockResolvedValueOnce({
          // receiver hits
          rows: [
            {
              name: "Global Arms Ltd",
              country: "XX",
              source: "OFAC",
              category: "Entity",
              external_id: "OFAC-456",
            },
          ],
        });

      await expect(
        sanctionService.checkParties("Alice Clean", "Global Arms Ltd"),
      ).rejects.toMatchObject({
        party: "receiver",
        screenedName: "Global Arms Ltd",
      });
    });

    it("SanctionScreeningError has the correct message format", async () => {
      (pool.query as jest.fn).mockResolvedValue({
        rows: [
          {
            name: "John Doe",
            country: "US",
            source: "OFAC",
            category: "Individual",
            external_id: "OFAC-123",
          },
        ],
      });

      let caught: unknown;
      try {
        await sanctionService.checkParties("John Doe", "Receiver");
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(SanctionScreeningError);
      const err = caught as SanctionScreeningError;
      expect(err.message).toMatch(/sanction screening blocked/i);
      expect(err.message).toContain("sender");
      expect(err.source).toBe("OFAC");
    });
  });

  describe("checkPartiesByAddress", () => {
    // Valid Stellar addresses for testing
    const validGAddress =
      "GDQEVDDKALTIIVIMVLYJ5YZOOU32DELTA7GFF2Y4YESRLG53XCISYhenderson";
    const validMAddress =
      "MDQEVDDKALTIIVIMVLYJ5YZOOU32DELTA7GFF2Y4YESRLG53XCISYMCB2X6ROUTE";

    it("should resolve without error when both G-addresses are clean", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });
      await expect(
        sanctionService.checkPartiesByAddress(
          validGAddress,
          validGAddress,
          "Alice",
          "Bob",
        ),
      ).resolves.toBeUndefined();
    });

    it("should resolve muxed address and check against sanction list", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });
      await expect(
        sanctionService.checkPartiesByAddress(
          validMAddress,
          validGAddress,
          "Alice",
          "Bob",
        ),
      ).resolves.toBeUndefined();
    });

    it("should throw error for invalid sender address", async () => {
      await expect(
        sanctionService.checkPartiesByAddress(
          "INVALID",
          validGAddress,
          "Alice",
          "Bob",
        ),
      ).rejects.toThrow("Invalid sender address");
    });

    it("should throw error for invalid receiver address", async () => {
      await expect(
        sanctionService.checkPartiesByAddress(
          validGAddress,
          "INVALID",
          "Alice",
          "Bob",
        ),
      ).rejects.toThrow("Invalid receiver address");
    });

    it("should throw SanctionScreeningError when sender is sanctioned", async () => {
      (pool.query as jest.fn).mockResolvedValue({
        rows: [
          {
            name: "Osama bin Laden",
            country: "SA",
            source: "UN",
            category: "Individual",
            external_id: "UN-001",
          },
        ],
      });

      await expect(
        sanctionService.checkPartiesByAddress(
          validGAddress,
          validGAddress,
          "Usama bin Laden",
          "Bob",
        ),
      ).rejects.toMatchObject({ party: "sender" });
    });

    it("should throw SanctionScreeningError when receiver is sanctioned", async () => {
      (pool.query as jest.fn)
        .mockResolvedValueOnce({ rows: [] }) // sender passes
        .mockResolvedValueOnce({
          // receiver hits
          rows: [
            {
              name: "Global Arms Ltd",
              country: "XX",
              source: "OFAC",
              category: "Entity",
              external_id: "OFAC-456",
            },
          ],
        });

      await expect(
        sanctionService.checkPartiesByAddress(
          validGAddress,
          validGAddress,
          "Alice",
          "Global Arms Ltd",
        ),
      ).rejects.toMatchObject({ party: "receiver" });
    });

    it("should use address as screening ID if name is not provided", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });
      await expect(
        sanctionService.checkPartiesByAddress(validGAddress, validGAddress),
      ).resolves.toBeUndefined();

      // Verify that queries were made
      expect(pool.query).toHaveBeenCalled();
    });
  });
});

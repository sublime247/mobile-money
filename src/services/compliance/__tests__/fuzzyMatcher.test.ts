const mockQuery = jest.fn();

jest.mock("../../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  bestJaroWinklerMatch,
  JARO_WINKLER_REVIEW_THRESHOLD,
  jaroSimilarity,
  jaroWinklerSimilarity,
  nameJaroWinkler,
  normalizeForMatching,
  requiresManualReview,
} from "../fuzzyMatcher";
import { AmlScreeningService, PENDING_COMPLIANCE_REVIEW } from "../../amlScreening";

describe("Jaro / Jaro-Winkler primitives", () => {
  it("matches the canonical reference values", () => {
    // Values from Winkler (1990) / the standard literature examples.
    expect(jaroSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 4);
    expect(jaroWinklerSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 4);
    expect(jaroWinklerSimilarity("DIXON", "DICKSONX")).toBeCloseTo(0.8133, 4);
    expect(jaroWinklerSimilarity("DWAYNE", "DUANE")).toBeCloseTo(0.84, 4);
  });

  it("handles identical and empty strings", () => {
    expect(jaroWinklerSimilarity("abc", "abc")).toBe(1);
    expect(jaroWinklerSimilarity("", "abc")).toBe(0);
    expect(jaroWinklerSimilarity("abc", "xyz")).toBe(0);
  });

  it("is symmetric", () => {
    expect(jaroWinklerSimilarity("crate", "trace")).toBeCloseTo(
      jaroWinklerSimilarity("trace", "crate"),
      10,
    );
  });
});

describe("normalizeForMatching", () => {
  it("strips accents, punctuation and honorifics", () => {
    expect(normalizeForMatching("Dr. José  Álvarez-Núñez, Jr.")).toBe("jose alvarez nunez");
    expect(normalizeForMatching(null)).toBe("");
  });
});

describe("nameJaroWinkler", () => {
  it.each([
    ["Jhon Doe", "John Doe"],
    ["Osama bin Ladin", "Osama bin Laden"],
    ["Glbal Arms Ltd", "Global Arms Ltd"],
    ["Jane Smyth", "Jane Smith"],
  ])("detects character transpositions / typos: %s ~ %s", (a, b) => {
    expect(nameJaroWinkler(a, b)).toBeGreaterThanOrEqual(JARO_WINKLER_REVIEW_THRESHOLD);
  });

  it.each([
    ["Jose Alvarez", "José Álvarez"],
    ["Francois Muller", "François Müller"],
    ["Nunez", "Núñez"],
  ])("treats missing accents as an exact match: %s ~ %s", (a, b) => {
    expect(nameJaroWinkler(a, b)).toBe(1);
  });

  it.each([
    ["Usama bin Ladin", "Osama bin Laden"],
    ["Mohamed Ali", "Mohammed Ali"],
    ["Muhammad Ali", "Mohammed Ali"],
  ])("detects transliteration variants: %s ~ %s", (a, b) => {
    expect(nameJaroWinkler(a, b)).toBeGreaterThanOrEqual(JARO_WINKLER_REVIEW_THRESHOLD);
  });

  it("is insensitive to given/family name order", () => {
    expect(nameJaroWinkler("Doe, John", "John Doe")).toBe(1);
  });

  it.each([
    ["Jane Smith", "John Smith"],
    ["John Smith", "John Doe"],
    ["Alice Johnson", "John Doe"],
    ["Maria Garcia", "Global Arms Ltd"],
    ["Peter Parker", "Jane Smith"],
  ])("keeps clear negatives below the review threshold: %s vs %s", (a, b) => {
    expect(nameJaroWinkler(a, b)).toBeLessThan(JARO_WINKLER_REVIEW_THRESHOLD);
  });

  it("returns 0 for empty input", () => {
    expect(nameJaroWinkler("", "John Doe")).toBe(0);
  });
});

describe("bestJaroWinklerMatch", () => {
  it("reports the alias that produced the best score", () => {
    const match = bestJaroWinklerMatch("Abu Abdallah", {
      name: "Osama bin Laden",
      aliases: ["Usama bin Muhammad bin Awad bin Ladin", "Abu Abdallah"],
    });
    expect(match).toEqual({ matchedAlias: "Abu Abdallah", isAlias: true, score: 1 });
  });

  it("falls back to the primary name when there are no aliases", () => {
    const match = bestJaroWinklerMatch("Osama bin Ladin", { name: "Osama bin Laden" });
    expect(match.isAlias).toBe(false);
    expect(match.matchedAlias).toBe("Osama bin Laden");
  });
});

describe("requiresManualReview", () => {
  it("flags scores >= 0.85", () => {
    expect(requiresManualReview(0.85)).toBe(true);
    expect(requiresManualReview(0.8499)).toBe(false);
    expect(requiresManualReview(Number.NaN)).toBe(false);
  });
});

describe("AmlScreeningService with Jaro-Winkler", () => {
  const pepScreener = {
    screenCustomer: jest.fn().mockResolvedValue({ matched: false, score: 0, matches: [] }),
  };

  function serviceWithSanctions(rows: Array<Record<string, unknown>>) {
    mockQuery.mockImplementation((query: unknown) => {
      if (typeof query === "string" && query.includes("FROM sanction_list")) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    });
    return new AmlScreeningService({ highVolumeThresholdUsd: 0 }, pepScreener);
  }

  beforeEach(() => mockQuery.mockReset());

  it("flags an alias match for manual review and records alias + score in the audit log", async () => {
    const service = serviceWithSanctions([
      {
        name: "Osama bin Laden",
        source: "UN",
        category: "Individual",
        external_id: "UN-001",
        aliases: ["Usama bin Ladin", "Abu Abdallah"],
      },
    ]);

    const result = await service.screenParties({
      transactionId: "tx-1",
      userId: "user-1",
      senderName: "Abu Abdalah",
      dailyVolumeUsd: 5000,
    });

    expect(result.flagged).toBe(true);
    expect(result.status).toBe(PENDING_COMPLIANCE_REVIEW);
    const [match] = result.matches;
    expect(match.matchedAlias).toBe("Abu Abdallah");
    expect(match.algorithm).toBe("jaro_winkler");
    expect(match.score).toBeGreaterThanOrEqual(0.85);

    const [audit] = service.getAuditTrail();
    expect(audit).toMatchObject({
      matchedName: "Osama bin Laden",
      matchedAlias: "Abu Abdallah",
      matchAlgorithm: "jaro_winkler",
      score: match.score,
      listReference: "UN-001",
      status: PENDING_COMPLIANCE_REVIEW,
    });
    expect(service.verifyAuditTrail()).toBe(true);

    const insert = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO aml_screening_audit"),
    );
    expect(insert![0]).toContain("matched_alias");
    expect(insert![1]).toEqual(expect.arrayContaining(["Abu Abdallah", "jaro_winkler"]));
  });

  it("flags a transposed OFAC name via the sanctions pipeline", async () => {
    const service = serviceWithSanctions([
      { name: "Global Arms Ltd", source: "OFAC", external_id: "OFAC-456" },
    ]);
    const matches = await service.screenNameAgainstSanctions("Glboal Arms Ltd", "receiver");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("OFAC");
    expect(matches[0].score).toBeGreaterThanOrEqual(0.85);
  });

  it("does not flag a clear negative", async () => {
    const service = serviceWithSanctions([
      { name: "John Smith", source: "UN", external_id: "UN-9", aliases: ["Johnny Smith"] },
    ]);
    const result = await service.screenParties({
      transactionId: "tx-2",
      senderName: "Jane Smith",
      dailyVolumeUsd: 5000,
    });
    expect(result.flagged).toBe(false);
    expect(service.getAuditTrail()).toHaveLength(0);
  });
});

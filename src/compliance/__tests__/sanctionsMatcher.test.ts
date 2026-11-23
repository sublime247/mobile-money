import {
  calculateSimilarity,
  screenCustomerName,
  normalizeString,
} from "../sanctionsMatcher";

describe("Sanctions and PEP Matcher", () => {
  it("should normalize strings by removing accents and punctuation", () => {
    expect(normalizeString("Nicolás Maduro-Moros!")).toBe("NICOLAS MADURO MOROS");
    expect(normalizeString("  vladimir   putin  ")).toBe("VLADIMIR PUTIN");
  });

  it("should automatically BLOCK transactions with exact match (score 1.0)", () => {
    const result = screenCustomerName("Vladimir Putin");
    expect(result.action).toBe("BLOCK");
    expect(result.similarityScore).toBe(1.0);
    expect(result.flagged).toBe(true);
    expect(result.matchedEntity).toBe("VLADIMIR PUTIN");
  });

  it("should flag for REVIEW transactions with misspelled name >= 0.85", () => {
    // Single typo: "Vladymir Putin"
    const result = screenCustomerName("Vladymir Putin");
    expect(result.action).toBe("REVIEW");
    expect(result.similarityScore).toBeGreaterThanOrEqual(0.85);
    expect(result.flagged).toBe(true);
    expect(result.matchedEntity).toBe("VLADIMIR PUTIN");
  });

  it("should handle transposed names (first name and last name flipped)", () => {
    const result = screenCustomerName("Putin Vladimir");
    expect(result.action).toBe("REVIEW");
    expect(result.similarityScore).toBeGreaterThanOrEqual(0.85);
    expect(result.flagged).toBe(true);
  });

  it("should PASS legitimate names without false positives", () => {
    const result = screenCustomerName("John Doe");
    expect(result.action).toBe("PASS");
    expect(result.similarityScore).toBeLessThan(0.85);
    expect(result.flagged).toBe(false);
  });
});

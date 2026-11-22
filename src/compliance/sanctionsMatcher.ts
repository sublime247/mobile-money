/**
 * Automated Sanction List Screening for PEP and OFAC SDN
 * Implements fuzzy matching algorithm and risk scoring
 * Issue #2336
 */

export interface ScreeningResult {
  name: string;
  matchedEntity?: string;
  similarityScore: number;
  action: "BLOCK" | "REVIEW" | "PASS";
  flagged: boolean;
  reason?: string;
}

// Built-in reference sample list for OFAC SDN and PEP records
export const DEFAULT_SANCTIONED_ENTITIES: string[] = [
  "VLADIMIR PUTIN",
  "KIM JONG UN",
  "BASHAR AL ASSAD",
  "NICOLAS MADURO",
  "OSAMA BIN LADEN",
  "ALEXANDER LUKASHENKO",
  "ALI KHAMENEI",
  "SERGEY LAVROV",
  "QASEM SOLEIMANI",
  "VIKTOR YANUKOVYCH",
];

export function normalizeString(str: string): string {
  return str
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^A-Z0-9\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Standard Levenshtein distance calculation
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Calculates string similarity score between 0.0 and 1.0.
 * Combines direct character distance and token set comparison to handle transposition.
 */
export function calculateSimilarity(name1: string, name2: string): number {
  const norm1 = normalizeString(name1);
  const norm2 = normalizeString(name2);

  if (!norm1 || !norm2) return 0.0;
  if (norm1 === norm2) return 1.0;

  // Direct Levenshtein similarity
  const maxLen = Math.max(norm1.length, norm2.length);
  const levDist = levenshteinDistance(norm1, norm2);
  const levScore = 1.0 - levDist / maxLen;

  // Token sort comparison to handle transposed names ("John Smith" vs "Smith John")
  const tokens1 = norm1.split(" ").sort().join(" ");
  const tokens2 = norm2.split(" ").sort().join(" ");
  const tokenMaxLen = Math.max(tokens1.length, tokens2.length);
  const tokenDist = levenshteinDistance(tokens1, tokens2);
  const tokenScore = 1.0 - tokenDist / tokenMaxLen;

  // Return best score
  return Number(Math.max(levScore, tokenScore).toFixed(4));
}

export function screenCustomerName(
  customerName: string,
  sanctionsDatabase: string[] = DEFAULT_SANCTIONED_ENTITIES,
): ScreeningResult {
  let highestScore = 0.0;
  let closestEntity: string | undefined = undefined;

  for (const entity of sanctionsDatabase) {
    const score = calculateSimilarity(customerName, entity);
    if (score > highestScore) {
      highestScore = score;
      closestEntity = entity;
    }
  }

  // Exact match (1.0) -> Block immediately
  if (highestScore === 1.0) {
    return {
      name: customerName,
      matchedEntity: closestEntity,
      similarityScore: 1.0,
      action: "BLOCK",
      flagged: true,
      reason: `Exact match found on sanctions list: ${closestEntity}`,
    };
  }

  // High similarity (>= 0.85) -> Flag for manual compliance analyst review
  if (highestScore >= 0.85) {
    return {
      name: customerName,
      matchedEntity: closestEntity,
      similarityScore: highestScore,
      action: "REVIEW",
      flagged: true,
      reason: `High similarity (${(highestScore * 100).toFixed(1)}%) to sanctioned entity: ${closestEntity}`,
    };
  }

  return {
    name: customerName,
    similarityScore: highestScore,
    action: "PASS",
    flagged: false,
  };
}

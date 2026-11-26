/**
 * Jaro-Winkler fuzzy name matching for sanctions screening (#2560).
 *
 * Sanctions data is noisy: transliterations ("Mohammed" / "Muhammad"),
 * typos and character transpositions ("Jhon"), dropped accents ("José" /
 * "Jose") and reordered given/family names. Jaro-Winkler suits this well — it
 * tolerates transpositions and rewards a shared prefix, which is where name
 * spellings agree most often.
 *
 * Names are normalised (diacritics stripped, lowercased, punctuation and
 * honorifics removed) and compared both as written and with tokens sorted,
 * so "Doe, John" scores the same as "John Doe".
 */

/** Score at or above which a match goes to manual compliance review. */
export const JARO_WINKLER_REVIEW_THRESHOLD = 0.85;

/** Standard Winkler prefix scaling factor and max prefix length. */
const PREFIX_SCALE = 0.1;
const MAX_PREFIX = 4;

const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam",
  "jr", "sr", "ii", "iii", "iv", "phd", "md",
]);

export function normalizeForMatching(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !HONORIFICS.has(token))
    .join(" ");
}

/** Jaro similarity in [0, 1]. */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
}

/** Jaro-Winkler similarity in [0, 1] on raw strings. */
export function jaroWinklerSimilarity(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  let prefix = 0;
  const limit = Math.min(MAX_PREFIX, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  return Math.min(1, jaro + prefix * PREFIX_SCALE * (1 - jaro));
}

function sortTokens(normalized: string): string {
  return normalized.split(" ").sort().join(" ");
}

/** Tokens shorter than this ("al", "bin", "de", "el") are particles, not name parts. */
const MIN_SIGNIFICANT_TOKEN = 4;
/** A token pair scoring below this is treated as "different name part". */
const TOKEN_AGREEMENT_FLOOR = 0.8;

/**
 * Token agreement in [0, 1]: each significant token of the shorter name is
 * paired with its best Jaro-Winkler token in the other name; pairs below
 * {@link TOKEN_AGREEMENT_FLOOR} count as zero, and the sum is divided by the
 * larger significant-token count so unmatched name parts pull the score down.
 *
 * This stops a shared surname alone ("Jane Smith" vs "John Smith") from
 * carrying a full-string score past the review threshold.
 */
function tokenAgreement(a: string, b: string): number | null {
  const sig = (s: string) =>
    s.split(" ").filter((t) => t.length >= MIN_SIGNIFICANT_TOKEN);
  let left = sig(a);
  let right = sig(b);
  if (left.length === 0 || right.length === 0) return null;
  if (left.length > right.length) [left, right] = [right, left];

  let total = 0;
  for (const token of left) {
    let best = 0;
    for (const other of right) {
      best = Math.max(best, jaroWinklerSimilarity(token, other));
    }
    total += best >= TOKEN_AGREEMENT_FLOOR ? best : 0;
  }
  return total / right.length;
}

/**
 * Name-level Jaro-Winkler: normalises both names, takes the better of the
 * as-written and token-sorted full-string comparisons, then caps it by the
 * per-token agreement so every significant name part has to match.
 */
export function nameJaroWinkler(left: string, right: string): number {
  const a = normalizeForMatching(left);
  const b = normalizeForMatching(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const full = Math.max(
    jaroWinklerSimilarity(a, b),
    jaroWinklerSimilarity(sortTokens(a), sortTokens(b)),
  );
  const tokens = tokenAgreement(a, b);
  return tokens === null ? full : Math.min(full, tokens);
}

export interface FuzzyCandidate {
  /** Primary listed name. */
  name: string;
  /** Known aliases / alternate spellings (AKA entries). */
  aliases?: readonly string[] | null;
}

export interface FuzzyMatch {
  /** The primary or alias spelling that produced the best score. */
  matchedAlias: string;
  /** `true` when the best score came from an alias rather than the primary name. */
  isAlias: boolean;
  score: number;
}

/**
 * Scores `applicantName` against a list entry's primary name and every alias
 * and returns the best-scoring spelling.
 */
export function bestJaroWinklerMatch(
  applicantName: string,
  candidate: FuzzyCandidate,
): FuzzyMatch {
  let best: FuzzyMatch = {
    matchedAlias: candidate.name,
    isAlias: false,
    score: nameJaroWinkler(applicantName, candidate.name),
  };
  for (const alias of candidate.aliases ?? []) {
    if (!alias) continue;
    const score = nameJaroWinkler(applicantName, alias);
    if (score > best.score) best = { matchedAlias: alias, isAlias: true, score };
  }
  return best;
}

/** `true` when a score requires manual compliance review. */
export function requiresManualReview(
  score: number,
  threshold: number = JARO_WINKLER_REVIEW_THRESHOLD,
): boolean {
  return Number.isFinite(score) && score >= threshold;
}

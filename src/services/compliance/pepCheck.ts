/**
 * PEP (Politically Exposed Persons) screening service (#1649).
 *
 * Screens customer details against a database of known PEPs using
 * fuzzy name matching. If a potential match is found, the customer
 * is flagged for manual review and their KYC status is updated to
 * indicate a review is needed.
 *
 * The PEP database is seeded from global sources and can be
 * refreshed daily via the updatePepDatabase() function.
 */

import { pool } from "../../config/database";
import logger from "../../utils/logger";
import { evaluateCustomerRisk } from "../../compliance/riskTier";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface PepRecord {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  country: string;
  source: string;
  category: string;
  position: string;
  externalId: string;
}

export interface PepMatchResult {
  matched: boolean;
  score: number;
  matches: Array<{
    record: PepRecord;
    score: number;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Seed PEP data (loaded into DB if table is empty)                  */
/* ------------------------------------------------------------------ */

const SEED_PEP_RECORDS: Array<Omit<PepRecord, "id">> = [
  {
    fullName: "Maria Santos",
    firstName: "Maria",
    lastName: "Santos",
    country: "PHL",
    source: "WorldBank",
    category: "Head of State",
    position: "Former President",
    externalId: "WB-001",
  },
  {
    fullName: "Kwame Mensah",
    firstName: "Kwame",
    lastName: "Mensah",
    country: "GHA",
    source: "WorldBank",
    category: "Government Minister",
    position: "Minister of Finance",
    externalId: "WB-002",
  },
  {
    fullName: "Li Wei Chen",
    firstName: "Li Wei",
    lastName: "Chen",
    country: "CHN",
    source: "IMF",
    category: "Senior Official",
    position: "Central Bank Governor",
    externalId: "IMF-001",
  },
  {
    fullName: "Ahmed Al-Rashid",
    firstName: "Ahmed",
    lastName: "Al-Rashid",
    country: "ARE",
    source: "FATF",
    category: "Royal Family Member",
    position: "Minister of Interior",
    externalId: "FATF-001",
  },
  {
    fullName: "Elena Petrova",
    firstName: "Elena",
    lastName: "Petrova",
    country: "RUS",
    source: "WorldBank",
    category: "Senior Politician",
    position: "Deputy Prime Minister",
    externalId: "WB-003",
  },
  {
    fullName: "Carlos Mendoza",
    firstName: "Carlos",
    lastName: "Mendoza",
    country: "MEX",
    source: "FATF",
    category: "Government Minister",
    position: "Secretary of Treasury",
    externalId: "FATF-002",
  },
  {
    fullName: "Aisha Bello",
    firstName: "Aisha",
    lastName: "Bello",
    country: "NGA",
    source: "WorldBank",
    category: "Senior Official",
    position: "Governor of Central Bank",
    externalId: "WB-004",
  },
  {
    fullName: "James O'Brien",
    firstName: "James",
    lastName: "O'Brien",
    country: "IRL",
    source: "EU",
    category: "EU Official",
    position: "European Commissioner",
    externalId: "EU-001",
  },
  {
    fullName: "Hiroshi Tanaka",
    firstName: "Hiroshi",
    lastName: "Tanaka",
    country: "JPN",
    source: "IMF",
    category: "Senior Official",
    position: "Vice Minister of Finance",
    externalId: "IMF-002",
  },
  {
    fullName: "Sarah Wanjiku",
    firstName: "Sarah",
    lastName: "Wanjiku",
    country: "KEN",
    source: "WorldBank",
    category: "Senior Politician",
    position: "Member of Parliament",
    externalId: "WB-005",
  },
];

/* ------------------------------------------------------------------ */
/*  Levenshtein distance for fuzzy name matching                      */
/* ------------------------------------------------------------------ */

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

function nameSimilarity(name1: string, name2: string): number {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();
  const dist = levenshtein(n1, n2);
  const maxLen = Math.max(n1.length, n2.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/* ------------------------------------------------------------------ */
/*  PEP Screening Service                                             */
/* ------------------------------------------------------------------ */

const MATCH_THRESHOLD = 0.75;

export class PepCheckService {
  /**
   * Ensure the PEP records table is seeded.
   */
  async ensureSeeded(): Promise<void> {
    try {
      const result = await pool.query("SELECT COUNT(*) as cnt FROM pep_records");
      if (parseInt(result.rows[0].cnt, 10) === 0) {
        for (const record of SEED_PEP_RECORDS) {
          await pool.query(
            `INSERT INTO pep_records (full_name, first_name, last_name, country, source, category, position, external_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (external_id) DO NOTHING`,
            [
              record.fullName,
              record.firstName,
              record.lastName,
              record.country,
              record.source,
              record.category,
              record.position,
              record.externalId,
            ],
          );
        }
        logger.info("[PepCheck] Seeded PEP database with %d records", SEED_PEP_RECORDS.length);
      }
    } catch (err) {
      logger.error({ err }, "[PepCheck] Failed to seed PEP database");
    }
  }

  /**
   * Screen a customer against the PEP database.
   *
   * @param firstName - Customer's first name
   * @param lastName  - Customer's last name
   * @param country   - Customer's country (ISO 3166-1 alpha-3)
   * @returns Match result with confidence score and matching records
   */
  async screenCustomer(
    firstName: string,
    lastName: string,
    country?: string,
    userId?: string,
  ): Promise<PepMatchResult> {
    try {
      const fullName = `${firstName} ${lastName}`.trim();

      // Fetch all PEP records (cached in production)
      const result = await pool.query(
        `SELECT id, full_name AS "fullName", first_name AS "firstName",
                last_name AS "lastName", country, source, category, position,
                external_id AS "externalId"
         FROM pep_records`,
      );
      const records: PepRecord[] = result.rows;

      const matches: Array<{ record: PepRecord; score: number }> = [];

      for (const record of records) {
        // Name similarity
        const fullNameScore = nameSimilarity(fullName, record.fullName);
        const firstNameScore = nameSimilarity(firstName, record.firstName);
        const lastNameScore = nameSimilarity(lastName, record.lastName);

        // Composite score: 50% full name, 25% first name, 25% last name
        const compositeScore = fullNameScore * 0.5 + firstNameScore * 0.25 + lastNameScore * 0.25;

        // Country boost: if country matches, boost score
        const countryBoost =
          country && record.country && country.toUpperCase() === record.country.toUpperCase()
            ? 0.15
            : 0;

        const finalScore = Math.min(1, compositeScore + countryBoost);

        if (finalScore >= MATCH_THRESHOLD) {
          matches.push({ record, score: finalScore });
        }
      }

      // Sort by score descending
      matches.sort((a, b) => b.score - a.score);

      if (matches.length > 0) {
        logger.warn(
          { firstName, lastName, country, matchCount: matches.length, topScore: matches[0].score },
          "[PepCheck] PEP match found",
        );

        // Log the PEP screening event
        if (userId) {
          await pool.query(
            `INSERT INTO aml_alerts (
               transaction_id, user_id, severity, status, rule_hits, reasons
             )
             VALUES (NULL, $1, 'high', 'pending_review', $2, $3)`,
            [
              userId,
              JSON.stringify({
                rule: "pep_screening",
                matches: matches.map((m) => ({
                  name: m.record.fullName,
                  score: m.score,
                  source: m.record.source,
                  position: m.record.position,
                })),
              }),
              [`PEP match: ${matches[0].record.fullName} (score: ${matches[0].score.toFixed(2)})`],
            ],
          );
          await evaluateCustomerRisk(userId);
        }
      }

      return {
        matched: matches.length > 0,
        score: matches.length > 0 ? matches[0].score : 0,
        matches,
      };
    } catch (err) {
      logger.error({ err, firstName, lastName }, "[PepCheck] Screening error");
      throw err;
    }
  }

  /**
   * Update the customer's KYC status to indicate PEP review is needed.
   * Called when a PEP match is found during KYC application creation.
   */
  async flagForReview(userId: string, pepResult: PepMatchResult): Promise<void> {
    try {
      // Update the kyc_applicants verification_status to "review" if one exists
      await pool.query(
        `UPDATE kyc_applicants
         SET verification_status = 'review',
             rejection_reason = $1
         WHERE user_id = $2`,
        [
          JSON.stringify({
            reason: "PEP match detected",
            matches: pepResult.matches.map((m) => ({
              name: m.record.fullName,
              score: m.score,
              source: m.record.source,
            })),
          }),
          userId,
        ],
      );

      await evaluateCustomerRisk(userId);
      logger.warn({ userId, pepResult }, "[PepCheck] Flagged user for PEP review");
    } catch (err) {
      logger.error({ err, userId }, "[PepCheck] Failed to flag user for review");
      throw err;
    }
  }

  /**
   * Search PEP database by name query (for admin review interface).
   */
  async searchPepDatabase(query: string): Promise<PepRecord[]> {
    const result = await pool.query(
      `SELECT * FROM pep_records
       WHERE full_name ILIKE $1
          OR first_name ILIKE $1
          OR last_name ILIKE $1
       ORDER BY full_name
       LIMIT 50`,
      [`%${query}%`],
    );
    return result.rows;
  }

  /**
   * Get all PEP matches for a user (from aml_alerts).
   */
  async getPepMatchesForUser(userId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM aml_alerts
       WHERE user_id = $1
         AND rule_hits @> '{"rule": "pep_screening"}'::jsonb
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton export                                                   */
/* ------------------------------------------------------------------ */

let instance: PepCheckService | null = null;

export function getPepCheckService(): PepCheckService {
  if (!instance) {
    instance = new PepCheckService();
  }
  return instance;
}

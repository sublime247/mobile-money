/**
 * AML sanctions & PEP screening for high-volume senders (#1970).
 *
 * SEP-31 senders (and their receivers) whose rolling 24h USD volume exceeds a
 * configurable threshold are screened against the sanctions lists stored in
 * `sanction_list` (OFAC, UN, EU) and against the PEP database. Fuzzy name
 * matching is used because sanctions data is dirty — transliterations, middle
 * names, and punctuation all vary.
 *
 * When a match is found the transaction is flagged
 * `pending_compliance_review` and an immutable, hash-chained audit record is
 * written for AML reporting (`aml_screening_audit`).
 */

import crypto from "crypto";
import logger from "../utils/logger";
import { pool } from "../config/database";
import { getPepCheckService } from "./compliance/pepCheck";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AmlScreeningParty = "sender" | "receiver";
export type AmlScreeningListType = "sanctions" | "pep";
export type AmlScreeningStatus =
  | "passed"
  | "pending_compliance_review"
  | "blocked_frozen";

/** Status written to transaction metadata when screening flags a payment. */
export const PENDING_COMPLIANCE_REVIEW = "pending_compliance_review" as const;

export interface AmlSanctionEntity {
  name: string;
  country?: string;
  source: string;
  category?: string;
  external_id?: string;
}

export interface AmlScreeningMatch {
  party: AmlScreeningParty;
  listType: AmlScreeningListType;
  screenedName: string;
  matchedName: string;
  score: number;
  source: string;
  category?: string;
  externalId?: string;
}

export interface AmlScreeningAuditRecord {
  id: string;
  transactionId: string;
  userId?: string;
  party: AmlScreeningParty;
  listType: AmlScreeningListType;
  screenedName: string;
  matchedName: string;
  score: number;
  source: string;
  /** Reference of the matched list entry (e.g. OFAC-456), when known. */
  listReference?: string;
  dailyVolumeUsd: number;
  status: AmlScreeningStatus;
  createdAt: string;
  previousHash: string;
  recordHash: string;
}

export interface AmlScreeningInput {
  transactionId: string;
  userId?: string;
  senderName?: string;
  receiverName?: string;
  /** Rolling 24h USD volume for the sender, including this transaction. */
  dailyVolumeUsd: number;
}

export interface AmlScreeningResult {
  /** `true` when the volume threshold triggered screening. */
  required: boolean;
  flagged: boolean;
  status: AmlScreeningStatus;
  highVolume: boolean;
  thresholdUsd: number;
  dailyVolumeUsd: number;
  matches: AmlScreeningMatch[];
  auditRecordIds: string[];
}

export type RecipientScreeningDecision = "clear" | "review" | "block";

export interface RecipientScreeningResult {
  decision: RecipientScreeningDecision;
  matches: AmlScreeningMatch[];
  /** Highest-scoring sanctions match, if any. */
  topSanctionsMatch?: AmlScreeningMatch;
  pepMatches: AmlScreeningMatch[];
  auditRecordIds: string[];
}

export interface PepMatchRecord {
  record: {
    fullName: string;
    source: string;
    position?: string;
    category?: string;
  };
  score: number;
}

export interface PepScreener {
  screenCustomer(
    firstName: string,
    lastName: string,
    country?: string,
  ): Promise<{ matched: boolean; score: number; matches: PepMatchRecord[] }>;
}

export interface AmlScreeningConfig {
  highVolumeThresholdUsd: number;
  matchThreshold: number;
  /** Sanctions score at or above which a payout is blocked and frozen. */
  blockThreshold: number;
  cacheExpiryMs: number;
}

/** Fallback list used when the DB is unavailable/empty (kept tiny + stable). */
const SEED_SANCTIONS: AmlSanctionEntity[] = [
  { name: "Osama bin Laden", country: "Saudi Arabia", source: "UN", category: "Individual", external_id: "UN-001" },
  { name: "Global Arms Ltd", country: "Country B", source: "OFAC", category: "Entity", external_id: "OFAC-456" },
  { name: "Jane Smith", country: "Country C", source: "EU", category: "Individual", external_id: "EU-789" },
  { name: "John Doe", country: "Country A", source: "UN", category: "Individual", external_id: "UN-123" },
];

const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "madam",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "phd",
  "md",
]);

// ─── Name normalization & fuzzy matching ────────────────────────────────────

/**
 * Normalize a name for comparison: lowercase, strip diacritics/punctuation,
 * drop honorifics and suffix tokens, collapse whitespace.
 *
 * Examples:
 *   "  José   O'Neil-Smith, Jr. " -> "jose o neil smith"
 *   "Mr. Osama BIN LADEN"         -> "osama bin laden"
 */
export function normalizeName(name: string | undefined | null): string {
  if (!name) return "";
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .split(/\s+/)
    .filter((token) => token.length > 0 && !HONORIFICS.has(token))
    .join(" ")
    .trim();
}

function tokenize(name: string): Set<string> {
  return new Set(normalizeName(name).split(/\s+/).filter(Boolean));
}

/** Space-optimized Levenshtein distance. */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a === b) return 0;

  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Composite similarity score (0-1): 60% full-string Levenshtein, 25% token
 * Jaccard, 15% best individual-token similarity.
 */
export function nameSimilarityScore(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  const intersection = [...leftTokens].filter((t) => rightTokens.has(t));
  const union = new Set([...leftTokens, ...rightTokens]);
  const jaccard = union.size > 0 ? intersection.length / union.size : 0;

  let bestToken = 0;
  for (const lt of leftTokens) {
    for (const rt of rightTokens) {
      const score = levenshteinSimilarity(lt, rt);
      if (score > bestToken) bestToken = score;
    }
  }

  const composite =
    levenshteinSimilarity(left, right) * 0.6 + jaccard * 0.25 + bestToken * 0.15;

  return Math.min(1, composite);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AmlScreeningService {
  private readonly config: AmlScreeningConfig;
  private readonly pepScreener: PepScreener;

  private sanctionCache: AmlSanctionEntity[] = [];
  private cacheInitialized = false;
  private lastCacheUpdate = 0;

  /** Append-only in-memory mirror of the audit trail (hash-chained). */
  private readonly auditTrail: AmlScreeningAuditRecord[] = [];

  constructor(
    config: Partial<AmlScreeningConfig> = {},
    pepScreener?: PepScreener,
  ) {
    this.config = {
      highVolumeThresholdUsd: config.highVolumeThresholdUsd ?? 1000,
      matchThreshold: config.matchThreshold ?? 0.85,
      blockThreshold:
        config.blockThreshold ??
        (Number(process.env.SANCTIONS_BLOCK_THRESHOLD) || 0.95),
      cacheExpiryMs: config.cacheExpiryMs ?? 60 * 60 * 1000,
    };
    this.pepScreener = pepScreener ?? getPepCheckService();
  }

  getConfig(): AmlScreeningConfig {
    return { ...this.config };
  }

  getAuditTrail(): AmlScreeningAuditRecord[] {
    // Deep-copy so callers cannot mutate the append-only trail in place.
    return this.auditTrail.map((record) => ({ ...record }));
  }

  /** `true` when the rolling daily volume meets the screening threshold. */
  isHighVolume(dailyVolumeUsd: number): boolean {
    return (
      Number.isFinite(dailyVolumeUsd) &&
      dailyVolumeUsd >= this.config.highVolumeThresholdUsd
    );
  }

  /**
   * Compute the sender's rolling 24h USD volume from the transactions table.
   * Always resolves to a finite number so screening can never block payments
   * because of a analytics hiccup.
   */
  async getDailyVolumeUsd(userId: string, now: Date = new Date()): Promise<number> {
    if (!userId) return 0;
    try {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const result = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(COALESCE(converted_amount, amount)), 0)::text AS total
           FROM transactions
          WHERE user_id = $1
            AND type = 'deposit'
            AND status IN ('completed', 'processing', 'pending', 'review')
            AND created_at >= $2`,
        [userId, since],
      );
      const total = Number(result.rows?.[0]?.total);
      return Number.isFinite(total) && total > 0 ? total : 0;
    } catch (error) {
      logger.warn(
        { error, userId },
        "[AmlScreening] Failed to compute daily volume — defaulting to 0",
      );
      return 0;
    }
  }

  /** Load sanctions lists from the DB, falling back to the seed list. */
  async loadSanctions(force = false): Promise<AmlSanctionEntity[]> {
    const now = Date.now();
    if (
      !force &&
      this.cacheInitialized &&
      now - this.lastCacheUpdate < this.config.cacheExpiryMs
    ) {
      return this.sanctionCache;
    }

    try {
      const { rows } = await pool.query<AmlSanctionEntity>(
        `SELECT name, country, source, category, external_id
           FROM sanction_list
          WHERE source = ANY($1::text[])`,
        [["OFAC", "UN", "EU"]],
      );
      this.sanctionCache = rows?.length ? rows : [...SEED_SANCTIONS];
    } catch (error) {
      logger.warn(
        { error },
        "[AmlScreening] Failed to load sanctions list — using seed data",
      );
      this.sanctionCache = [...SEED_SANCTIONS];
    }

    this.cacheInitialized = true;
    this.lastCacheUpdate = now;
    return this.sanctionCache;
  }

  /** Screen a single name against the loaded sanctions lists. */
  async screenNameAgainstSanctions(
    name: string,
    party: AmlScreeningParty,
  ): Promise<AmlScreeningMatch[]> {
    const entities = await this.loadSanctions();
    const matches: AmlScreeningMatch[] = [];

    for (const entity of entities) {
      const score = nameSimilarityScore(name, entity.name);
      if (score >= this.config.matchThreshold) {
        matches.push({
          party,
          listType: "sanctions",
          screenedName: name,
          matchedName: entity.name,
          score,
          source: entity.source,
          category: entity.category,
          externalId: entity.external_id,
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /** Screen a single name against the PEP database. */
  async screenNameAgainstPep(
    name: string,
    party: AmlScreeningParty,
  ): Promise<AmlScreeningMatch[]> {
    const normalized = normalizeName(name);
    if (!normalized) return [];

    const tokens = normalized.split(" ");
    const firstName = tokens[0];
    const lastName = tokens.slice(1).join(" ") || tokens[0];

    try {
      const result = await this.pepScreener.screenCustomer(firstName, lastName);
      if (!result?.matched) return [];

      return result.matches.map((match) => ({
        party,
        listType: "pep" as const,
        screenedName: name,
        matchedName: match.record.fullName,
        score: match.score,
        source: match.record.source,
        category: match.record.position ?? match.record.category,
      }));
    } catch (error) {
      logger.warn({ error, name }, "[AmlScreening] PEP screening failed");
      return [];
    }
  }

  /**
   * Screen the sender and receiver of a transaction when the sender's rolling
   * daily volume meets the threshold. Flags `pending_compliance_review` and
   * writes immutable audit records on a match.
   */
  async screenParties(
    input: AmlScreeningInput,
    options: { persistAudit?: boolean } = {},
  ): Promise<AmlScreeningResult> {
    const dailyVolumeUsd = Number.isFinite(input.dailyVolumeUsd)
      ? input.dailyVolumeUsd
      : 0;
    const highVolume = this.isHighVolume(dailyVolumeUsd);

    const base: AmlScreeningResult = {
      required: highVolume,
      flagged: false,
      status: "passed",
      highVolume,
      thresholdUsd: this.config.highVolumeThresholdUsd,
      dailyVolumeUsd,
      matches: [],
      auditRecordIds: [],
    };

    if (!highVolume) return base;

    const matches: AmlScreeningMatch[] = [];
    const parties: Array<{ role: AmlScreeningParty; name?: string }> = [
      { role: "sender", name: input.senderName },
      { role: "receiver", name: input.receiverName },
    ];

    for (const party of parties) {
      if (!party.name) continue;
      const sanctions = await this.screenNameAgainstSanctions(
        party.name,
        party.role,
      );
      const pep = await this.screenNameAgainstPep(party.name, party.role);
      matches.push(...sanctions, ...pep);
    }

    matches.sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      return base;
    }

    const persistAudit = options.persistAudit ?? true;
    const auditRecordIds: string[] = [];
    for (const match of matches) {
      if (!persistAudit) break;
      const record = await this.recordScreeningAudit({
        transactionId: input.transactionId,
        userId: input.userId,
        party: match.party,
        listType: match.listType,
        screenedName: match.screenedName,
        matchedName: match.matchedName,
        score: match.score,
        source: match.source,
        dailyVolumeUsd,
        status: PENDING_COMPLIANCE_REVIEW,
      });
      auditRecordIds.push(record.id);
    }

    logger.warn(
      {
        transactionId: input.transactionId,
        userId: input.userId,
        dailyVolumeUsd,
        matches: matches.map((m) => ({
          party: m.party,
          list: m.listType,
          name: m.matchedName,
          score: m.score,
        })),
      },
      "[AmlScreening] High-volume transaction flagged pending_compliance_review",
    );

    return {
      ...base,
      flagged: true,
      status: PENDING_COMPLIANCE_REVIEW,
      matches,
      auditRecordIds,
    };
  }

  /**
   * Screens the recipient of a cash-out against sanctions (OFAC/UN/EU) and PEP
   * lists before disbursement. Unlike {@link screenParties} this is not gated
   * on volume: every withdrawal is screened.
   *
   * - sanctions score >= blockThreshold  -> "block" (freeze the transaction)
   * - sanctions score >= matchThreshold  -> "review" (manual compliance review)
   * - PEP matches only                   -> "clear", returned in `pepMatches`
   *   so the caller can flag the account without stopping the payout
   *
   * Every match writes an audit entry carrying the score and list reference.
   */
  async screenRecipient(input: {
    transactionId: string;
    userId?: string;
    recipientName: string;
  }): Promise<RecipientScreeningResult> {
    const sanctions = await this.screenNameAgainstSanctions(
      input.recipientName,
      "receiver",
    );
    const pepMatches = await this.screenNameAgainstPep(
      input.recipientName,
      "receiver",
    );
    const matches = [...sanctions, ...pepMatches].sort(
      (a, b) => b.score - a.score,
    );
    const topSanctionsMatch = sanctions[0];

    let decision: RecipientScreeningDecision = "clear";
    if (topSanctionsMatch) {
      decision =
        topSanctionsMatch.score >= this.config.blockThreshold
          ? "block"
          : "review";
    }

    const auditRecordIds: string[] = [];
    for (const match of matches) {
      const isBlockingMatch =
        decision === "block" && match === topSanctionsMatch;
      const status: AmlScreeningStatus = isBlockingMatch
        ? "blocked_frozen"
        : match.listType === "sanctions"
          ? PENDING_COMPLIANCE_REVIEW
          : "passed";
      const record = await this.recordScreeningAudit({
        transactionId: input.transactionId,
        userId: input.userId,
        party: match.party,
        listType: match.listType,
        screenedName: match.screenedName,
        matchedName: match.matchedName,
        score: match.score,
        source: match.source,
        listReference: match.externalId,
        dailyVolumeUsd: 0,
        status,
      });
      auditRecordIds.push(record.id);
    }

    if (decision !== "clear") {
      logger.warn(
        {
          transactionId: input.transactionId,
          decision,
          list: topSanctionsMatch?.source,
          reference: topSanctionsMatch?.externalId,
          score: topSanctionsMatch?.score,
        },
        "[AmlScreening] Withdrawal recipient matched sanctions list",
      );
    }

    return { decision, matches, topSanctionsMatch, pepMatches, auditRecordIds };
  }

  /**
   * Convenience entry point for the SEP-31 pipeline: looks up the sender's
   * daily volume and screens the parties in one call.
   */
  async screenSep31Transaction(input: {
    transactionId: string;
    userId?: string;
    senderName?: string;
    receiverName?: string;
    amountUsd?: number;
  }): Promise<AmlScreeningResult> {
    const existingVolume = await this.getDailyVolumeUsd(input.userId ?? "");
    const dailyVolumeUsd =
      existingVolume + (Number.isFinite(input.amountUsd) ? input.amountUsd! : 0);

    return this.screenParties({
      transactionId: input.transactionId,
      userId: input.userId,
      senderName: input.senderName,
      receiverName: input.receiverName,
      dailyVolumeUsd,
    });
  }

  /**
   * Persist an immutable audit record. The record hash chains to the previous
   * record's hash, so any tampering is detectable by {@link verifyAuditTrail}.
   */
  async recordScreeningAudit(
    input: Omit<AmlScreeningAuditRecord, "id" | "createdAt" | "previousHash" | "recordHash">,
  ): Promise<AmlScreeningAuditRecord> {
    const previous = this.auditTrail[this.auditTrail.length - 1];
    const previousHash = previous?.recordHash ?? "GENESIS";

    const record: AmlScreeningAuditRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      previousHash,
      recordHash: "",
      ...input,
    };

    record.recordHash = this.computeRecordHash(record);
    this.auditTrail.push(record);

    try {
      await pool.query(
        `INSERT INTO aml_screening_audit (
            id, transaction_id, user_id, party, list_type, screened_name,
            matched_name, score, source, daily_volume_usd, status,
            previous_hash, record_hash, created_at, list_reference
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          record.transactionId,
          record.userId ?? null,
          record.party,
          record.listType,
          record.screenedName,
          record.matchedName,
          record.score,
          record.source,
          record.dailyVolumeUsd,
          record.status,
          record.previousHash,
          record.recordHash,
          record.createdAt,
          record.listReference ?? null,
        ],
      );
    } catch (error) {
      logger.error(
        { error, transactionId: record.transactionId },
        "[AmlScreening] Failed to persist audit record (kept in memory)",
      );
    }

    return record;
  }

  /** Recompute the hash chain to detect tampering. */
  verifyAuditTrail(): boolean {
    let previousHash = "GENESIS";
    for (const record of this.auditTrail) {
      if (record.previousHash !== previousHash) return false;
      if (record.recordHash !== this.computeRecordHash(record)) return false;
      previousHash = record.recordHash;
    }
    return true;
  }

  private computeRecordHash(
    record: Omit<AmlScreeningAuditRecord, "recordHash">,
  ): string {
    const canonical = JSON.stringify({
      id: record.id,
      transactionId: record.transactionId,
      userId: record.userId ?? null,
      party: record.party,
      listType: record.listType,
      screenedName: record.screenedName,
      matchedName: record.matchedName,
      score: record.score,
      source: record.source,
      dailyVolumeUsd: record.dailyVolumeUsd,
      status: record.status,
      createdAt: record.createdAt,
      previousHash: record.previousHash,
      // Only hashed when present so records written before this field existed
      // keep verifying.
      ...(record.listReference ? { listReference: record.listReference } : {}),
    });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /** Clear caches/trail (tests). */
  reset(): void {
    this.sanctionCache = [];
    this.cacheInitialized = false;
    this.lastCacheUpdate = 0;
    this.auditTrail.length = 0;
  }
}

export const amlScreeningService = new AmlScreeningService();

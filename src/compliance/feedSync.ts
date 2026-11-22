import https from "https";
import http from "http";
import crypto from "crypto";
import axios from "axios";
import { pool } from "../config/database";
import logger from "../utils/logger";

export interface SanctionsEntry {
  name: string;
  country?: string;
  source: "UN" | "OFAC";
  category: "Individual" | "Entity";
  externalId: string;
}

export interface SyncFeedResult {
  source: string;
  version: string;
  checksum: string;
  recordsCount: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
}

export interface SyncOptions {
  unFeedUrl?: string;
  ofacFeedUrl?: string;
  expectedChecksum?: string;
  version?: string;
}

/**
 * Calculates SHA-256 checksum of raw content
 */
export function calculateChecksum(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Fetches feed content over HTTPS with checksum validation
 */
export async function fetchFeedWithChecksum(
  url: string,
  expectedChecksum?: string,
): Promise<{ data: string; checksum: string }> {
  const response = await axios.get(url, {
    responseType: "text",
    timeout: 30000,
    headers: {
      "User-Agent": "MobileMoney-ComplianceSync/1.0",
    },
  });

  const content: string = response.data;
  const checksum = calculateChecksum(content);

  if (expectedChecksum && checksum !== expectedChecksum) {
    throw new Error(
      `Feed checksum validation failed! Expected: ${expectedChecksum}, Calculated: ${checksum}`,
    );
  }

  return { data: content, checksum };
}

/**
 * Parses UN XML Consolidated Sanctions feed
 */
export function parseUNSanctionsXML(xmlData: string): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];

  // Match individuals
  const individualRegex = /<INDIVIDUAL>([\s\S]*?)<\/INDIVIDUAL>/gi;
  let match: RegExpExecArray | null;

  while ((match = individualRegex.exec(xmlData)) !== null) {
    const block = match[1];
    const dataId = block.match(/<DATAID>([\s\S]*?)<\/DATAID>/i)?.[1]?.trim() || "";
    const firstName =
      block.match(/<FIRST_NAME>([\s\S]*?)<\/FIRST_NAME>/i)?.[1]?.trim() || "";
    const secondName =
      block.match(/<SECOND_NAME>([\s\S]*?)<\/SECOND_NAME>/i)?.[1]?.trim() || "";
    const thirdName =
      block.match(/<THIRD_NAME>([\s\S]*?)<\/THIRD_NAME>/i)?.[1]?.trim() || "";
    const nationality =
      block.match(/<NATIONALITY>[\s\S]*?<VALUE>([\s\S]*?)<\/VALUE>[\s\S]*?<\/NATIONALITY>/i)?.[1]?.trim() ||
      block.match(/<COUNTRY>([\s\S]*?)<\/COUNTRY>/i)?.[1]?.trim();

    const fullName = [firstName, secondName, thirdName].filter(Boolean).join(" ");
    if (fullName) {
      entries.push({
        name: fullName,
        country: nationality || undefined,
        source: "UN",
        category: "Individual",
        externalId: dataId || `UN-IND-${entries.length + 1}`,
      });
    }
  }

  // Match entities
  const entityRegex = /<ENTITY>([\s\S]*?)<\/ENTITY>/gi;
  while ((match = entityRegex.exec(xmlData)) !== null) {
    const block = match[1];
    const dataId = block.match(/<DATAID>([\s\S]*?)<\/DATAID>/i)?.[1]?.trim() || "";
    const name =
      block.match(/<FIRST_NAME>([\s\S]*?)<\/FIRST_NAME>/i)?.[1]?.trim() || "";
    const country =
      block.match(/<COUNTRY>([\s\S]*?)<\/COUNTRY>/i)?.[1]?.trim();

    if (name) {
      entries.push({
        name,
        country: country || undefined,
        source: "UN",
        category: "Entity",
        externalId: dataId || `UN-ENT-${entries.length + 1}`,
      });
    }
  }

  return entries;
}

/**
 * Parses OFAC XML Consolidated Sanctions feed
 */
export function parseOFACSanctionsXML(xmlData: string): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  const sdnEntryRegex = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/gi;
  let match: RegExpExecArray | null;

  while ((match = sdnEntryRegex.exec(xmlData)) !== null) {
    const block = match[1];
    const uid = block.match(/<uid>([\s\S]*?)<\/uid>/i)?.[1]?.trim() || "";
    const lastName =
      block.match(/<lastName>([\s\S]*?)<\/lastName>/i)?.[1]?.trim() || "";
    const firstName =
      block.match(/<firstName>([\s\S]*?)<\/firstName>/i)?.[1]?.trim() || "";
    const sdnType =
      block.match(/<sdnType>([\s\S]*?)<\/sdnType>/i)?.[1]?.trim() || "Individual";
    const country =
      block.match(/<country>([\s\S]*?)<\/country>/i)?.[1]?.trim();

    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (fullName) {
      entries.push({
        name: fullName,
        country: country || undefined,
        source: "OFAC",
        category: sdnType.toLowerCase().includes("entity") ? "Entity" : "Individual",
        externalId: uid || `OFAC-${entries.length + 1}`,
      });
    }
  }

  return entries;
}

/**
 * Ensures compliance_feed_sync_logs table exists
 */
export async function ensureSyncLogsTable(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS compliance_feed_sync_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_source VARCHAR(50) NOT NULL,
      version VARCHAR(100) NOT NULL,
      records_count INT NOT NULL DEFAULT 0,
      checksum VARCHAR(128) NOT NULL,
      status VARCHAR(50) NOT NULL,
      error_message TEXT,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    );
  `);
}

/**
 * Atomically swaps sanctions entries in Postgres within a single transaction
 * and records synchronization versioning and status into compliance_feed_sync_logs.
 */
export async function atomicSanctionsSwap(
  entries: SanctionsEntry[],
  feedSource: "UN" | "OFAC",
  version: string,
  checksum: string,
): Promise<SyncFeedResult> {
  const client = await pool.connect();
  const startTime = new Date();

  try {
    await client.query("BEGIN");
    await ensureSyncLogsTable(client);

    // Delete previous entries for this feed source atomically
    await client.query("DELETE FROM sanction_list WHERE source = $1", [feedSource]);

    // Insert new entries in batch
    for (const entry of entries) {
      await client.query(
        `INSERT INTO sanction_list (name, country, source, category, external_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [entry.name, entry.country || null, entry.source, entry.category, entry.externalId],
      );
    }

    // Record success in compliance_feed_sync_logs
    await client.query(
      `INSERT INTO compliance_feed_sync_logs (feed_source, version, records_count, checksum, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, 'SUCCESS', $5, CURRENT_TIMESTAMP)`,
      [feedSource, version, entries.length, checksum, startTime],
    );

    await client.query("COMMIT");

    logger.info(
      { feedSource, version, recordsCount: entries.length, checksum },
      "Sanctions feed synchronized atomically",
    );

    return {
      source: feedSource,
      version,
      checksum,
      recordsCount: entries.length,
      status: "SUCCESS",
    };
  } catch (error: any) {
    await client.query("ROLLBACK");

    // Attempt to log failure
    try {
      await client.query(
        `INSERT INTO compliance_feed_sync_logs (feed_source, version, records_count, checksum, status, error_message, started_at, completed_at)
         VALUES ($1, $2, 0, $3, 'FAILED', $4, $5, CURRENT_TIMESTAMP)`,
        [feedSource, version, checksum, error.message, startTime],
      );
    } catch {
      // Ignore logging failure on rollback
    }

    logger.error({ error, feedSource, version }, "Atomic sanctions swap failed");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main orchestrator for daily sanctions delta feed sync
 */
export async function syncSanctionsFeeds(
  options: SyncOptions = {},
): Promise<SyncFeedResult[]> {
  const results: SyncFeedResult[] = [];
  const version =
    options.version || `DAILY-SYNC-${new Date().toISOString().split("T")[0]}`;

  // 1. Sync UN Feed
  if (options.unFeedUrl) {
    try {
      const { data, checksum } = await fetchFeedWithChecksum(
        options.unFeedUrl,
        options.expectedChecksum,
      );
      const entries = parseUNSanctionsXML(data);
      const result = await atomicSanctionsSwap(entries, "UN", version, checksum);
      results.push(result);
    } catch (err: any) {
      results.push({
        source: "UN",
        version,
        checksum: "",
        recordsCount: 0,
        status: "FAILED",
        error: err.message,
      });
    }
  }

  // 2. Sync OFAC Feed
  if (options.ofacFeedUrl) {
    try {
      const { data, checksum } = await fetchFeedWithChecksum(options.ofacFeedUrl);
      const entries = parseOFACSanctionsXML(data);
      const result = await atomicSanctionsSwap(entries, "OFAC", version, checksum);
      results.push(result);
    } catch (err: any) {
      results.push({
        source: "OFAC",
        version,
        checksum: "",
        recordsCount: 0,
        status: "FAILED",
        error: err.message,
      });
    }
  }

  return results;
}

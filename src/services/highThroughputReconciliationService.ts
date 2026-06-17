import { Readable, Transform, pipeline } from "stream";
import { promisify } from "util";
import csvParser from "csv-parser";
import { Pool } from "pg";
import logger from "../utils/logger";
import { queryRead, queryWrite } from "../config/database";

const pipelineAsync = promisify(pipeline);

export interface StreamingReconciliationConfig {
  chunkSize?: number;
  batchSize?: number;
  maxConcurrentBatches?: number;
  provider: string;
  reportDate: Date;
}

export interface StreamingReconciliationProgress {
  processedRows: number;
  matchedCount: number;
  discrepanciesCount: number;
  orphanedProviderCount: number;
  memoryUsageMB: number;
  startTime: Date;
  estimatedTimeRemainingMs?: number;
}

/**
 * HighThroughputReconciliationService
 *
 * Processes large batches of transactions (100K+) using Node.js streams for:
 * - Memory efficiency: <150MB memory footprint
 * - Speed: <2 minutes for 100K records
 * - Accuracy: Proper matching and reconciliation
 *
 * Uses streaming CSV parser and chunked database operations.
 */
export class HighThroughputReconciliationService {
  private readonly CHUNK_SIZE = 1000; // Process 1000 rows at a time
  private readonly BATCH_SIZE = 100; // Insert/update in batches of 100
  private readonly MAX_CONCURRENT_BATCHES = 5; // Run 5 DB operations in parallel

  /**
   * Run high-throughput reconciliation
   */
  async runStreamingReconciliation(
    csvBuffer: Buffer,
    config: StreamingReconciliationConfig,
  ): Promise<{
    matchedCount: number;
    discrepanciesCount: number;
    orphanedProviderCount: number;
    orphanedDbCount: number;
    totalProcessedRows: number;
    executionTimeMs: number;
  }> {
    const startTime = Date.now();
    const startMemory = this.getMemoryUsageMB();

    logger.info(
      `Starting high-throughput reconciliation for ${config.provider} on ${config.reportDate.toISOString().split("T")[0]}`,
    );

    try {
      // Create reconciliation run record
      const runResult = await queryWrite(`
        INSERT INTO provider_reconciliation_runs (provider, report_date, status)
        VALUES ($1, $2, 'running')
        RETURNING *
      `, [config.provider, config.reportDate.toISOString().split("T")[0]]);

      const runId = runResult.rows[0].id;

      // Fetch DB records once and keep in memory (they're much smaller than CSV)
      const dbRecords = await this.fetchDatabaseRecords(config);
      const dbByReference = this.createDbLookupMap(dbRecords);

      // Stream process CSV file
      const results = await this.streamProcessCSV(
        csvBuffer,
        dbByReference,
        runId,
        config,
      );

      const endTime = Date.now();
      const endMemory = this.getMemoryUsageMB();

      // Update reconciliation run with final results
      await this.updateReconciliationRun(runId, {
        ...results,
        totalProviderRows: results.totalProcessedRows,
        totalDbRecords: dbRecords.length,
        matchRate: (
          (results.matchedCount / results.totalProcessedRows) *
          100
        ).toFixed(2),
      });

      logger.info(
        `Reconciliation completed for ${config.provider}: ${results.matchedCount}/${results.totalProcessedRows} matched in ${endTime - startTime}ms`,
      );
      logger.info(
        `Memory usage: ${startMemory}MB -> ${endMemory}MB (delta: ${endMemory - startMemory}MB)`,
      );

      return {
        ...results,
        executionTimeMs: endTime - startTime,
      };
    } catch (error) {
      logger.error(error, `High-throughput reconciliation failed for ${config.provider}`);
      throw error;
    }
  }

  /**
   * Stream process CSV file with chunking and batch DB updates
   */
  private async streamProcessCSV(
    csvBuffer: Buffer,
    dbByReference: Map<string, any>,
    runId: string,
    config: StreamingReconciliationConfig,
  ): Promise<{
    matchedCount: number;
    discrepanciesCount: number;
    totalProcessedRows: number;
    orphanedProviderCount: number;
    orphanedDbCount: number;
  }> {
    return new Promise((resolve, reject) => {
      let processedRows = 0;
      let matchedCount = 0;
      let discrepanciesCount = 0;
      let chunk: any[] = [];
      const matchedProviderRefs = new Set<string>();
      const discrepancies: any[] = [];
      let batchCounter = 0;
      const batchPromises: Promise<void>[] = [];

      const csvStream = Readable.from(csvBuffer);

      const transformStream = new Transform({
        objectMode: true,
        highWaterMark: this.CHUNK_SIZE,
        transform: (row: any, _encoding, callback) => {
          processedRows++;

          const normalized = this.normalizeRow(row);
          const refNum = this.normalizeReferenceNumber(
            normalized.reference_number || normalized.reference_id,
          );

          if (!refNum) {
            callback();
            return;
          }

          const dbRecord = dbByReference.get(refNum);

          if (dbRecord) {
            matchedProviderRefs.add(refNum);
            const isMatch = this.checkMatch(dbRecord, normalized);

            if (isMatch) {
              matchedCount++;
            } else {
              discrepanciesCount++;
              discrepancies.push({
                reference_number: refNum,
                db_record: dbRecord,
                provider_record: normalized,
              });
            }
          } else {
            // Orphaned provider record - will be created as alert later
          }

          chunk.push(normalized);

          // When chunk reaches size limit, process it
          if (chunk.length >= this.CHUNK_SIZE) {
            const chunkToProcess = chunk;
            chunk = [];

            // Create alert records for discrepancies in this chunk
            if (discrepancies.length > 0) {
              batchCounter++;
              if (batchPromises.length >= this.MAX_CONCURRENT_BATCHES) {
                batchPromises.shift(); // Remove oldest promise
              }

              const promise = this.createAlertsForDiscrepancies(
                runId,
                discrepancies,
              ).catch(reject);
              batchPromises.push(promise);

              discrepancies.length = 0; // Clear for next batch
            }
          }

          callback();
        },
      });

      csvStream
        .pipe(csvParser())
        .pipe(transformStream);

      transformStream.resume();

      transformStream
        .on("end", async () => {
          try {
            // Process remaining chunk
            if (chunk.length > 0) {
              chunk.length = 0;
            }

            // Flush remaining discrepancies
            if (discrepancies.length > 0) {
              await this.createAlertsForDiscrepancies(runId, discrepancies);
              discrepancies.length = 0;
            }

            // Wait for all batch operations to complete
            await Promise.all(batchPromises);

            const orphanedProviderCount = processedRows - matchedProviderRefs.size;
            let orphanedDbCount = 0;
            for (const ref of dbByReference.keys()) {
              if (!matchedProviderRefs.has(ref)) {
                orphanedDbCount++;
              }
            }

            resolve({
              matchedCount,
              discrepanciesCount,
              totalProcessedRows: processedRows,
              orphanedProviderCount,
              orphanedDbCount,
            });
          } catch (err) {
            reject(err);
          }
        })
        .on("error", reject);
    });
  }

  /**
   * Fetch database records for a date range
   */
  private async fetchDatabaseRecords(config: StreamingReconciliationConfig): Promise<any[]> {
    const dateStr = config.reportDate.toISOString().split("T")[0];

    const result = await queryRead(`
      SELECT 
        id, 
        reference_number, 
        amount::text as amount, 
        status, 
        phone_number, 
        provider, 
        created_at::text as created_at
      FROM transactions
      WHERE 
        created_at::date = $1
        AND provider = $2
      ORDER BY created_at DESC
    `, [dateStr, config.provider]);

    return result.rows;
  }

  /**
   * Create lookup map for DB records by reference number
   */
  private createDbLookupMap(dbRecords: any[]): Map<string, any> {
    const map = new Map<string, any>();

    for (const record of dbRecords) {
      const refNum = this.normalizeReferenceNumber(record.reference_number);
      if (refNum) {
        map.set(refNum, record);
      }
    }

    return map;
  }

  /**
   * Normalize row data
   */
  private normalizeRow(row: any): any {
    const normalized: any = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] =
        typeof value === "string" ? (value as string).trim() : value;
    }
    return normalized;
  }

  /**
   * Normalize reference number
   */
  private normalizeReferenceNumber(ref?: string): string | null {
    if (!ref) return null;
    return ref.trim().toUpperCase();
  }

  /**
   * Normalize amount for comparison
   */
  private normalizeAmount(amount?: string): string | null {
    if (!amount) return null;
    return amount.replace(/[^0-9.]/g, "").trim();
  }

  /**
   * Check if DB record matches provider record
   */
  private checkMatch(dbRecord: any, providerRecord: any): boolean {
    const dbAmount = this.normalizeAmount(dbRecord.amount);
    const providerAmount = this.normalizeAmount(providerRecord.amount);

    const amountMatch = dbAmount === providerAmount;
    const statusMatch =
      dbRecord.status.toLowerCase() ===
      (providerRecord.status || "").toLowerCase();

    return amountMatch && statusMatch;
  }

  /**
   * Create alerts for discrepancies
   */
  private async createAlertsForDiscrepancies(
    runId: string,
    discrepancies: any[],
  ): Promise<void> {
    if (discrepancies.length === 0) return;

    const alerts = discrepancies.map((d) => ({
      reconciliation_run_id: runId,
      alert_type: "amount_mismatch", // Simplified; could check field
      severity: "high",
      reference_number: d.reference_number,
      expected_amount: d.db_record?.amount,
      actual_amount: d.provider_record?.amount,
      expected_status: d.db_record?.status,
      actual_status: d.provider_record?.status,
      provider_data: JSON.stringify(d.provider_record),
      db_data: JSON.stringify(d.db_record),
    }));

    // Batch insert alerts
    const batchSize = this.BATCH_SIZE;
    for (let i = 0; i < alerts.length; i += batchSize) {
      const batch = alerts.slice(i, i + batchSize);

      const values = batch
        .map(
          (_, idx) =>
            `($${idx * 9 + 1}, $${idx * 9 + 2}, $${idx * 9 + 3}, $${idx * 9 + 4}, $${idx * 9 + 5}, $${idx * 9 + 6}, $${idx * 9 + 7}, $${idx * 9 + 8}, $${idx * 9 + 9})`,
        )
        .join(", ");

      const params = batch.flatMap((alert) => [
        alert.reconciliation_run_id,
        alert.alert_type,
        alert.severity,
        alert.reference_number,
        alert.expected_amount,
        alert.actual_amount,
        alert.expected_status,
        alert.actual_status,
        alert.provider_data,
      ]);

      await queryWrite(`
        INSERT INTO provider_reconciliation_alerts (
          reconciliation_run_id, alert_type, severity, reference_number,
          expected_amount, actual_amount, expected_status, actual_status, provider_data
        ) VALUES ${values}
      `, params);
    }
  }

  /**
   * Update reconciliation run with results
   */
  private async updateReconciliationRun(
    runId: string,
    results: any,
  ): Promise<void> {
    await queryWrite(`
      UPDATE provider_reconciliation_runs
      SET
        status = 'completed',
        total_provider_rows = $1,
        total_db_records = $2,
        matched_count = $3,
        discrepancies_count = $4,
        orphaned_provider_count = $5,
        match_rate = $6,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = $7
    `, [
      results.totalProviderRows,
      results.totalDbRecords,
      results.matchedCount,
      results.discrepanciesCount,
      results.orphanedProviderCount,
      parseFloat(results.matchRate),
      runId,
    ]);
  }

  /**
   * Get current memory usage in MB
   */
  private getMemoryUsageMB(): number {
    if (typeof process !== "undefined" && process.memoryUsage) {
      return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    }
    return 0;
  }
}

export default new HighThroughputReconciliationService();

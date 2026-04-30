import { queryRead, queryWrite } from "../config/database";
import { parseCSV, reconcileTransactions, ProviderCSVRow } from "./csvReconciliation";
import logger from "../utils/logger";
import axios from "axios";

export interface ProviderReportConfig {
  id: string;
  provider: string;
  is_enabled: boolean;
  download_method: 'api' | 'manual'; // Simplified for now
  api_endpoint?: string;
  api_key?: string;
  api_secret?: string;
  report_timezone?: string;
  report_time_format?: string;
}

export interface ReconciliationRun {
  id: string;
  provider: string;
  report_date: string;
  status: 'running' | 'completed' | 'failed';
  total_provider_rows: number;
  total_db_records: number;
  matched_count: number;
  discrepancies_count: number;
  orphaned_provider_count: number;
  orphaned_db_count: number;
  match_rate: number;
  report_file_path?: string;
  error_message?: string;
  started_at: string;
  completed_at?: string;
}

export interface ReconciliationAlert {
  id: string;
  reconciliation_run_id: string;
  transaction_id?: string;
  alert_type: 'amount_mismatch' | 'status_mismatch' | 'orphaned_provider' | 'orphaned_db';
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending_review' | 'reviewed' | 'dismissed' | 'resolved';
  reference_number?: string;
  expected_amount?: number;
  actual_amount?: number;
  expected_status?: string;
  actual_status?: string;
  provider_data?: any;
  db_data?: any;
  review_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;
}

export class ProviderReconciliationService {
  // S3 client removed for simplicity - can be added back later

  /**
   * Get provider report configurations
   */
  async getProviderConfigs(): Promise<ProviderReportConfig[]> {
    const result = await queryRead(`
      SELECT * FROM provider_report_configs
      WHERE is_enabled = true
      ORDER BY provider
    `);

    return result.rows;
  }

  /**
   * Download provider report based on configuration
   */
  async downloadProviderReport(config: ProviderReportConfig, reportDate: Date): Promise<Buffer> {
    switch (config.download_method) {
      case 'api':
        return this.downloadViaAPI(config, reportDate);
      case 'manual':
        throw new Error(`Manual download not supported for automated reconciliation: ${config.provider}`);
      default:
        throw new Error(`Unsupported download method: ${config.download_method}`);
    }
  }

  /**
   * Download report via API
   */
  private async downloadViaAPI(config: ProviderReportConfig, reportDate: Date): Promise<Buffer> {
    if (!config.api_endpoint) {
      throw new Error(`API endpoint not configured for ${config.provider}`);
    }

    const dateStr = reportDate.toISOString().split('T')[0];
    const url = config.api_endpoint.replace('{date}', dateStr);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'X-API-Key': config.api_key,
        'X-API-Secret': config.api_secret,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    return Buffer.from(response.data);
  }

  /**
   * Run reconciliation for a specific provider and date
   */
  async runProviderReconciliation(provider: string, reportDate: Date): Promise<ReconciliationRun> {
    logger.info(`Starting reconciliation for ${provider} on ${reportDate.toISOString().split('T')[0]}`);

    // Create reconciliation run record
    const runResult = await queryWrite(`
      INSERT INTO provider_reconciliation_runs (provider, report_date, status)
      VALUES ($1, $2, 'running')
      RETURNING *
    `, [provider, reportDate.toISOString().split('T')[0]]);

    const reconciliationRun = runResult.rows[0];

    try {
      // Get provider config
      const configResult = await queryRead(`
        SELECT * FROM provider_report_configs WHERE provider = $1 AND is_enabled = true
      `, [provider]);

      if (configResult.rows.length === 0) {
        throw new Error(`No enabled configuration found for provider: ${provider}`);
      }

      const config = configResult.rows[0];

      // Download provider report
      const reportData = await this.downloadProviderReport(config, reportDate);

      // Parse CSV
      const providerRows = await parseCSV(reportData);

      // Run reconciliation
      const dateRange = {
        start: reportDate.toISOString().split('T')[0],
        end: reportDate.toISOString().split('T')[0],
      };

      const result = await reconcileTransactions(providerRows, dateRange);

      // Update reconciliation run with results
      await queryWrite(`
        UPDATE provider_reconciliation_runs
        SET
          status = 'completed',
          total_provider_rows = $1,
          total_db_records = $2,
          matched_count = $3,
          discrepancies_count = $4,
          orphaned_provider_count = $5,
          orphaned_db_count = $6,
          match_rate = $7,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $8
      `, [
        result.total_provider_rows,
        result.total_db_records,
        result.summary.total_matched,
        result.summary.total_discrepancies,
        result.summary.total_orphaned_provider,
        result.summary.total_orphaned_db,
        parseFloat(result.summary.match_rate),
        reconciliationRun.id
      ]);

      // Create alerts for discrepancies
      await this.createReconciliationAlerts(reconciliationRun.id, result);

      logger.info(`Reconciliation completed for ${provider}: ${result.summary.match_rate} match rate`);

      // Return updated run
      const updatedResult = await queryRead(`
        SELECT * FROM provider_reconciliation_runs WHERE id = $1
      `, [reconciliationRun.id]);

      return updatedResult.rows[0];

    } catch (error) {
      // Update run with error
      await queryWrite(`
        UPDATE provider_reconciliation_runs
        SET
          status = 'failed',
          error_message = $1,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [error instanceof Error ? error.message : 'Unknown error', reconciliationRun.id]);

      logger.error(`Reconciliation failed for ${provider}:`, error);
      throw error;
    }
  }

  /**
   * Create alerts for reconciliation discrepancies
   */
  private async createReconciliationAlerts(runId: string, result: any): Promise<void> {
    const alerts: any[] = [];

    // Create alerts for amount/status mismatches
    for (const discrepancy of result.discrepancies) {
      const alertType = discrepancy.amount ? 'amount_mismatch' : 'status_mismatch';
      const severity = Math.abs(discrepancy.amount || 0) > 100 ? 'high' : 'medium';

      alerts.push({
        reconciliation_run_id: runId,
        transaction_id: discrepancy.db_record?.id,
        alert_type: alertType,
        severity,
        reference_number: discrepancy.reference_number,
        expected_amount: discrepancy.db_record?.amount,
        actual_amount: discrepancy.provider_record?.amount,
        expected_status: discrepancy.db_record?.status,
        actual_status: discrepancy.provider_record?.status,
        provider_data: discrepancy.provider_record,
        db_data: discrepancy.db_record,
      });
    }

    // Create alerts for orphaned provider records (transactions in provider report but not in our DB)
    for (const orphaned of result.orphaned_provider) {
      alerts.push({
        reconciliation_run_id: runId,
        alert_type: 'orphaned_provider',
        severity: 'high',
        reference_number: orphaned.reference_number || orphaned.reference_id,
        provider_data: orphaned,
      });
    }

    // Create alerts for orphaned DB records (transactions in our DB but not in provider report)
    for (const orphaned of result.orphaned_db) {
      alerts.push({
        reconciliation_run_id: runId,
        transaction_id: orphaned.id,
        alert_type: 'orphaned_db',
        severity: 'medium',
        reference_number: orphaned.reference_number,
        db_data: orphaned,
      });
    }

    // Insert alerts in batches
    if (alerts.length > 0) {
      const values = alerts.map((_, i) =>
        `($${i * 12 + 1}, $${i * 12 + 2}, $${i * 12 + 3}, $${i * 12 + 4}, $${i * 12 + 5}, $${i * 12 + 6}, $${i * 12 + 7}, $${i * 12 + 8}, $${i * 12 + 9}, $${i * 12 + 10}, $${i * 12 + 11}, $${i * 12 + 12})`
      ).join(', ');

      const params = alerts.flatMap(alert => [
        alert.reconciliation_run_id,
        alert.transaction_id,
        alert.alert_type,
        alert.severity,
        alert.reference_number,
        alert.expected_amount,
        alert.actual_amount,
        alert.expected_status,
        alert.actual_status,
        JSON.stringify(alert.provider_data),
        JSON.stringify(alert.db_data),
        alert.review_notes,
      ]);

      await queryWrite(`
        INSERT INTO provider_reconciliation_alerts (
          reconciliation_run_id, transaction_id, alert_type, severity,
          reference_number, expected_amount, actual_amount, expected_status, actual_status,
          provider_data, db_data, review_notes
        ) VALUES ${values}
      `, params);

      logger.info(`Created ${alerts.length} reconciliation alerts for run ${runId}`);
    }
  }

  /**
   * Get reconciliation alerts that need review
   */
  async getPendingAlerts(limit: number = 50): Promise<ReconciliationAlert[]> {
    const result = await queryRead(`
      SELECT * FROM provider_reconciliation_alerts
      WHERE status = 'pending_review'
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  }

  /**
   * Update alert status after review
   */
  async reviewAlert(alertId: string, status: 'reviewed' | 'dismissed' | 'resolved', reviewNotes: string, reviewedBy: string): Promise<void> {
    await queryWrite(`
      UPDATE provider_reconciliation_alerts
      SET
        status = $1,
        review_notes = $2,
        reviewed_by = $3,
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [status, reviewNotes, reviewedBy, alertId]);
  }

  /**
   * Get reconciliation run history
   */
  async getReconciliationHistory(provider?: string, limit: number = 100): Promise<ReconciliationRun[]> {
    let query = `
      SELECT * FROM provider_reconciliation_runs
      WHERE 1=1
    `;
    const params: any[] = [];

    if (provider) {
      params.push(provider);
      query += ` AND provider = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await queryRead(query, params);
    return result.rows;
  }
}
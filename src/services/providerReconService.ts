import { 
  ReconciliationModel, 
  ReconciliationStatus, 
  DiscrepancyType 
} from "../models/reconciliation";
import { 
  parseCSV, 
  reconcileTransactions, 
  ProviderCSVRow 
} from "./csvReconciliation";
import logger from "../utils/logger";

export class ProviderReconService {
  private reconModel: ReconciliationModel;

  constructor() {
    this.reconModel = new ReconciliationModel();
  }

  /**
   * Run reconciliation for a provider and date
   */
  async runReconciliation(
    provider: string,
    reportDate: Date,
    csvBuffer: Buffer,
    fileName?: string
  ) {
    logger.info(`Starting reconciliation for ${provider} on ${reportDate.toISOString()}`);

    // 1. Create initial report record
    const report = await this.reconModel.createReport({
      provider,
      reportDate,
      fileName,
      status: ReconciliationStatus.Pending,
    });

    try {
      // 2. Parse CSV
      const rows = await parseCSV(csvBuffer);
      
      // 3. Reconcile
      // We fetch transactions for the report date +/- 1 day to catch edge cases
      const start = new Date(reportDate);
      start.setDate(start.getDate() - 1);
      const end = new Date(reportDate);
      end.setDate(end.getDate() + 1);

      const result = await reconcileTransactions(rows, {
        start: start.toISOString(),
        end: end.toISOString(),
      });

      // 4. Save Discrepancies
      for (const disc of result.discrepancies) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          transactionId: disc.db_record?.id,
          referenceNumber: disc.reference_number,
          type: disc.discrepancy_type!,
          expectedValue: `Amount: ${disc.db_record?.amount}, Status: ${disc.db_record?.status}`,
          actualValue: `Amount: ${disc.provider_record?.amount}, Status: ${disc.provider_record?.status}`,
        });
      }

      for (const orphan of result.orphaned_provider) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          referenceNumber: orphan.reference_number || orphan.reference_id || "UNKNOWN",
          type: DiscrepancyType.OrphanedProvider,
          actualValue: JSON.stringify(orphan),
        });
      }

      for (const orphan of result.orphaned_db) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          transactionId: orphan.id,
          referenceNumber: orphan.reference_number,
          type: DiscrepancyType.OrphanedDb,
          expectedValue: JSON.stringify(orphan),
        });
      }

      // 5. Update report status and summary
      await this.reconModel.updateReport(report.id, {
        status: ReconciliationStatus.Completed,
        summary: result.summary,
      });

      logger.info(`Reconciliation completed for ${report.id}. Match rate: ${result.summary.match_rate}`);
      return report.id;

    } catch (error) {
      logger.error({ error, reportId: report.id }, `Reconciliation failed for ${report.id}`);
      await this.reconModel.updateReport(report.id, {
        status: ReconciliationStatus.Failed,
        summary: { error: (error as Error).message },
      });
      throw error;
    }
  }

  /**
   * Mock function to "fetch" a report from a provider.
   * In a real implementation, this would connect to SFTP, S3, or an API.
   */
  async fetchProviderReport(provider: string, date: Date): Promise<Buffer | null> {
    // For now, return null as we don't have real provider credentials/URLs
    // This will be triggered by the manual upload or a scheduled job that is currently mocked
    logger.warn(`Fetch provider report not implemented for ${provider}`);
    return null;
  }
}

/**
 * Scheduled job to run automated daily M-Pesa B2C reconciliation.
 * Resolves Issue #2129.
 */

import {
  MpesaReconciliationEngine,
  MpesaStatementRecord,
  InternalDisbursementRecord,
  ReconciliationSummary,
} from "../services/mobilemoney/mpesaReconciliation";

export class MpesaReconciliationJob {
  private isRunning: boolean = false;

  async runDailyReconciliation(
    statementCsv: string,
    internalRecords: InternalDisbursementRecord[],
    reportDate: string,
  ): Promise<ReconciliationSummary> {
    if (this.isRunning) {
      throw new Error("M-Pesa reconciliation job is already running.");
    }

    try {
      this.isRunning = true;
      const statementRecords: MpesaStatementRecord[] =
        MpesaReconciliationEngine.parseStatementCsv(statementCsv);

      const summary = MpesaReconciliationEngine.reconcile(
        statementRecords,
        internalRecords,
        reportDate,
      );

      return summary;
    } finally {
      this.isRunning = false;
    }
  }
}

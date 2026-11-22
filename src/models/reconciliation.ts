import { queryRead, queryWrite } from "../config/database";
import { withReconciliationDbRetry } from "../services/reconciliationDbRetry";

export enum ReconciliationStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
}

export enum DiscrepancyType {
  AmountMismatch = "amount_mismatch",
  StatusMismatch = "status_mismatch",
  OrphanedDb = "orphaned_db",
  OrphanedProvider = "orphaned_provider",
}

export enum ReviewStatus {
  Pending = "pending",
  Resolved = "resolved",
}

export interface ReconciliationReport {
  id: string;
  provider: string;
  reportDate: Date;
  fileName: string;
  status: ReconciliationStatus;
  summary: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReconciliationReportRow {
  id: string;
  provider: string;
  report_date: Date | string;
  file_name: string | null;
  status: ReconciliationStatus | string;
  summary: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ReconciliationDiscrepancyRow {
  id: string;
  report_id: string;
  transaction_id?: string | null;
  reference_number: string;
  type: DiscrepancyType | string;
  expected_value: string | null;
  actual_value: string | null;
  review_status: ReviewStatus | string;
  resolution_notes?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ReconciliationDiscrepancy {
  id: string;
  reportId: string;
  transactionId?: string;
  referenceNumber: string;
  type: DiscrepancyType;
  expectedValue: string;
  actualValue: string;
  reviewStatus: ReviewStatus;
  resolutionNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class ReconciliationModel {
  async createReport(data: {
    provider: string;
    reportDate: Date;
    fileName?: string;
    status?: ReconciliationStatus;
    summary?: Record<string, unknown>;
  }): Promise<ReconciliationReport> {
    const res = await withReconciliationDbRetry(
      "legacyReconciliation:createReport",
      {
        provider: data.provider,
        reportDate: data.reportDate.toISOString(),
        fileName: data.fileName ?? null,
      },
      () =>
        queryWrite<ReconciliationReportRow>(
          `INSERT INTO reconciliation_reports (provider, report_date, file_name, status, summary)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
          [
            data.provider,
            data.reportDate,
            data.fileName ?? null,
            data.status ?? ReconciliationStatus.Pending,
            JSON.stringify(data.summary ?? {}),
          ],
        ),
    );
    return this.mapReportRow(res.rows[0]);
  }

  async updateReport(
    id: string,
    data: Partial<ReconciliationReport>,
  ): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [id];
    let i = 2;

    if (data.status) {
      fields.push(`status = $${i++}`);
      params.push(data.status);
    }
    if (data.summary) {
      fields.push(`summary = $${i++}`);
      params.push(JSON.stringify(data.summary));
    }
    if (data.fileName) {
      fields.push(`file_name = $${i++}`);
      params.push(data.fileName);
    }

    if (fields.length === 0) return;

    await withReconciliationDbRetry(
      "legacyReconciliation:updateReport",
      {
        reportId: id,
        fields,
      },
      () =>
        queryWrite(
          `UPDATE reconciliation_reports SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $1`,
          params,
        ),
    );
  }

  async createDiscrepancy(data: {
    reportId: string;
    transactionId?: string;
    referenceNumber: string;
    type: DiscrepancyType;
    expectedValue?: string;
    actualValue?: string;
  }): Promise<ReconciliationDiscrepancy> {
    const res = await withReconciliationDbRetry(
      "legacyReconciliation:createDiscrepancy",
      {
        reportId: data.reportId,
        type: data.type,
        referenceNumber: data.referenceNumber,
      },
      () =>
        queryWrite<ReconciliationDiscrepancyRow>(
          `INSERT INTO reconciliation_discrepancies (report_id, transaction_id, reference_number, type, expected_value, actual_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
          [
            data.reportId,
            data.transactionId ?? null,
            data.referenceNumber,
            data.type,
            data.expectedValue ?? null,
            data.actualValue ?? null,
          ],
        ),
    );
    return this.mapDiscrepancyRow(res.rows[0]);
  }

  async getReports(limit = 10, offset = 0): Promise<ReconciliationReport[]> {
    const res = await queryRead<ReconciliationReportRow>(
      `SELECT * FROM reconciliation_reports ORDER BY report_date DESC, created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(this.mapReportRow);
  }

  async getReportById(id: string): Promise<ReconciliationReport | null> {
    const res = await queryRead<ReconciliationReportRow>(
      `SELECT * FROM reconciliation_reports WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.mapReportRow(res.rows[0]) : null;
  }

  async getDiscrepanciesByReportId(
    reportId: string,
  ): Promise<ReconciliationDiscrepancy[]> {
    const res = await queryRead<ReconciliationDiscrepancyRow>(
      `SELECT * FROM reconciliation_discrepancies WHERE report_id = $1 ORDER BY created_at ASC`,
      [reportId],
    );
    return res.rows.map(this.mapDiscrepancyRow);
  }

  async resolveDiscrepancy(id: string, notes: string): Promise<void> {
    await withReconciliationDbRetry(
      "legacyReconciliation:resolveDiscrepancy",
      {
        discrepancyId: id,
      },
      () =>
        queryWrite(
          `UPDATE reconciliation_discrepancies
       SET review_status = 'resolved', resolution_notes = $2, updated_at = NOW()
       WHERE id = $1`,
          [id, notes],
        ),
    );
  }

  private mapReportRow(row: ReconciliationReportRow): ReconciliationReport {
    return {
      id: row.id,
      provider: row.provider,
      reportDate: new Date(row.report_date),
      fileName: row.file_name ?? "",
      status: row.status as ReconciliationStatus,
      summary: row.summary ?? {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapDiscrepancyRow(
    row: ReconciliationDiscrepancyRow,
  ): ReconciliationDiscrepancy {
    return {
      id: row.id,
      reportId: row.report_id,
      transactionId: row.transaction_id ?? undefined,
      referenceNumber: row.reference_number,
      type: row.type as DiscrepancyType,
      expectedValue: row.expected_value ?? "",
      actualValue: row.actual_value ?? "",
      reviewStatus: row.review_status as ReviewStatus,
      resolutionNotes: row.resolution_notes ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

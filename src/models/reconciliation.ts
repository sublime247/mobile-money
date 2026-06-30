import { queryRead, queryWrite } from "../config/database";

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
  summary: any;
  createdAt: Date;
  updatedAt: Date;
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
    summary?: any;
  }): Promise<ReconciliationReport> {
    const res = await queryWrite(
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
    );
    return this.mapReportRow(res.rows[0]);
  }

  async updateReport(
    id: string,
    data: Partial<ReconciliationReport>,
  ): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [id];
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

    await queryWrite(
      `UPDATE reconciliation_reports SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $1`,
      params,
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
    const res = await queryWrite(
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
    );
    return this.mapDiscrepancyRow(res.rows[0]);
  }

  async getReports(limit = 10, offset = 0): Promise<ReconciliationReport[]> {
    const res = await queryRead(
      `SELECT * FROM reconciliation_reports ORDER BY report_date DESC, created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(this.mapReportRow);
  }

  async getReportById(id: string): Promise<ReconciliationReport | null> {
    const res = await queryRead(
      `SELECT * FROM reconciliation_reports WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.mapReportRow(res.rows[0]) : null;
  }

  async getDiscrepanciesByReportId(
    reportId: string,
  ): Promise<ReconciliationDiscrepancy[]> {
    const res = await queryRead(
      `SELECT * FROM reconciliation_discrepancies WHERE report_id = $1 ORDER BY created_at ASC`,
      [reportId],
    );
    return res.rows.map(this.mapDiscrepancyRow);
  }

  async resolveDiscrepancy(id: string, notes: string): Promise<void> {
    await queryWrite(
      `UPDATE reconciliation_discrepancies 
       SET review_status = 'resolved', resolution_notes = $2, updated_at = NOW() 
       WHERE id = $1`,
      [id, notes],
    );
  }

  private mapReportRow(row: any): ReconciliationReport {
    return {
      id: row.id,
      provider: row.provider,
      reportDate: new Date(row.report_date),
      fileName: row.file_name,
      status: row.status,
      summary: row.summary,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapDiscrepancyRow(row: any): ReconciliationDiscrepancy {
    return {
      id: row.id,
      reportId: row.report_id,
      transactionId: row.transaction_id,
      referenceNumber: row.reference_number,
      type: row.type,
      expectedValue: row.expected_value,
      actualValue: row.actual_value,
      reviewStatus: row.review_status,
      resolutionNotes: row.resolution_notes,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

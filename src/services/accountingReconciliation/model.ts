import { queryRead, queryWrite } from "../../config/database";

export enum AccountingReconciliationStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
}

export enum AccountingDiscrepancyType {
  AccountMissingInQBO = "account_missing_in_qbo",
  AccountMissingInXero = "account_missing_in_xero",
  AccountMissingInInternal = "account_missing_in_internal",
  AccountNameMismatch = "account_name_mismatch",
  AccountTypeMismatch = "account_type_mismatch",
  BalanceMismatch = "balance_mismatch",
}

export enum AccountingReviewStatus {
  Pending = "pending",
  Reviewed = "reviewed",
  Resolved = "resolved",
}

export interface AccountingChartOfAccountsReconciliationReport {
  id: string;
  provider: string; // 'quickbooks' or 'xero'
  connectionId: string;
  reportDate: Date;
  status: AccountingReconciliationStatus;
  summary: any;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountingChartOfAccountsReconciliationDiscrepancy {
  id: string;
  reportId: string;
  internalAccountCode?: string;
  internalAccountName?: string;
  internalAccountType?: string;
  externalAccountId?: string;
  externalAccountName?: string;
  externalAccountType?: string;
  type: AccountingDiscrepancyType;
  internalValue?: string;
  externalValue?: string;
  reviewStatus: AccountingReviewStatus;
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class AccountingChartOfAccountsReconciliationModel {
  async createReport(data: {
    provider: string;
    connectionId: string;
    reportDate: Date;
    status?: AccountingReconciliationStatus;
    summary?: any;
  }): Promise<AccountingChartOfAccountsReconciliationReport> {
    const res = await queryWrite(
      `INSERT INTO accounting_chart_of_accounts_reconciliation_reports 
       (provider, connection_id, report_date, status, summary)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.provider,
        data.connectionId,
        data.reportDate,
        data.status ?? AccountingReconciliationStatus.Pending,
        JSON.stringify(data.summary ?? {}),
      ]
    );
    return this.mapReportRow(res.rows[0]);
  }

  async updateReport(id: string, data: Partial<AccountingChartOfAccountsReconciliationReport>): Promise<void> {
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

    if (fields.length === 0) return;

    await queryWrite(
      `UPDATE accounting_chart_of_accounts_reconciliation_reports SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $1`,
      params
    );
  }

  async getReports(limit = 10, offset = 0): Promise<AccountingChartOfAccountsReconciliationReport[]> {
    const res = await queryRead(
      `SELECT * FROM accounting_chart_of_accounts_reconciliation_reports ORDER BY report_date DESC, created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.rows.map(this.mapReportRow);
  }

  async getReportsByConnection(connectionId: string, limit = 10, offset = 0): Promise<AccountingChartOfAccountsReconciliationReport[]> {
    const res = await queryRead(
      `SELECT * FROM accounting_chart_of_accounts_reconciliation_reports WHERE connection_id = $1 ORDER BY report_date DESC, created_at DESC LIMIT $2 OFFSET $3`,
      [connectionId, limit, offset]
    );
    return res.rows.map(this.mapReportRow);
  }

  async getReportById(id: string): Promise<AccountingChartOfAccountsReconciliationReport | null> {
    const res = await queryRead(`SELECT * FROM accounting_chart_of_accounts_reconciliation_reports WHERE id = $1`, [id]);
    return res.rows[0] ? this.mapReportRow(res.rows[0]) : null;
  }

  async createDiscrepancy(data: {
    reportId: string;
    internalAccountCode?: string;
    internalAccountName?: string;
    internalAccountType?: string;
    externalAccountId?: string;
    externalAccountName?: string;
    externalAccountType?: string;
    type: AccountingDiscrepancyType;
    internalValue?: string;
    externalValue?: string;
  }): Promise<AccountingChartOfAccountsReconciliationDiscrepancy> {
    const res = await queryWrite(
      `INSERT INTO accounting_chart_of_accounts_reconciliation_discrepancies 
       (report_id, internal_account_code, internal_account_name, internal_account_type, 
        external_account_id, external_account_name, external_account_type, type, internal_value, external_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.reportId,
        data.internalAccountCode ?? null,
        data.internalAccountName ?? null,
        data.internalAccountType ?? null,
        data.externalAccountId ?? null,
        data.externalAccountName ?? null,
        data.externalAccountType ?? null,
        data.type,
        data.internalValue ?? null,
        data.externalValue ?? null,
      ]
    );
    return this.mapDiscrepancyRow(res.rows[0]);
  }

  async getDiscrepanciesByReportId(reportId: string): Promise<AccountingChartOfAccountsReconciliationDiscrepancy[]> {
    const res = await queryRead(
      `SELECT * FROM accounting_chart_of_accounts_reconciliation_discrepancies WHERE report_id = $1 ORDER BY created_at ASC`,
      [reportId]
    );
    return res.rows.map(this.mapDiscrepancyRow);
  }

  async resolveDiscrepancy(id: string, notes: string, reviewedBy: string): Promise<void> {
    await queryWrite(
      `UPDATE accounting_chart_of_accounts_reconciliation_discrepancies 
       SET review_status = 'resolved', resolution_notes = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW() 
       WHERE id = $1`,
      [id, notes, reviewedBy]
    );
  }

  private mapReportRow(row: any): AccountingChartOfAccountsReconciliationReport {
    return {
      id: row.id,
      provider: row.provider,
      connectionId: row.connection_id,
      reportDate: new Date(row.report_date),
      status: row.status,
      summary: row.summary,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapDiscrepancyRow(row: any): AccountingChartOfAccountsReconciliationDiscrepancy {
    return {
      id: row.id,
      reportId: row.report_id,
      internalAccountCode: row.internal_account_code,
      internalAccountName: row.internal_account_name,
      internalAccountType: row.internal_account_type,
      externalAccountId: row.external_account_id,
      externalAccountName: row.external_account_name,
      externalAccountType: row.external_account_type,
      type: row.type,
      internalValue: row.internal_value,
      externalValue: row.external_value,
      reviewStatus: row.review_status,
      reviewNotes: row.resolution_notes,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

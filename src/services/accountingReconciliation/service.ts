import { LedgerService } from "../../services/ledgerService";
import { AccountingService, AccountingProvider } from "../../services/accounting";
import { 
  AccountingChartOfAccountsReconciliationModel,
  AccountingChartOfAccountsReconciliationReport,
  AccountingChartOfAccountsReconciliationDiscrepancy,
  AccountingReconciliationStatus,
  AccountingDiscrepancyType,
  AccountingReviewStatus
} from "./model";
import { logger } from "../../services/logger";
import axios from "axios";

export class AccountingChartOfAccountsReconciliationService {
  private ledgerService: LedgerService;
  private accountingService: AccountingService;
  private reconModel: AccountingChartOfAccountsReconciliationModel;

  constructor() {
    this.ledgerService = new LedgerService();
    this.accountingService = new AccountingService();
    this.reconModel = new AccountingChartOfAccountsReconciliationModel();
  }

  /**
   * Run daily chart of accounts reconciliation for a provider and connection
   */
  async runDailyReconciliation(
    provider: AccountingProvider,
    connectionId: string,
    reportDate: Date = new Date()
  ): Promise<string> {
    logger.info(`Starting chart of accounts reconciliation for ${provider} connection ${connectionId} on ${reportDate.toISOString()}`);

    // 1. Create initial report record
    const report = await this.reconModel.createReport({
      provider,
      connectionId,
      reportDate,
      status: AccountingReconciliationStatus.Pending,
    });

    try {
      // 2. Get internal trial balance
      const internalTrialBalance = await this.ledgerService.getTrialBalance(reportDate);
      
      // 3. Get external chart of accounts from provider
      const externalChartOfAccounts = await this.getExternalChartOfAccounts(provider, connectionId);
      
      // 4. Reconcile
      const result = await this.reconcileChartOfAccounts(
        internalTrialBalance,
        externalChartOfAccounts,
        provider
      );

      // 5. Save discrepancies
      for (const discrepancy of result.discrepancies) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          ...discrepancy
        });
      }

      // 6. Update report status and summary
      await this.reconModel.updateReport(report.id, {
        status: AccountingReconciliationStatus.Completed,
        summary: result.summary,
      });

      logger.info(`Chart of accounts reconciliation completed for ${report.id}. Match rate: ${result.summary.match_rate}`);
      return report.id;

    } catch (error) {
      logger.error(`Chart of accounts reconciliation failed for ${report.id}:`, error);
      await this.reconModel.updateReport(report.id, {
        status: AccountingReconciliationStatus.Failed,
        summary: { error: (error as Error).message },
      });
      throw error;
    }
  }

  /**
   * Get chart of accounts from external provider (QuickBooks or Xero)
   */
  private async getExternalChartOfAccounts(
    provider: AccountingProvider,
    connectionId: string
  ): Promise<Array<{
    id: string;
    name: string;
    type: string;
    balance?: number;
  }>> {
    const connection = await this.accountingService.getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (provider === AccountingProvider.QUICKBOOKS) {
      return await this.getQuickBooksChartOfAccounts(connection);
    } else if (provider === AccountingProvider.XERO) {
      return await this.getXeroChartOfAccounts(connection);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Get chart of accounts from QuickBooks
   */
  private async getQuickBooksChartOfAccounts(
    connection: any
  ): Promise<Array<{
    id: string;
    name: string;
    type: string;
    balance?: number;
  }>> {
    // Ensure token is valid
    await this.accountingService.ensureConnectionTokenValid(connection.id);
    
    const connectionData = await this.accountingService.getConnection(connection.id);
    if (!connectionData) {
      throw new Error("Connection data not found");
    }

    // Query all accounts from QuickBooks
    const response = await axios.get(
      `https://quickbooks.api.intuit.com/v3/company/${connectionData!.realmId}/query?query=SELECT * FROM Account WHERE Active=true`,
      {
        headers: {
          Authorization: `Bearer ${connectionData!.accessToken}`,
          Accept: "application/json",
        },
      }
    );

    return response.data.QueryResponse.Account.map((account: any) => ({
      id: account.Id,
      name: account.Name,
      type: account.AccountType || account.Classification,
      balance: account.CurrentBalance ? parseFloat(account.CurrentBalance) : undefined,
    }));
  }

  /**
   * Get chart of accounts from Xero
   */
  private async getXeroChartOfAccounts(
    connection: any
  ): Promise<Array<{
    id: string;
    name: string;
    type: string;
    balance?: number;
  }>> {
    // Ensure token is valid
    await this.accountingService.ensureConnectionTokenValid(connection.id);
    
    const connectionData = await this.accountingService.getConnection(connection.id);
    if (!connectionData) {
      throw new Error("Connection data not found");
    }

    // Query all accounts from Xero
    const response = await axios.get(
      "https://api.xero.com/api.xro/2.0/Accounts",
      {
        headers: {
          Authorization: `Bearer ${connectionData!.accessToken}`,
          "Xero-tenant-id": connectionData!.tenantId,
          Accept: "application/json",
        },
      }
    );

    return response.data.Accounts.map((account: any) => ({
      id: account.AccountID,
      name: account.Name,
      type: account.Type,
      balance: account.Balance ? parseFloat(account.Balance) : undefined,
    }));
  }

  /**
   * Reconcile internal trial balance with external chart of accounts
   */
  private async reconcileChartOfAccounts(
    internalAccounts: Array<{
      account_code: string;
      account_name: string;
      account_type: string;
      debit_balance: number;
      credit_balance: number;
    }>,
    externalAccounts: Array<{
      id: string;
      name: string;
      type: string;
      balance?: number;
    }>,
    provider: AccountingProvider
  ): Promise<{
    discrepancies: Array<Omit<AccountingChartOfAccountsReconciliationDiscrepancy, "id" | "reportId" | "createdAt" | "updatedAt">>;
    summary: {
      match_rate: string;
      total_internal_accounts: number;
      total_external_accounts: number;
      total_matched: number;
      total_discrepancies: number;
      total_account_missing_in_internal: number;
      total_account_missing_in_qbo: number;
      total_account_missing_in_xero: number;
      total_name_mismatch: number;
      total_type_mismatch: number;
      total_balance_mismatch: number;
    };
  }> {
    const discrepancies: Array<Omit<AccountingChartOfAccountsReconciliationDiscrepancy, "id" | "reportId" | "createdAt" | "updatedAt">> = [];
    
    // Create lookup maps
    const internalByCode = new Map();
    for (const acc of internalAccounts) {
      internalByCode.set(acc.account_code, acc);
    }
    
    const externalById = new Map();
    for (const acc of externalAccounts) {
      externalById.set(acc.id, acc);
    }
    
    const matchedInternalCodes = new Set<string>();
    const matchedExternalIds = new Set<string>();

    // Check internal accounts against external
    for (const [code, internalAccount] of internalByCode.entries()) {
      const externalAccount = externalById.get(code); // Assuming account code maps to external ID
      
      if (externalAccount) {
        matchedInternalCodes.add(code);
        matchedExternalIds.add(externalAccount.id);
        
        // Check for name mismatch
        if (internalAccount.account_name !== externalAccount.name) {
          discrepancies.push({
            internalAccountCode: internalAccount.account_code,
            internalAccountName: internalAccount.account_name,
            internalAccountType: internalAccount.account_type,
            externalAccountId: externalAccount.id,
            externalAccountName: externalAccount.name,
            externalAccountType: externalAccount.type,
            type: AccountingDiscrepancyType.AccountNameMismatch,
            internalValue: internalAccount.account_name,
            externalValue: externalAccount.name,
            reviewStatus: AccountingReviewStatus.Pending,
          });
        }
        
        // Check for type mismatch
        if (internalAccount.account_type !== externalAccount.type) {
          discrepancies.push({
            internalAccountCode: internalAccount.account_code,
            internalAccountName: internalAccount.account_name,
            internalAccountType: internalAccount.account_type,
            externalAccountId: externalAccount.id,
            externalAccountName: externalAccount.name,
            externalAccountType: externalAccount.type,
            type: AccountingDiscrepancyType.AccountTypeMismatch,
            internalValue: internalAccount.account_type,
            externalValue: externalAccount.type,
            reviewStatus: AccountingReviewStatus.Pending,
          });
        }
        
        // Check for balance mismatch (if both have balances)
        if (externalAccount.balance !== undefined) {
          const internalBalance = internalAccount.debit_balance - internalAccount.credit_balance;
          if (Math.abs(internalBalance - externalAccount.balance) > 0.01) {
            discrepancies.push({
              internalAccountCode: internalAccount.account_code,
              internalAccountName: internalAccount.account_name,
              internalAccountType: internalAccount.account_type,
              externalAccountId: externalAccount.id,
              externalAccountName: externalAccount.name,
              externalAccountType: externalAccount.type,
              type: AccountingDiscrepancyType.BalanceMismatch,
              internalValue: internalBalance.toString(),
              externalValue: externalAccount.balance.toString(),
              reviewStatus: AccountingReviewStatus.Pending,
            });
          }
        }
      } else {
        // Account missing in external system
        discrepancies.push({
          internalAccountCode: internalAccount.account_code,
          internalAccountName: internalAccount.account_name,
          internalAccountType: internalAccount.account_type,
          type: 
            provider === AccountingProvider.QUICKBOOKS 
              ? AccountingDiscrepancyType.AccountMissingInQBO
              : AccountingDiscrepancyType.AccountMissingInXero,
          internalValue: JSON.stringify({
            code: internalAccount.account_code,
            name: internalAccount.account_name,
            type: internalAccount.account_type,
            balance: (internalAccount.debit_balance - internalAccount.credit_balance).toString()
          }),
          externalValue: "",
          reviewStatus: AccountingReviewStatus.Pending,
        });
      }
    }

    // Check for accounts in external system but not in internal
    for (const [id, externalAccount] of externalById.entries()) {
      if (!matchedExternalIds.has(id)) {
        // Try to find by name if not found by ID
        let internalMatch = null;
        for (const [code, internalAccount] of internalByCode.entries()) {
          if (internalAccount.account_name === externalAccount.name) {
            internalMatch = internalAccount;
            matchedInternalCodes.add(code);
            break;
          }
        }
        
        if (!internalMatch) {
          // Account truly missing in internal system
          discrepancies.push({
            externalAccountId: externalAccount.id,
            externalAccountName: externalAccount.name,
            externalAccountType: externalAccount.type,
            type: AccountingDiscrepancyType.AccountMissingInInternal,
            internalValue: "",
            externalValue: JSON.stringify({
              id: externalAccount.id,
              name: externalAccount.name,
              type: externalAccount.type,
              balance: externalAccount.balance?.toString() || "0"
            }),
            reviewStatus: AccountingReviewStatus.Pending,
          });
        } else {
          // Found by name, check for ID mismatch (this would be caught above as name match but different code)
          // For now, we'll treat this as a potential mapping issue but not count as discrepancy
          // since account names should be unique
        }
      }
    }

    // Calculate summary
    const totalInternalAccounts = internalAccounts.length;
    const totalExternalAccounts = externalAccounts.length;
    const totalMatched = matchedInternalCodes.size;
    const totalDiscrepancies = discrepancies.length;
    
    // Count discrepancies by type
    const typeCounts: Record<string, number> = {};
    for (const disc of discrepancies) {
      typeCounts[disc.type] = (typeCounts[disc.type] || 0) + 1;
    }
    
    const matchRate = totalExternalAccounts > 0 
      ? ((totalMatched / totalExternalAccounts) * 100).toFixed(2) 
      : "0.00";

    const summary = {
      match_rate: `${matchRate}%`,
      total_internal_accounts: totalInternalAccounts,
      total_external_accounts: totalExternalAccounts,
      total_matched: totalMatched,
      total_discrepancies: totalDiscrepancies,
      total_account_missing_in_internal: typeCounts[AccountingDiscrepancyType.AccountMissingInInternal] || 0,
      total_account_missing_in_qbo: typeCounts[AccountingDiscrepancyType.AccountMissingInQBO] || 0,
      total_account_missing_in_xero: typeCounts[AccountingDiscrepancyType.AccountMissingInXero] || 0,
      total_name_mismatch: typeCounts[AccountingDiscrepancyType.AccountNameMismatch] || 0,
      total_type_mismatch: typeCounts[AccountingDiscrepancyType.AccountTypeMismatch] || 0,
      total_balance_mismatch: typeCounts[AccountingDiscrepancyType.BalanceMismatch] || 0,
    };

    return { discrepancies, summary };
  }
  
  /**
   * Get reports for a specific connection
   */
  async getReportsByConnection(connectionId: string, limit = 10, offset = 0): Promise<AccountingChartOfAccountsReconciliationReport[]> {
    return await this.reconModel.getReportsByConnection(connectionId, limit, offset);
  }

  /**
   * Get report by ID
   */
  async getReportById(id: string): Promise<AccountingChartOfAccountsReconciliationReport | null> {
    return await this.reconModel.getReportById(id);
  }

  /**
   * Get discrepancies by report ID
   */
  async getDiscrepanciesByReportId(reportId: string): Promise<AccountingChartOfAccountsReconciliationDiscrepancy[]> {
    return await this.reconModel.getDiscrepanciesByReportId(reportId);
  }

  /**
   * Get all reports (with optional filtering)
   */
  async getReports(limit = 10, offset = 0): Promise<AccountingChartOfAccountsReconciliationReport[]> {
    return await this.reconModel.getReports(limit, offset);
  }

  /**
   * Run daily reconciliation for all active connections
   */
  async runAllActiveReconciliations(reportDate: Date = new Date()): Promise<void> {
    const activeConnections = await this.accountingService.getAllActiveConnections();
    logger.info(`Running daily reconciliation for ${activeConnections.length} active connections`);

    for (const connection of activeConnections) {
      try {
        await this.runDailyReconciliation(
          connection.provider,
          connection.id,
          reportDate
        );
      } catch (error) {
        logger.error(`Failed to run reconciliation for connection ${connection.id}:`, error);
        // Continue with other connections
      }
    }
  }

  /**
   * Export reconciliation report to CSV
   */
  async exportReportToCSV(reportId: string): Promise<string> {
    const report = await this.reconModel.getReportById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    const discrepancies = await this.reconModel.getDiscrepanciesByReportId(reportId);

    const headers = [
      "Type",
      "Internal Code",
      "Internal Name",
      "Internal Type",
      "External ID",
      "External Name",
      "External Type",
      "Internal Value",
      "External Value",
      "Status",
      "Notes",
    ];

    const rows = discrepancies.map((d) => [
      d.type,
      d.internalAccountCode || "",
      d.internalAccountName || "",
      d.internalAccountType || "",
      d.externalAccountId || "",
      d.externalAccountName || "",
      d.externalAccountType || "",
      d.internalValue || "",
      d.externalValue || "",
      d.reviewStatus,
      d.reviewNotes || "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell.toString().replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    return csvContent;
  }

  /**
   * Resolve a discrepancy
   */
  async resolveDiscrepancy(id: string, notes: string, reviewedBy: string): Promise<void> {
    await this.reconModel.resolveDiscrepancy(id, notes, reviewedBy);
  }
}

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

export enum AccountingProvider {
  QUICKBOOKS = "quickbooks",
  XERO = "xero",
}

export interface AccountingConnection {
  id: string;
  userId: string;
  provider: AccountingProvider;
  realmId?: string; // QuickBooks company ID
  tenantId?: string; // Xero tenant ID
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryMapping {
  id: string;
  connectionId: string;
  mobileMoneyCategory: string;
  accountingCategoryId: string;
  accountingCategoryName: string;
  createdAt: Date;
}

export interface SyncLog {
  id: string;
  connectionId: string;
  syncType: "daily_pnl" | "fee_revenue";
  status: "pending" | "in_progress" | "completed" | "failed";
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  errorMessage?: string;
  syncedAt: Date;
}

export interface PnLData {
  date: string;
  revenue: number;
  fees: number;
  netProfit: number;
  transactions: number;
}

export interface QuickBooksTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  x_refresh_token_expires_in: number;
}

export interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export class AccountingService {
  private readonly quickbooksClientId: string;
  private readonly quickbooksClientSecret: string;
  private readonly quickbooksRedirectUri: string;
  private readonly xeroClientId: string;
  private readonly xeroClientSecret: string;
  private readonly xeroRedirectUri: string;

  constructor() {
    this.quickbooksClientId = process.env.QUICKBOOKS_CLIENT_ID || "";
    this.quickbooksClientSecret = process.env.QUICKBOOKS_CLIENT_SECRET || "";
    this.quickbooksRedirectUri = process.env.QUICKBOOKS_REDIRECT_URI || "";
    this.xeroClientId = process.env.XERO_CLIENT_ID || "";
    this.xeroClientSecret = process.env.XERO_CLIENT_SECRET || "";
    this.xeroRedirectUri = process.env.XERO_REDIRECT_URI || "";
  }

  // OAuth2 Authorization URLs
  getQuickBooksAuthUrl(): string {
    const scopes = [
      "com.intuit.quickbooks.accounting",
      "com.intuit.quickbooks.payment",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: this.quickbooksClientId,
      redirect_uri: this.quickbooksRedirectUri,
      response_type: "code",
      scope: scopes,
      state: uuidv4(),
    });

    return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
  }

  getXeroAuthUrl(): string {
    const scopes = [
      "accounting.transactions",
      "accounting.reports.read",
      "accounting.settings",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: this.xeroClientId,
      redirect_uri: this.xeroRedirectUri,
      response_type: "code",
      scope: scopes,
      state: uuidv4(),
    });

    return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
  }

  // Handle OAuth2 callbacks
  async handleQuickBooksCallback(
    code: string,
    realmId: string,
    userId: string
  ): Promise<AccountingConnection> {
    try {
      const tokenResponse = await this.exchangeQuickBooksCode(code);
      
      const connection: AccountingConnection = {
        id: uuidv4(),
        userId,
        provider: AccountingProvider.QUICKBOOKS,
        realmId,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.saveConnection(connection);
      return connection;
    } catch (error) {
      throw new Error(`QuickBooks OAuth failed: ${error}`);
    }
  }

  async handleXeroCallback(
    code: string,
    userId: string
  ): Promise<AccountingConnection> {
    try {
      const tokenResponse = await this.exchangeXeroCode(code);
      
      // Get tenant information
      const tenants = await this.getXeroTenants(tokenResponse.access_token);
      const tenantId = tenants[0]?.tenantId; // Use first tenant for simplicity

      const connection: AccountingConnection = {
        id: uuidv4(),
        userId,
        provider: AccountingProvider.XERO,
        tenantId,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.saveConnection(connection);
      return connection;
    } catch (error) {
      throw new Error(`Xero OAuth failed: ${error}`);
    }
  }

  // Exchange authorization code for tokens
  private async exchangeQuickBooksCode(code: string): Promise<QuickBooksTokenResponse> {
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.quickbooksRedirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${this.quickbooksClientId}:${this.quickbooksClientSecret}`
          ).toString("base64")}`,
        },
      }
    );

    return response.data;
  }

  private async exchangeXeroCode(code: string): Promise<XeroTokenResponse> {
    const response = await axios.post(
      "https://identity.xero.com/connect/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.xeroRedirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${this.xeroClientId}:${this.xeroClientSecret}`
          ).toString("base64")}`,
        },
      }
    );

    return response.data;
  }

  // Get Xero tenants
  private async getXeroTenants(accessToken: string): Promise<Array<{ tenantId: string }>> {
    const response = await axios.get("https://api.xero.com/connections", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    return response.data;
  }

  // Refresh access tokens
  async refreshQuickBooksToken(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    if (!connection || connection.provider !== AccountingProvider.QUICKBOOKS) {
      throw new Error("QuickBooks connection not found");
    }

    try {
      const response = await axios.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.refreshToken,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(
              `${this.quickbooksClientId}:${this.quickbooksClientSecret}`
            ).toString("base64")}`,
          },
        }
      );

      await this.updateConnectionTokens(connectionId, {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
      });
    } catch (error) {
      throw new Error(`QuickBooks token refresh failed: ${error}`);
    }
  }

  async refreshXeroToken(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    if (!connection || connection.provider !== AccountingProvider.XERO) {
      throw new Error("Xero connection not found");
    }

    try {
      const response = await axios.post(
        "https://identity.xero.com/connect/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.refreshToken,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(
              `${this.xeroClientId}:${this.xeroClientSecret}`
            ).toString("base64")}`,
          },
        }
      );

      await this.updateConnectionTokens(connectionId, {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
      });
    } catch (error) {
      throw new Error(`Xero token refresh failed: ${error}`);
    }
  }

  // Category mapping
  async createCategoryMapping(
    connectionId: string,
    mobileMoneyCategory: string,
    accountingCategoryId: string,
    accountingCategoryName: string
  ): Promise<CategoryMapping> {
    const mapping: CategoryMapping = {
      id: uuidv4(),
      connectionId,
      mobileMoneyCategory,
      accountingCategoryId,
      accountingCategoryName,
      createdAt: new Date(),
    };

    await pool.query(
      `INSERT INTO category_mappings (id, connection_id, mobile_money_category, accounting_category_id, accounting_category_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [mapping.id, mapping.connectionId, mapping.mobileMoneyCategory, mapping.accountingCategoryId, mapping.accountingCategoryName, mapping.createdAt]
    );

    return mapping;
  }

  async getCategoryMappings(connectionId: string): Promise<CategoryMapping[]> {
    const result = await pool.query(
      "SELECT * FROM category_mappings WHERE connection_id = $1 ORDER BY mobile_money_category",
      [connectionId]
    );

    return result.rows;
  }

  async getAccountingCategories(connectionId: string): Promise<Array<{ id: string; name: string }>> {
    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (connection.provider === AccountingProvider.QUICKBOOKS) {
      return this.getQuickBooksCategories(connection);
    } else if (connection.provider === AccountingProvider.XERO) {
      return this.getXeroCategories(connection);
    }

    throw new Error("Unsupported provider");
  }

  private async getQuickBooksCategories(connection: AccountingConnection): Promise<Array<{ id: string; name: string }>> {
    await this.ensureValidToken(connection.id);

    const connectionData = await this.getConnection(connection.id);
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
    }));
  }

  private async getXeroCategories(connection: AccountingConnection): Promise<Array<{ id: string; name: string }>> {
    await this.ensureValidToken(connection.id);

    const connectionData = await this.getConnection(connection.id);
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
    }));
  }

  // Sync functions
  async syncDailyPnL(connectionId: string, date: string): Promise<SyncLog> {
    const syncLog: SyncLog = {
      id: uuidv4(),
      connectionId,
      syncType: "daily_pnl",
      status: "in_progress",
      recordsProcessed: 0,
      recordsSucceeded: 0,
      recordsFailed: 0,
      syncedAt: new Date(),
    };

    await this.createSyncLog(syncLog);

    try {
      const connection = await this.getConnection(connectionId);
      if (!connection) {
        throw new Error("Connection not found");
      }

      await this.ensureValidToken(connectionId);

      // Get PnL data for the date
      const pnlData = await this.getPnLData(date);
      
      if (connection.provider === AccountingProvider.QUICKBOOKS) {
        await this.syncPnLToQuickBooks(connection, pnlData, syncLog);
      } else if (connection.provider === AccountingProvider.XERO) {
        await this.syncPnLToXero(connection, pnlData, syncLog);
      }

      syncLog.status = "completed";
      await this.updateSyncLog(syncLog);
    } catch (error) {
      syncLog.status = "failed";
      syncLog.errorMessage = error instanceof Error ? error.message : "Unknown error";
      await this.updateSyncLog(syncLog);
    }

    return syncLog;
  }

  async syncFeeRevenue(connectionId: string, date: string): Promise<SyncLog> {
    const syncLog: SyncLog = {
      id: uuidv4(),
      connectionId,
      syncType: "fee_revenue",
      status: "in_progress",
      recordsProcessed: 0,
      recordsSucceeded: 0,
      recordsFailed: 0,
      syncedAt: new Date(),
    };

    await this.createSyncLog(syncLog);

    try {
      const connection = await this.getConnection(connectionId);
      if (!connection) {
        throw new Error("Connection not found");
      }

      await this.ensureValidToken(connectionId);

      // Get fee revenue data for the date
      const feeData = await this.getFeeRevenueData(date);
      
      if (connection.provider === AccountingProvider.QUICKBOOKS) {
        await this.syncFeeRevenueToQuickBooks(connection, feeData, syncLog);
      } else if (connection.provider === AccountingProvider.XERO) {
        await this.syncFeeRevenueToXero(connection, feeData, syncLog);
      }

      syncLog.status = "completed";
      await this.updateSyncLog(syncLog);
    } catch (error) {
      syncLog.status = "failed";
      syncLog.errorMessage = error instanceof Error ? error.message : "Unknown error";
      await this.updateSyncLog(syncLog);
    }

    return syncLog;
  }

  // Database operations
  private async saveConnection(connection: AccountingConnection): Promise<void> {
    await pool.query(
      `INSERT INTO accounting_connections 
       (id, user_id, provider, realm_id, tenant_id, access_token, refresh_token, expires_at, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at`,
      [
        connection.id,
        connection.userId,
        connection.provider,
        connection.realmId,
        connection.tenantId,
        connection.accessToken,
        connection.refreshToken,
        connection.expiresAt,
        connection.isActive,
        connection.createdAt,
        connection.updatedAt,
      ]
    );
  }

  private async updateConnectionTokens(
    connectionId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: Date }
  ): Promise<void> {
    await pool.query(
      "UPDATE accounting_connections SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = $4 WHERE id = $5",
      [tokens.accessToken, tokens.refreshToken, tokens.expiresAt, new Date(), connectionId]
    );
  }

  async getConnection(connectionId: string): Promise<AccountingConnection | null> {
    const result = await pool.query(
      "SELECT * FROM accounting_connections WHERE id = $1",
      [connectionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async getUserConnections(userId: string): Promise<AccountingConnection[]> {
    const result = await pool.query(
      "SELECT * FROM accounting_connections WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC",
      [userId]
    );

    return result.rows;
  }

  private async createSyncLog(syncLog: SyncLog): Promise<void> {
    await pool.query(
      `INSERT INTO sync_logs 
       (id, connection_id, sync_type, status, records_processed, records_succeeded, records_failed, error_message, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        syncLog.id,
        syncLog.connectionId,
        syncLog.syncType,
        syncLog.status,
        syncLog.recordsProcessed,
        syncLog.recordsSucceeded,
        syncLog.recordsFailed,
        syncLog.errorMessage,
        syncLog.syncedAt,
      ]
    );
  }

  private async updateSyncLog(syncLog: SyncLog): Promise<void> {
    await pool.query(
      `UPDATE sync_logs SET 
       status = $1, records_processed = $2, records_succeeded = $3, records_failed = $4, error_message = $5
       WHERE id = $6`,
      [
        syncLog.status,
        syncLog.recordsProcessed,
        syncLog.recordsSucceeded,
        syncLog.recordsFailed,
        syncLog.errorMessage,
        syncLog.id,
      ]
    );
  }

  async getSyncLogs(connectionId: string, limit: number = 50): Promise<SyncLog[]> {
    const result = await pool.query(
      "SELECT * FROM sync_logs WHERE connection_id = $1 ORDER BY synced_at DESC LIMIT $2",
      [connectionId, limit]
    );

    return result.rows;
  }

  // Helper functions
  private async ensureValidToken(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (new Date() >= connection.expiresAt) {
      if (connection.provider === AccountingProvider.QUICKBOOKS) {
        await this.refreshQuickBooksToken(connectionId);
      } else if (connection.provider === AccountingProvider.XERO) {
        await this.refreshXeroToken(connectionId);
      }
    }
  }

  private async getPnLData(date: string): Promise<PnLData> {
    // Calculate PnL data from transactions
    const query = `
      SELECT 
        COUNT(*) as transactions,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) as revenue,
        COALESCE(SUM(fee), 0) as fees
      FROM transactions 
      WHERE DATE(created_at) = $1 
      AND status = 'completed'
    `;

    const result = await pool.query(query, [date]);
    const { transactions, revenue, fees } = result.rows[0];

    return {
      date,
      revenue: parseFloat(revenue),
      fees: parseFloat(fees),
      netProfit: parseFloat(revenue) - parseFloat(fees),
      transactions: parseInt(transactions),
    };
  }

  private async getFeeRevenueData(date: string): Promise<{ category: string; amount: number }[]> {
    // Get fee revenue broken down by category
    const query = `
      SELECT 
        fee_category,
        SUM(fee) as amount
      FROM transactions 
      WHERE DATE(created_at) = $1 
      AND status = 'completed'
      AND fee > 0
      GROUP BY fee_category
      ORDER BY amount DESC
    `;

    const result = await pool.query(query, [date]);
    return result.rows.map(row => ({
      category: row.fee_category || 'General Fees',
      amount: parseFloat(row.amount),
    }));
  }

  // Provider-specific sync implementations
  private async syncPnLToQuickBooks(
    connection: AccountingConnection,
    pnlData: PnLData,
    syncLog: SyncLog
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    // Create journal entry for PnL
    const journalEntry = {
      TxnDate: pnlData.date,
      Line: [
        {
          Description: `Daily P&L - ${pnlData.date}`,
          Amount: pnlData.revenue,
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: this.getMappedCategory(mappings, "revenue") || { value: "1" }, // Default to Sales
          },
        },
        {
          Description: `Daily Fees - ${pnlData.date}`,
          Amount: pnlData.fees,
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: this.getMappedCategory(mappings, "fees") || { value: "4" }, // Default to Expense
          },
        },
      ],
    };

    try {
      await axios.post(
        `https://quickbooks.api.intuit.com/v3/company/${connectionData!.realmId}/journalentry`,
        journalEntry,
        {
          headers: {
            Authorization: `Bearer ${connectionData!.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      syncLog.recordsProcessed = 1;
      syncLog.recordsSucceeded = 1;
    } catch (error) {
      syncLog.recordsProcessed = 1;
      syncLog.recordsFailed = 1;
      throw error;
    }
  }

  private async syncPnLToXero(
    connection: AccountingConnection,
    pnlData: PnLData,
    syncLog: SyncLog
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    // Create manual journal entry for PnL
    const journalEntry = {
      Date: pnlData.date,
      JournalLines: [
        {
          Description: `Daily P&L - ${pnlData.date}`,
          CreditAmount: pnlData.revenue,
          AccountID: this.getMappedCategory(mappings, "revenue") || "1", // Default to Sales
        },
        {
          Description: `Daily Fees - ${pnlData.date}`,
          DebitAmount: pnlData.fees,
          AccountID: this.getMappedCategory(mappings, "fees") || "4", // Default to Expense
        },
      ],
    };

    try {
      await axios.put(
        "https://api.xero.com/api.xro/2.0/ManualJournals",
        journalEntry,
        {
          headers: {
            Authorization: `Bearer ${connectionData!.accessToken}`,
            "Xero-tenant-id": connectionData!.tenantId,
            "Content-Type": "application/json",
          },
        }
      );

      syncLog.recordsProcessed = 1;
      syncLog.recordsSucceeded = 1;
    } catch (error) {
      syncLog.recordsProcessed = 1;
      syncLog.recordsFailed = 1;
      throw error;
    }
  }

  private async syncFeeRevenueToQuickBooks(
    connection: AccountingConnection,
    feeData: Array<{ category: string; amount: number }>,
    syncLog: SyncLog
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    const lines = feeData.map(fee => ({
      Description: `Fee Revenue - ${fee.category}`,
      Amount: fee.amount,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: "Credit",
        AccountRef: this.getMappedCategory(mappings, fee.category) || { value: "1" },
      },
    }));

    const journalEntry = {
      TxnDate: new Date().toISOString().split('T')[0],
      Line: lines,
    };

    try {
      await axios.post(
        `https://quickbooks.api.intuit.com/v3/company/${connectionData!.realmId}/journalentry`,
        journalEntry,
        {
          headers: {
            Authorization: `Bearer ${connectionData!.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsSucceeded = feeData.length;
    } catch (error) {
      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsFailed = feeData.length;
      throw error;
    }
  }

  private async syncFeeRevenueToXero(
    connection: AccountingConnection,
    feeData: Array<{ category: string; amount: number }>,
    syncLog: SyncLog
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    const journalLines = feeData.map(fee => ({
      Description: `Fee Revenue - ${fee.category}`,
      CreditAmount: fee.amount,
      AccountID: this.getMappedCategory(mappings, fee.category) || "1",
    }));

    const journalEntry = {
      Date: new Date().toISOString().split('T')[0],
      JournalLines: journalLines,
    };

    try {
      await axios.put(
        "https://api.xero.com/api.xro/2.0/ManualJournals",
        journalEntry,
        {
          headers: {
            Authorization: `Bearer ${connectionData!.accessToken}`,
            "Xero-tenant-id": connectionData!.tenantId,
            "Content-Type": "application/json",
          },
        }
      );

      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsSucceeded = feeData.length;
    } catch (error) {
      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsFailed = feeData.length;
      throw error;
    }
  }

  private getMappedCategory(mappings: CategoryMapping[], mobileMoneyCategory: string): string | null {
    const mapping = mappings.find(m => m.mobileMoneyCategory === mobileMoneyCategory);
    return mapping ? mapping.accountingCategoryId : null;
  }
}

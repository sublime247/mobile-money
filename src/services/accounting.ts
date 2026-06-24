import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { encryptField, decryptField, decrypt } from "../utils/encryption";
import {
  addAccountingTokenRefreshJob,
  removeAccountingTokenRefreshJob,
} from "../queue/accountingTokenRefreshQueue";
import logger from "../utils/logger";

export enum AccountingProvider {
  QUICKBOOKS = "quickbooks",
  XERO = "xero",
}

export interface AccountingConnection {
  id: string;
  userId: string;
  provider: AccountingProvider;
  realmId?: string; // QuickBooks company ID
  tenantId?: string; // Xero tenant ID (active organization)
  tenantName?: string; // Xero organization name (for display / selection)
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

/**
 * A single Xero "connection" as returned by GET https://api.xero.com/connections.
 * Each entry represents one organization (tenant) the user authorized.
 */
export interface XeroTenant {
  id?: string; // connection id
  tenantId: string;
  tenantName?: string;
  tenantType?: string;
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
  getQuickBooksAuthUrl(state: string = uuidv4()): string {
    const scopes = [
      "com.intuit.quickbooks.accounting",
      "com.intuit.quickbooks.payment",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: this.quickbooksClientId,
      redirect_uri: this.quickbooksRedirectUri,
      response_type: "code",
      scope: scopes,
      state,
    });

    return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
  }

  /**
   * Build the Xero OAuth 2.0 authorization URL.
   *
   * `offline_access` is required for Xero to return a refresh token, and the
   * `state` value is used for CSRF protection + to re-associate the headerless
   * browser callback with the user who started the flow. When no state is
   * supplied a random one is generated so existing callers keep working.
   */
  getXeroAuthUrl(state?: string): string {
    const scopes = [
      "offline_access",
      "openid",
      "profile",
      "email",
      "accounting.transactions",
      "accounting.reports.read",
      "accounting.settings",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: this.xeroClientId,
      redirect_uri: this.xeroRedirectUri,
      response_type: "code",
      scope: scopes,
      state: state || uuidv4(),
    });

    return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
  }

  // Handle OAuth2 callbacks
  async handleQuickBooksCallback(
    code: string,
    realmId: string,
    userId: string,
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
      await this.scheduleTokenRefresh(connection);

      return connection;
    } catch (error) {
      logger.error(`QuickBooks OAuth callback failed: ${error}`);
      throw new Error(`QuickBooks OAuth failed: ${error}`);
    }
  }

  async handleXeroCallback(
    code: string,
    userId: string,
    selectedTenantId?: string,
  ): Promise<AccountingConnection> {
    try {
      const tokenResponse = await this.exchangeXeroCode(code);

      // Resolve the tenant (organization) this token grants access to. A single
      // Xero login can be connected to multiple organizations, so we must fetch
      // the live list of authorized tenants and pick the right one.
      const tenants = await this.getXeroTenants(tokenResponse.access_token);

      if (!tenants || tenants.length === 0) {
        throw new Error(
          "No Xero organizations are connected to this login. " +
            "Please authorize at least one organization and try again.",
        );
      }

      // If the caller didn't select a specific tenant, create a connection
      // record for each authorized tenant so the user can sync per-organization.
      // All created connections share the same OAuth tokens and must be kept
      // in sync when a refresh occurs.
      const createdConnections: AccountingConnection[] = [];

      const tenantsToCreate = selectedTenantId
        ? [this.resolveActiveXeroTenant(tenants, selectedTenantId)]
        : tenants;

      for (const t of tenantsToCreate) {
        const conn: AccountingConnection = {
          id: uuidv4(),
          userId,
          provider: AccountingProvider.XERO,
          tenantId: t.tenantId,
          tenantName: t.tenantName,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await this.saveConnection(conn);
        await this.scheduleTokenRefresh(conn);
        createdConnections.push(conn);
      }

      // Return the first created connection for compatibility with callers
      return createdConnections[0];
    } catch (error) {
      logger.error(`Xero OAuth callback failed: ${error}`);
      throw new Error(`Xero OAuth failed: ${error}`);
    }
  }

  /**
   * Expose the list of Xero organizations (tenants) associated with an
   * authorization code. Useful when the front-end wants to let the user pick
   * which organization to connect before finalizing the connection.
   */
  async listXeroTenantsFromCode(code: string): Promise<XeroTenant[]> {
    const tokenResponse = await this.exchangeXeroCode(code);
    return this.getXeroTenants(tokenResponse.access_token);
  }

  /**
   * Pick the active tenant from the list returned by Xero.
   *
   * - When the caller explicitly selects a tenant we honor it (multi-tenant
   *   selection), but only if it is actually present in the authorized list.
   * - Otherwise we default to the first authorized organization.
   */
  private resolveActiveXeroTenant(
    tenants: XeroTenant[],
    selectedTenantId?: string,
  ): XeroTenant {
    if (selectedTenantId) {
      const match = tenants.find((t) => t.tenantId === selectedTenantId);
      if (!match) {
        throw new Error(
          `Selected Xero tenant "${selectedTenantId}" is not among the authorized organizations.`,
        );
      }
      return match;
    }
    return tenants[0];
  }

  private async scheduleTokenRefresh(
    connection: AccountingConnection,
  ): Promise<void> {
    // Refresh 10 minutes before expiry
    const refreshBufferMs = 10 * 60 * 1000;
    const delayMs =
      connection.expiresAt.getTime() - Date.now() - refreshBufferMs;

    // If token is already expired or expires very soon, refresh immediately (small delay for safety)
    const finalDelayMs = Math.max(5000, delayMs);

    await removeAccountingTokenRefreshJob(connection.id);
    await addAccountingTokenRefreshJob(
      connection.id,
      connection.provider,
      finalDelayMs,
    );

    logger.info(
      `Scheduled token refresh for connection ${connection.id} in ${finalDelayMs}ms`,
    );
  }

  // Exchange authorization code for tokens
  private async exchangeQuickBooksCode(
    code: string,
  ): Promise<QuickBooksTokenResponse> {
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
            `${this.quickbooksClientId}:${this.quickbooksClientSecret}`,
          ).toString("base64")}`,
        },
      },
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
            `${this.xeroClientId}:${this.xeroClientSecret}`,
          ).toString("base64")}`,
        },
      },
    );

    return response.data;
  }

  // Get Xero tenants (organizations) authorized for this access token.
  private async getXeroTenants(accessToken: string): Promise<XeroTenant[]> {
    const response = await axios.get("https://api.xero.com/connections", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const raw = Array.isArray(response.data) ? response.data : [];

    // Normalize the Xero connections payload into our XeroTenant shape. The
    // Xero API returns objects like:
    //   { id, tenantId, tenantType, tenantName, ... }
    return raw
      .map((entry: any) => ({
        id: entry.id,
        tenantId: entry.tenantId,
        tenantName: entry.tenantName,
        tenantType: entry.tenantType,
      }))
      .filter((t: XeroTenant) => Boolean(t.tenantId));
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
              `${this.quickbooksClientId}:${this.quickbooksClientSecret}`,
            ).toString("base64")}`,
          },
        },
      );

      const updatedConnection: AccountingConnection = {
        ...connection,
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
        updatedAt: new Date(),
      };

      await this.updateConnectionTokens(connectionId, {
        accessToken: updatedConnection.accessToken,
        refreshToken: updatedConnection.refreshToken,
        expiresAt: updatedConnection.expiresAt,
      });

      await this.scheduleTokenRefresh(updatedConnection);
      logger.info(
        `Successfully refreshed QuickBooks token for connection ${connectionId}`,
      );
    } catch (error) {
      logger.error(
        `QuickBooks token refresh failed for ${connectionId}: ${error}`,
      );
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
              `${this.xeroClientId}:${this.xeroClientSecret}`,
            ).toString("base64")}`,
          },
        },
      );
      // When refreshing a Xero token, update all Xero connections for the
      // same user so that multi-tenant connections remain in sync.
      const newAccessToken: string = response.data.access_token;
      const newRefreshToken: string = response.data.refresh_token;
      const newExpiresAt = new Date(Date.now() + response.data.expires_in * 1000);

      // Encrypt tokens for storage
      const encAccess = encryptField(newAccessToken);
      const encRefresh = encryptField(newRefreshToken);

      // Update all accounting_connections rows for this user and provider
      await pool.query(
        `UPDATE accounting_connections SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = $4 WHERE user_id = $5 AND provider = $6`,
        [encAccess, encRefresh, newExpiresAt, new Date(), connection.userId, AccountingProvider.XERO],
      );

      // Reschedule refresh jobs for all active Xero connections for this user
      const updatedConns = await this.getUserConnections(connection.userId);
      const xeroConns = updatedConns.filter((c) => c.provider === AccountingProvider.XERO);

      for (const c of xeroConns) {
        const updatedConn: AccountingConnection = {
          ...c,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          expiresAt: newExpiresAt,
          updatedAt: new Date(),
        };

        await this.scheduleTokenRefresh(updatedConn);
      }

      logger.info(`Successfully refreshed Xero tokens for user ${connection.userId} (${xeroConns.length} connections)`);
    } catch (error) {
      logger.error(`Xero token refresh failed for ${connectionId}: ${error}`);
      throw new Error(`Xero token refresh failed: ${error}`);
    }
  }

  // Category mapping
  async createCategoryMapping(
    connectionId: string,
    mobileMoneyCategory: string,
    accountingCategoryId: string,
    accountingCategoryName: string,
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
      [
        mapping.id,
        mapping.connectionId,
        mapping.mobileMoneyCategory,
        mapping.accountingCategoryId,
        mapping.accountingCategoryName,
        mapping.createdAt,
      ],
    );

    return mapping;
  }

  async getCategoryMappings(connectionId: string): Promise<CategoryMapping[]> {
    const result = await pool.query(
      "SELECT * FROM category_mappings WHERE connection_id = $1 ORDER BY mobile_money_category",
      [connectionId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      mobileMoneyCategory: row.mobile_money_category,
      accountingCategoryId: row.accounting_category_id,
      accountingCategoryName: row.accounting_category_name,
      createdAt: new Date(row.created_at),
    }));
  }

  async getAccountingCategories(
    connectionId: string,
  ): Promise<Array<{ id: string; name: string }>> {
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

  private async getQuickBooksCategories(
    connection: AccountingConnection,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.ensureValidToken(connection.id);

    const connectionData = await this.getConnection(connection.id);
    const response = await axios.get(
      `https://quickbooks.api.intuit.com/v3/company/${connectionData!.realmId}/query?query=SELECT * FROM Account WHERE Active=true`,
      {
        headers: {
          Authorization: `Bearer ${connectionData!.accessToken}`,
          Accept: "application/json",
        },
      },
    );

    return response.data.QueryResponse.Account.map((account: any) => ({
      id: account.Id,
      name: account.Name,
    }));
  }

  private async getXeroCategories(
    connection: AccountingConnection,
  ): Promise<Array<{ id: string; name: string }>> {
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
      },
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
      syncLog.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
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
      syncLog.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await this.updateSyncLog(syncLog);
    }

    return syncLog;
  }

  // Database operations
  private async saveConnection(
    connection: AccountingConnection,
  ): Promise<void> {
    const encryptedAccessToken = encryptField(connection.accessToken);
    const encryptedRefreshToken = encryptField(connection.refreshToken);

    await pool.query(
      `INSERT INTO accounting_connections 
       (id, user_id, provider, realm_id, tenant_id, tenant_name, access_token, refresh_token, expires_at, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       tenant_name = EXCLUDED.tenant_name,
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
        connection.tenantName,
        encryptedAccessToken,
        encryptedRefreshToken,
        connection.expiresAt,
        connection.isActive,
        connection.createdAt,
        connection.updatedAt,
      ],
    );
  }

  private async updateConnectionTokens(
    connectionId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  ): Promise<void> {
    const encryptedAccessToken = encryptField(tokens.accessToken);
    const encryptedRefreshToken = encryptField(tokens.refreshToken);

    await pool.query(
      "UPDATE accounting_connections SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = $4 WHERE id = $5",
      [
        encryptedAccessToken,
        encryptedRefreshToken,
        tokens.expiresAt,
        new Date(),
        connectionId,
      ],
    );
  }

  async getConnection(
    connectionId: string,
  ): Promise<AccountingConnection | null> {
    const result = await pool.query(
      "SELECT * FROM accounting_connections WHERE id = $1",
      [connectionId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      ...row,
      userId: row.user_id,
      realmId: row.realm_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      accessToken: decryptField(row.access_token) || row.access_token,
      refreshToken: decryptField(row.refresh_token) || row.refresh_token,
      expiresAt: new Date(row.expires_at),
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async getUserConnections(userId: string): Promise<AccountingConnection[]> {
    const result = await pool.query(
      "SELECT * FROM accounting_connections WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC",
      [userId],
    );

    return result.rows.map((row) => ({
      ...row,
      userId: row.user_id,
      realmId: row.realm_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      accessToken: decryptField(row.access_token) || row.access_token,
      refreshToken: decryptField(row.refresh_token) || row.refresh_token,
      expiresAt: new Date(row.expires_at),
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  async getAllActiveConnections(): Promise<AccountingConnection[]> {
    const result = await pool.query(
      "SELECT * FROM accounting_connections WHERE is_active = true ORDER BY created_at DESC",
    );

    return result.rows.map((row) => ({
      ...row,
      userId: row.user_id,
      realmId: row.realm_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      accessToken: decryptField(row.access_token) || row.access_token,
      refreshToken: decryptField(row.refresh_token) || row.refresh_token,
      expiresAt: new Date(row.expires_at),
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
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
      ],
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
      ],
    );
  }

  async getSyncLogs(
    connectionId: string,
    limit: number = 50,
  ): Promise<SyncLog[]> {
    const result = await pool.query(
      "SELECT * FROM sync_logs WHERE connection_id = $1 ORDER BY synced_at DESC LIMIT $2",
      [connectionId, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      syncType: row.sync_type,
      status: row.status,
      recordsProcessed: row.records_processed,
      recordsSucceeded: row.records_succeeded,
      recordsFailed: row.records_failed,
      errorMessage: row.error_message,
      syncedAt: new Date(row.synced_at),
    }));
  }

  /**
   * Ensure a Xero/QuickBooks contact exists for the given user and create a mapping.
   * For both providers we attempt to find a contact by email and reuse it; otherwise create a new contact.
   */
  async syncContactForUser(userId: string): Promise<void> {
    try {
      // Load user data
      const userRes = await pool.query("SELECT id, first_name, last_name, email FROM users WHERE id = $1", [userId]);
      if (userRes.rows.length === 0) return;
      const row = userRes.rows[0];
      const email = decrypt(row.email) as string | null | undefined;
      const firstName = decryptField(row.first_name) as string | null | undefined;
      const lastName = decryptField(row.last_name) as string | null | undefined;

      if (!email) {
        logger.info(`[AccountingService] Skipping contact sync for user ${userId}: no email`);
        return;
      }

      const connections = await this.getUserConnections(userId);

      for (const connection of connections) {
        try {
          if (connection.provider === AccountingProvider.XERO) {
            await this.syncXeroContactForUser(userId, connection, email, firstName, lastName);
          } else if (connection.provider === AccountingProvider.QUICKBOOKS) {
            await this.syncQuickBooksCustomerForUser(userId, connection, email, firstName, lastName);
          }
        } catch (err) {
          logger.error(`[AccountingService] Failed to sync contact for user ${userId} on connection ${connection.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      logger.error(`[AccountingService] syncContactForUser error for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sync Xero contact for a user: find or create, then store mapping.
   */
  private async syncXeroContactForUser(
    userId: string,
    connection: AccountingConnection,
    email: string,
    firstName?: string | null,
    lastName?: string | null,
  ): Promise<void> {
    // Skip if mapping already exists for this tenant
    const mapRes = await pool.query(
      "SELECT external_id FROM accounting_contact_mappings WHERE user_id = $1 AND provider_type = 'xero' AND tenant_id = $2",
      [userId, connection.tenantId],
    );
    if (mapRes.rows.length > 0) return;

    await this.ensureValidToken(connection.id);

    // Fetch all contacts and try to match by email (API may support filtering; keep generic)
    const resp = await axios.get("https://api.xero.com/api.xro/2.0/Contacts", {
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "Xero-tenant-id": connection.tenantId || "",
      },
      timeout: 20000,
    });

    const contacts = resp.data?.Contacts || [];

    let foundContact: any = null;

    for (const c of contacts) {
      // Xero contact email can be in EmailAddress or EmailAddresses array
      const emails: string[] = [];
      if (c.EmailAddress) emails.push(c.EmailAddress);
      if (c.EmailAddresses && Array.isArray(c.EmailAddresses)) {
        for (const e of c.EmailAddresses) {
          if (e && (e.EmailAddress || e.email)) emails.push(e.EmailAddress || e.email);
        }
      }
      if (emails.find((e) => e && e.toLowerCase() === email.toLowerCase())) {
        foundContact = c;
        break;
      }
    }

    let externalId: string | undefined;

    if (foundContact) {
      externalId = foundContact.ContactID || foundContact.ContactId || foundContact.contactID;
    } else {
      // Create new contact in Xero
      const name = (firstName || lastName) ? `${firstName || ''} ${lastName || ''}`.trim() : email;
      const createBody = {
        Contacts: [
          {
            Name: name,
            FirstName: firstName,
            LastName: lastName,
            EmailAddress: email,
          },
        ],
      };

      const createResp = await axios.post("https://api.xero.com/api.xro/2.0/Contacts", createBody, {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Xero-tenant-id": connection.tenantId || "",
          "Content-Type": "application/json",
        },
        timeout: 20000,
      });

      const created = createResp.data?.Contacts && createResp.data.Contacts[0];
      externalId = created?.ContactID || created?.ContactId;
    }

    if (externalId) {
      await pool.query(
        `INSERT INTO accounting_contact_mappings (id, user_id, provider_type, tenant_id, external_id, external_email)
         VALUES (gen_random_uuid(), $1, 'xero', $2, $3, $4)`,
        [userId, connection.tenantId, externalId, email],
      );
      logger.info(`[AccountingService] Mapped user ${userId} -> xero contact ${externalId} (tenant ${connection.tenantId})`);
    }
  }

  /**
   * Sync QuickBooks customer for a user: find or create, then store mapping.
   */
  private async syncQuickBooksCustomerForUser(
    userId: string,
    connection: AccountingConnection,
    email: string,
    firstName?: string | null,
    lastName?: string | null,
  ): Promise<void> {
    // Skip if mapping already exists for this realm (QuickBooks company)
    const mapRes = await pool.query(
      "SELECT external_id FROM accounting_contact_mappings WHERE user_id = $1 AND provider_type = 'quickbooks' AND tenant_id = $2",
      [userId, connection.realmId],
    );
    if (mapRes.rows.length > 0) return;

    await this.ensureValidToken(connection.id);

    // Query QuickBooks for customers with matching email
    // Use a QBO query to find customers by email
    const query = `SELECT * FROM Customer WHERE BillAddr.Email = '${email}' MAXRESULTS 10`;
    const encodedQuery = encodeURIComponent(query);

    try {
      const resp = await axios.get(
        `https://quickbooks.api.intuit.com/v3/company/${connection.realmId}/query?query=${encodedQuery}`,
        {
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            Accept: "application/json",
          },
          timeout: 20000,
        },
      );

      const customers = resp.data?.QueryResponse?.Customer || [];
      let foundCustomer: any = null;

      // Look for email match in returned customers
      if (customers.length > 0) {
        for (const c of customers) {
          const customerEmail = c.BillAddr?.Email || c.ShipAddr?.Email;
          if (customerEmail && customerEmail.toLowerCase() === email.toLowerCase()) {
            foundCustomer = c;
            break;
          }
        }
      }

      let customerId: string | undefined;

      if (foundCustomer) {
        customerId = foundCustomer.Id;
      } else {
        // Create new customer in QuickBooks
        const displayName = (firstName || lastName) ? `${firstName || ''} ${lastName || ''}`.trim() : email.split("@")[0];

        const createBody = {
          DisplayName: displayName,
          PrimaryEmailAddr: {
            Address: email,
          },
          BillAddr: {
            City: "",
            Country: "",
            Line1: "",
            PostalCode: "",
            Qty: 1,
          },
          ...(firstName && { GivenName: firstName }),
          ...(lastName && { FamilyName: lastName }),
        };

        const createResp = await axios.post(
          `https://quickbooks.api.intuit.com/v3/company/${connection.realmId}/customer`,
          createBody,
          {
            headers: {
              Authorization: `Bearer ${connection.accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 20000,
          },
        );

        const created = createResp.data?.Customer;
        customerId = created?.Id;
      }

      if (customerId) {
        await pool.query(
          `INSERT INTO accounting_contact_mappings (id, user_id, provider_type, tenant_id, external_id, external_email)
           VALUES (gen_random_uuid(), $1, 'quickbooks', $2, $3, $4)`,
          [userId, connection.realmId, customerId, email],
        );
        logger.info(`[AccountingService] Mapped user ${userId} -> quickbooks customer ${customerId} (realm ${connection.realmId})`);
      }
    } catch (err) {
      // If query fails (e.g., no customer with that email), proceed to create
      if ((err as any).response?.status === 400 || (err as any).response?.status === 401) {
        logger.warn(`[AccountingService] QB customer query failed for user ${userId}: ${(err as Error).message}. Attempting create.`);

        // Attempt to create customer
        const displayName = (firstName || lastName) ? `${firstName || ''} ${lastName || ''}`.trim() : email.split("@")[0];

        const createBody = {
          DisplayName: displayName,
          PrimaryEmailAddr: {
            Address: email,
          },
          BillAddr: {
            City: "",
            Country: "",
            Line1: "",
            PostalCode: "",
            Qty: 1,
          },
          ...(firstName && { GivenName: firstName }),
          ...(lastName && { FamilyName: lastName }),
        };

        const createResp = await axios.post(
          `https://quickbooks.api.intuit.com/v3/company/${connection.realmId}/customer`,
          createBody,
          {
            headers: {
              Authorization: `Bearer ${connection.accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 20000,
          },
        );

        const created = createResp.data?.Customer;
        const customerId = created?.Id;

        if (customerId) {
          await pool.query(
            `INSERT INTO accounting_contact_mappings (id, user_id, provider_type, tenant_id, external_id, external_email)
             VALUES (gen_random_uuid(), $1, 'quickbooks', $2, $3, $4)`,
            [userId, connection.realmId, customerId, email],
          );
          logger.info(`[AccountingService] Created and mapped user ${userId} -> quickbooks customer ${customerId} (realm ${connection.realmId})`);
        }
      } else {
        throw err;
      }
    }
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

  public async ensureConnectionTokenValid(connectionId: string): Promise<void> {
    return this.ensureValidToken(connectionId);
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

  private async getFeeRevenueData(
    date: string,
  ): Promise<{ category: string; amount: number }[]> {
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
    return result.rows.map((row) => ({
      category: row.fee_category || "General Fees",
      amount: parseFloat(row.amount),
    }));
  }

  // Provider-specific sync implementations
  private async syncPnLToQuickBooks(
    connection: AccountingConnection,
    pnlData: PnLData,
    syncLog: SyncLog,
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
            AccountRef: this.getMappedCategory(mappings, "revenue") || {
              value: "1",
            }, // Default to Sales
          },
        },
        {
          Description: `Daily Fees - ${pnlData.date}`,
          Amount: pnlData.fees,
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: this.getMappedCategory(mappings, "fees") || {
              value: "4",
            }, // Default to Expense
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
        },
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
    syncLog: SyncLog,
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
        },
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
    syncLog: SyncLog,
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    const lines = feeData.map((fee) => ({
      Description: `Fee Revenue - ${fee.category}`,
      Amount: fee.amount,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: "Credit",
        AccountRef: this.getMappedCategory(mappings, fee.category) || {
          value: "1",
        },
      },
    }));

    const journalEntry = {
      TxnDate: new Date().toISOString().split("T")[0],
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
        },
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
    syncLog: SyncLog,
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const mappings = await this.getCategoryMappings(connection.id);

    const journalLines = feeData.map((fee) => ({
      Description: `Fee Revenue - ${fee.category}`,
      CreditAmount: fee.amount,
      AccountID: this.getMappedCategory(mappings, fee.category) || "1",
    }));

    const journalEntry = {
      Date: new Date().toISOString().split("T")[0],
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
        },
      );

      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsSucceeded = feeData.length;
    } catch (error) {
      syncLog.recordsProcessed = feeData.length;
      syncLog.recordsFailed = feeData.length;
      throw error;
    }
  }

  private async syncWithdrawalToXeroBill(
    connection: AccountingConnection,
    transaction: {
      id: string;
      userId: string;
      type: string;
      amount: number;
      fee: number;
      currency: string;
      referenceNumber: string;
      provider: string;
      createdAt: Date;
    },
    mappings: CategoryMapping[],
  ): Promise<void> {
    const connectionData = await this.getConnection(connection.id);
    const txnDate = transaction.createdAt.toISOString().split("T")[0];
    const withdrawalAccountId = this.getMappedCategory(mappings, "withdrawal");
    const feeAccountId = this.getMappedCategory(mappings, "fees");

    const withdrawalLine: any = {
      Description: `Withdrawal payout - ref:${transaction.referenceNumber} via ${transaction.provider}`,
      Quantity: 1,
      UnitAmount: transaction.amount,
      TaxType: "NONE",
    };

    if (withdrawalAccountId) {
      withdrawalLine.AccountID = withdrawalAccountId;
    } else {
      withdrawalLine.AccountCode = "500";
    }

    const lineItems: any[] = [withdrawalLine];

    if (transaction.fee > 0) {
      const feeLine: any = {
        Description: `Fee - Withdrawal payout ref:${transaction.referenceNumber}`,
        Quantity: 1,
        UnitAmount: transaction.fee,
        TaxType: "NONE",
      };

      if (feeAccountId) {
        feeLine.AccountID = feeAccountId;
      } else {
        feeLine.AccountCode = "500";
      }

      lineItems.push(feeLine);
    }

    const bill = {
      Type: "ACCPAY",
      Contact: {
        Name: "Mobile Money Payouts",
      },
      Date: txnDate,
      DueDate: txnDate,
      Reference: transaction.referenceNumber,
      Status: "AUTHORISED",
      LineItems: lineItems,
    };

    await axios.post(
      "https://api.xero.com/api.xro/2.0/Bills",
      { Bills: [bill] },
      {
        headers: {
          Authorization: `Bearer ${connectionData!.accessToken}`,
          "Xero-tenant-id": connectionData!.tenantId,
          "Content-Type": "application/json",
        },
      },
    );
  }

  private async syncXeroTransactionToManualJournal(
    connection: AccountingConnection,
    transaction: {
      id: string;
      userId: string;
      type: string;
      amount: number;
      fee: number;
      currency: string;
      referenceNumber: string;
      provider: string;
      createdAt: Date;
    },
  ): Promise<void> {
    const freshConnection = await this.getConnection(connection.id);
    const txnDate = transaction.createdAt.toISOString().split("T")[0];
    const description = `${transaction.type} - ref:${transaction.referenceNumber} via ${transaction.provider}`;

    const journalLines: object[] = [
      {
        Description: description,
        CreditAmount: transaction.amount,
        AccountID: "revenue-account-id",
      },
    ];

    if (transaction.fee > 0) {
      journalLines.push({
        Description: `Fee - ${description}`,
        DebitAmount: transaction.fee,
        AccountID: "expense-account-id",
      });
    }

    await axios.put(
      "https://api.xero.com/api.xro/2.0/ManualJournals",
      { Date: txnDate, Narration: transaction.id, JournalLines: journalLines },
      {
        headers: {
          Authorization: `Bearer ${freshConnection!.accessToken}`,
          "Xero-tenant-id": freshConnection!.tenantId,
          "Content-Type": "application/json",
        },
      },
    );
  }

  private getMappedCategory(
    mappings: CategoryMapping[],
    mobileMoneyCategory: string,
  ): string | null {
    const mapping = mappings.find(
      (m) => m.mobileMoneyCategory === mobileMoneyCategory,
    );
    return mapping ? mapping.accountingCategoryId : null;
  }

  /**
   * Sync a single completed transaction to all active accounting connections for the user.
   * Called automatically when a transaction.completed event fires.
   */
  /**
   * Sync a single completed transaction to all active accounting connections for the user.
   * Called automatically when a transaction.completed event fires.
   */
  async syncTransaction(transaction: {
    id: string;
    userId: string;
    type: string;
    amount: number;
    fee: number;
    currency: string;
    referenceNumber: string;
    provider: string;
    createdAt: Date;
  }): Promise<void> {
    const connections = await this.getUserConnections(transaction.userId);
    if (connections.length === 0) return;

    for (const connection of connections) {
      await this.ensureValidToken(connection.id);
      const fresh = await this.getConnection(connection.id);
      if (!fresh) continue;

      const txnDate = transaction.createdAt.toISOString().split("T")[0];
      const description = `${transaction.type} - ref:${transaction.referenceNumber} via ${transaction.provider}`;

      try {
        if (connection.provider === AccountingProvider.QUICKBOOKS) {
          if (transaction.type === "deposit") {
            // Create a Sales Receipt in QuickBooks for deposit transactions
            await this.syncSalesReceiptToQuickBooks(fresh, transaction);
          } else {
            // Existing journal entry sync for other transaction types
            await axios.post(
              `https://quickbooks.api.intuit.com/v3/company/${fresh.realmId}/journalentry`,
              {
                TxnDate: txnDate,
                PrivateNote: transaction.id,
                Line: [
                  {
                    Description: description,
                    Amount: transaction.amount,
                    DetailType: "JournalEntryLineDetail",
                    JournalEntryLineDetail: {
                      PostingType: "Credit",
                      AccountRef: { value: "1" }, // Sales / Revenue
                    },
                  },
                  ...(transaction.fee > 0
                    ? [
                        {
                          Description: `Fee - ${description}`,
                          Amount: transaction.fee,
                          DetailType: "JournalEntryLineDetail",
                          JournalEntryLineDetail: {
                            PostingType: "Debit",
                            AccountRef: { value: "4" }, // Expense
                          },
                        },
                      ]
                    : []),
                ],
              },
              {
                headers: {
                  Authorization: `Bearer ${fresh.accessToken}`,
                  "Content-Type": "application/json",
                },
              },
            );
          }
        } else if (connection.provider === AccountingProvider.XERO) {
          if (transaction.type === "withdraw") {
            const mappings = await this.getCategoryMappings(connection.id);
            const withdrawalAccountId = this.getMappedCategory(
              mappings,
              "withdrawal",
            );

            if (withdrawalAccountId) {
              await this.syncWithdrawalToXeroBill(fresh, transaction, mappings);
            } else {
              await this.syncXeroTransactionToManualJournal(fresh, transaction);
            }
          } else {
            await this.syncXeroTransactionToManualJournal(fresh, transaction);
          }
        }

        await pool.query(
          `INSERT INTO accounting_sync_queue
             (transaction_id, connection_id, status, synced_at)
           VALUES ($1, $2, 'synced', NOW())
           ON CONFLICT (transaction_id, connection_id) DO UPDATE
             SET status = 'synced', synced_at = NOW()`,
          [transaction.id, connection.id],
        );
      } catch (err) {
        await pool.query(
          `INSERT INTO accounting_sync_queue
             (transaction_id, connection_id, status, error_message, synced_at)
           VALUES ($1, $2, 'failed', $3, NOW())
           ON CONFLICT (transaction_id, connection_id) DO UPDATE
             SET status = 'failed', error_message = $3, synced_at = NOW()`,
          [
            transaction.id,
            connection.id,
            err instanceof Error ? err.message : String(err),
          ],
        );

        const providerType =
          connection.provider === AccountingProvider.QUICKBOOKS
            ? 'quickbooks'
            : connection.provider === AccountingProvider.XERO
              ? 'xero'
              : null;

        if (providerType) {
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          await pool.query(
            `INSERT INTO accounting_sync_errors
               (transaction_id, provider_type, error_message, status)
             VALUES ($1, $2, $3, 'pending')
             ON CONFLICT DO NOTHING`,
            [transaction.id, providerType, errorMessage.slice(0, 500)],
          );
        }
      }
    }
  }

  private async syncSalesReceiptToQuickBooks(
    connection: AccountingConnection,
    transaction: {
      id: string;
      userId: string;
      type: string;
      amount: number;
      fee: number;
      currency: string;
      referenceNumber: string;
      provider: string;
      createdAt: Date;
    },
  ): Promise<void> {
    // QuickBooks SalesReceipt creation for deposit transactions
    const txnDate = transaction.createdAt.toISOString().split("T")[0];
    const payload = {
      TxnDate: txnDate,
      PrivateNote: transaction.id,
      CustomerRef: { value: "1" }, // Default customer ID; should be configurable
      Line: [
        {
          Amount: transaction.amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: { value: "1" }, // Default item/service ID
          },
        },
      ],
      CurrencyRef: transaction.currency ? { value: transaction.currency } : undefined,
    };

    await axios.post(
      `https://quickbooks.api.intuit.com/v3/company/${connection.realmId}/salesreceipt`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
  }
}

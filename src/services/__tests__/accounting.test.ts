import { AccountingService, AccountingProvider } from "../accounting";
import { pool } from "../../config/database";

// Mock the database and external dependencies
jest.mock("../../config/database");
jest.mock("axios");
jest.mock("uuid");

const mockPool = pool as jest.Mocked<typeof pool>;
const mockAxios = require("axios");
const mockUuid = require("uuid");

describe("AccountingService", () => {
  let accountingService: AccountingService;
  let mockConnection: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock UUID generation
    mockUuid.v4.mockReturnValue("test-uuid-123");

    // Setup environment variables
    process.env.QUICKBOOKS_CLIENT_ID = "test-qb-client-id";
    process.env.QUICKBOOKS_CLIENT_SECRET = "test-qb-client-secret";
    process.env.QUICKBOOKS_REDIRECT_URI =
      "http://localhost:3000/auth/quickbooks/callback";
    process.env.XERO_CLIENT_ID = "test-xero-client-id";
    process.env.XERO_CLIENT_SECRET = "test-xero-client-secret";
    process.env.XERO_REDIRECT_URI = "http://localhost:3000/auth/xero/callback";

    accountingService = new AccountingService();

    mockConnection = {
      id: "test-connection-id",
      userId: "test-user-id",
      provider: AccountingProvider.QUICKBOOKS,
      realmId: "test-realm-id",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  describe("getQuickBooksAuthUrl", () => {
    it("should generate QuickBooks authorization URL", () => {
      const authUrl = accountingService.getQuickBooksAuthUrl();

      expect(authUrl).toContain("https://appcenter.intuit.com/connect/oauth2");
      expect(authUrl).toContain("client_id=test-qb-client-id");
      expect(authUrl).toContain("scope=com.intuit.quickbooks.accounting");
      expect(authUrl).toContain("response_type=code");
    });
  });

  describe("getXeroAuthUrl", () => {
    it("should generate Xero authorization URL", () => {
      const authUrl = accountingService.getXeroAuthUrl();

      expect(authUrl).toContain(
        "https://login.xero.com/identity/connect/authorize",
      );
      expect(authUrl).toContain("client_id=test-xero-client-id");
      // offline_access is required for Xero to return a refresh token.
      expect(authUrl).toContain("offline_access");
      expect(authUrl).toContain("accounting.transactions");
      expect(authUrl).toContain("response_type=code");
    });

    it("should embed the provided state value for CSRF protection", () => {
      const authUrl = accountingService.getXeroAuthUrl("my-custom-state");
      expect(authUrl).toContain("state=my-custom-state");
    });
  });

  describe("handleQuickBooksCallback", () => {
    it("should handle QuickBooks OAuth callback successfully", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
      };

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.handleQuickBooksCallback(
        "test-code",
        "test-realm-id",
        "test-user-id",
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: "test-uuid-123",
          userId: "test-user-id",
          provider: AccountingProvider.QUICKBOOKS,
          realmId: "test-realm-id",
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          isActive: true,
        }),
      );

      expect(mockAxios.post).toHaveBeenCalledWith(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
        }),
      );
    });

    it("should throw error when QuickBooks OAuth fails", async () => {
      mockAxios.post.mockRejectedValue(new Error("OAuth failed"));

      await expect(
        accountingService.handleQuickBooksCallback(
          "invalid-code",
          "test-realm-id",
          "test-user-id",
        ),
      ).rejects.toThrow("QuickBooks OAuth failed: Error: OAuth failed");
    });
  });

  describe("handleXeroCallback", () => {
    it("should handle Xero OAuth callback successfully", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "accounting.transactions",
      };

      const mockTenantsResponse = [
        { tenantId: "test-tenant-id", tenantName: "Test Company" },
      ];

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockAxios.get.mockResolvedValue({ data: mockTenantsResponse });
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.handleXeroCallback(
        "test-code",
        "test-user-id",
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: "test-uuid-123",
          userId: "test-user-id",
          provider: AccountingProvider.XERO,
          tenantId: "test-tenant-id",
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          isActive: true,
        }),
      );
    });

    it("should throw error when Xero OAuth fails", async () => {
      mockAxios.post.mockRejectedValue(new Error("OAuth failed"));

      await expect(
        accountingService.handleXeroCallback("invalid-code", "test-user-id"),
      ).rejects.toThrow("Xero OAuth failed: Error: OAuth failed");
    });

    it("should select the requested tenant in a multi-tenant scenario", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "accounting.transactions",
      };

      const mockTenantsResponse = [
        {
          id: "conn-1",
          tenantId: "tenant-A",
          tenantName: "Org A",
          tenantType: "ORGANISATION",
        },
        {
          id: "conn-2",
          tenantId: "tenant-B",
          tenantName: "Org B",
          tenantType: "ORGANISATION",
        },
      ];

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockAxios.get.mockResolvedValue({ data: mockTenantsResponse });
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.handleXeroCallback(
        "test-code",
        "test-user-id",
        "tenant-B",
      );

      expect(result).toEqual(
        expect.objectContaining({
          provider: AccountingProvider.XERO,
          tenantId: "tenant-B",
          tenantName: "Org B",
        }),
      );
    });

    it("should default to the first tenant when none is selected", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "accounting.transactions",
      };

      const mockTenantsResponse = [
        { id: "conn-1", tenantId: "tenant-A", tenantName: "Org A" },
        { id: "conn-2", tenantId: "tenant-B", tenantName: "Org B" },
      ];

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockAxios.get.mockResolvedValue({ data: mockTenantsResponse });
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.handleXeroCallback(
        "test-code",
        "test-user-id",
      );

      expect(result).toEqual(
        expect.objectContaining({ tenantId: "tenant-A", tenantName: "Org A" }),
      );
    });

    it("should reject a selected tenant that is not authorized", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "accounting.transactions",
      };
      const mockTenantsResponse = [
        { tenantId: "tenant-A", tenantName: "Org A" },
      ];

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockAxios.get.mockResolvedValue({ data: mockTenantsResponse });
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        accountingService.handleXeroCallback(
          "test-code",
          "test-user-id",
          "tenant-Z",
        ),
      ).rejects.toThrow(/not among the authorized organizations/);
    });

    it("should fail when no Xero organizations are connected", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "accounting.transactions",
      };

      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });
      mockAxios.get.mockResolvedValue({ data: [] });
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        accountingService.handleXeroCallback("test-code", "test-user-id"),
      ).rejects.toThrow(/No Xero organizations are connected/);
    });
  });

  describe("createCategoryMapping", () => {
    it("should create category mapping successfully", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.createCategoryMapping(
        "test-connection-id",
        "Transaction Fees",
        "accounting-category-id",
        "Accounting Category Name",
      );

      expect(result).toEqual({
        id: "test-uuid-123",
        connectionId: "test-connection-id",
        mobileMoneyCategory: "Transaction Fees",
        accountingCategoryId: "accounting-category-id",
        accountingCategoryName: "Accounting Category Name",
        createdAt: expect.any(Date),
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO category_mappings"),
        [
          "test-uuid-123",
          "test-connection-id",
          "Transaction Fees",
          "accounting-category-id",
          "Accounting Category Name",
          expect.any(Date),
        ],
      );
    });
  });

  describe("getConnection", () => {
    it("should return connection when found", async () => {
      mockPool.query.mockResolvedValue({
        rows: [mockConnection],
      });

      const result =
        await accountingService.getConnection("test-connection-id");

      expect(result).toEqual(mockConnection);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM accounting_connections WHERE id = $1",
        ["test-connection-id"],
      );
    });

    it("should return null when connection not found", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.getConnection("invalid-id");

      expect(result).toBeNull();
    });
  });

  describe("getUserConnections", () => {
    it("should return user's active connections", async () => {
      const mockConnections = [mockConnection];
      mockPool.query.mockResolvedValue({ rows: mockConnections });

      const result = await accountingService.getUserConnections("test-user-id");

      expect(result).toEqual(mockConnections);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM accounting_connections WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC",
        ["test-user-id"],
      );
    });
  });

  describe("syncDailyPnL", () => {
    beforeEach(() => {
      // Mock PnL data
      mockPool.query.mockResolvedValueOnce({
        rows: [{ transactions: 100, revenue: 1000, fees: 50 }],
      });
    });

    it("should sync daily P&L to QuickBooks successfully", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockConnection] }); // getConnection
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // getCategoryMappings
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // createSyncLog
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // updateSyncLog

      mockAxios.post.mockResolvedValue({ data: { Id: "test-journal-id" } });

      const result = await accountingService.syncDailyPnL(
        "test-connection-id",
        "2024-01-01",
      );

      expect(result).toEqual(
        expect.objectContaining({
          connectionId: "test-connection-id",
          syncType: "daily_pnl",
          status: "completed",
          recordsProcessed: 1,
          recordsSucceeded: 1,
          recordsFailed: 0,
        }),
      );
    });

    it("should handle sync failures gracefully", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockConnection] }); // getConnection
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // getCategoryMappings
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // createSyncLog
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // updateSyncLog

      mockAxios.post.mockRejectedValue(new Error("API Error"));

      const result = await accountingService.syncDailyPnL(
        "test-connection-id",
        "2024-01-01",
      );

      expect(result).toEqual(
        expect.objectContaining({
          connectionId: "test-connection-id",
          syncType: "daily_pnl",
          status: "failed",
          recordsProcessed: 1,
          recordsSucceeded: 0,
          recordsFailed: 1,
          errorMessage: "Error: API Error",
        }),
      );
    });
  });

  describe("getSyncLogs", () => {
    it("should return sync logs for connection", async () => {
      const mockSyncLogs = [
        {
          id: "sync-log-1",
          connectionId: "test-connection-id",
          syncType: "daily_pnl",
          status: "completed",
          recordsProcessed: 1,
          recordsSucceeded: 1,
          recordsFailed: 0,
          syncedAt: new Date(),
        },
      ];

      mockPool.query.mockResolvedValue({ rows: mockSyncLogs });

      const result = await accountingService.getSyncLogs(
        "test-connection-id",
        50,
      );

      expect(result).toEqual(mockSyncLogs);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM sync_logs WHERE connection_id = $1 ORDER BY synced_at DESC LIMIT $2",
        ["test-connection-id", 50],
      );
    });
  });

  describe("refreshQuickBooksToken", () => {
    it("should refresh QuickBooks token successfully", async () => {
      const mockTokenResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockConnection] }); // getConnection
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // updateConnectionTokens
      mockAxios.post.mockResolvedValue({ data: mockTokenResponse });

      await accountingService.refreshQuickBooksToken("test-connection-id");

      expect(mockAxios.post).toHaveBeenCalledWith(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
        }),
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounting_connections SET"),
        [
          "new-access-token",
          "new-refresh-token",
          expect.any(Date),
          expect.any(Date),
          "test-connection-id",
        ],
      );
    });

    it("should throw error when connection not found", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        accountingService.refreshQuickBooksToken("invalid-id"),
      ).rejects.toThrow("QuickBooks connection not found");
    });
  });

  describe("getPnLData", () => {
    it("should calculate P&L data correctly", async () => {
      const mockPnLData = {
        transactions: 100,
        revenue: 1000,
        fees: 50,
      };

      mockPool.query.mockResolvedValue({ rows: [mockPnLData] });

      // Access private method through prototype
      const result = await (accountingService as any).getPnLData("2024-01-01");

      expect(result).toEqual({
        date: "2024-01-01",
        revenue: 1000,
        fees: 50,
        netProfit: 950,
        transactions: 100,
      });
    });
  });

  describe("getFeeRevenueData", () => {
    it("should get fee revenue data by category", async () => {
      const mockFeeData = [
        { fee_category: "Transaction Fees", amount: 30 },
        { fee_category: "Processing Fees", amount: 20 },
      ];

      mockPool.query.mockResolvedValue({ rows: mockFeeData });

      // Access private method through prototype
      const result = await (accountingService as any).getFeeRevenueData(
        "2024-01-01",
      );

      expect(result).toEqual([
        { category: "Transaction Fees", amount: 30 },
        { category: "Processing Fees", amount: 20 },
      ]);
    });

    it("should handle null fee_category", async () => {
      const mockFeeData = [{ fee_category: null, amount: 50 }];

      mockPool.query.mockResolvedValue({ rows: mockFeeData });

      const result = await (accountingService as any).getFeeRevenueData(
        "2024-01-01",
      );

      expect(result).toEqual([{ category: "General Fees", amount: 50 }]);
    });
  });

  describe("syncTransaction", () => {
    it("should create a Xero bill for withdraw transactions when a withdrawal category mapping exists", async () => {
      const xeroConnection = {
        ...mockConnection,
        provider: AccountingProvider.XERO,
        tenantId: "test-tenant-id",
        updatedAt: new Date(),
      };

      const mappingRows = [
        {
          id: "map-withdrawal",
          connection_id: "test-connection-id",
          mobile_money_category: "withdrawal",
          accounting_category_id: "account-id-withdrawal",
          accounting_category_name: "Withdrawal Expense",
          created_at: new Date(),
        },
        {
          id: "map-fees",
          connection_id: "test-connection-id",
          mobile_money_category: "fees",
          accounting_category_id: "account-id-fees",
          accounting_category_name: "Fee Expense",
          created_at: new Date(),
        },
      ];

      mockPool.query
        .mockResolvedValueOnce({ rows: [xeroConnection] }) // getUserConnections
        .mockResolvedValueOnce({ rows: [xeroConnection] }) // ensureValidToken getConnection
        .mockResolvedValueOnce({ rows: [xeroConnection] }) // fresh getConnection
        .mockResolvedValueOnce({ rows: mappingRows }) // getCategoryMappings
        .mockResolvedValueOnce({ rows: [] }); // insert accounting_sync_queue

      mockAxios.post.mockResolvedValue({ data: { Bills: [{ BillID: "test-bill-id" }] } });

      await accountingService.syncTransaction({
        id: "txn-123",
        userId: "test-user-id",
        type: "withdraw",
        amount: 100,
        fee: 2.5,
        currency: "USD",
        referenceNumber: "REF123",
        provider: "mtn",
        createdAt: new Date("2024-01-01T12:00:00Z"),
      });

      expect(mockAxios.post).toHaveBeenCalledWith(
        "https://api.xero.com/api.xro/2.0/Bills",
        expect.objectContaining({
          Bills: [
            expect.objectContaining({
              Type: "ACCPAY",
              Reference: "REF123",
              LineItems: expect.arrayContaining([
                expect.objectContaining({
                  AccountID: "account-id-withdrawal",
                  UnitAmount: 100,
                }),
                expect.objectContaining({
                  AccountID: "account-id-fees",
                  UnitAmount: 2.5,
                }),
              ]),
            }),
          ],
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-access-token",
            "Xero-tenant-id": "test-tenant-id",
          }),
        })
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO accounting_sync_queue"),
        ["txn-123", "test-connection-id"]
      );
    });
  });
});

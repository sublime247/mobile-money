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
    process.env.QUICKBOOKS_REDIRECT_URI = "http://localhost:3000/auth/quickbooks/callback";
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
      
      expect(authUrl).toContain("https://login.xero.com/identity/connect/authorize");
      expect(authUrl).toContain("client_id=test-xero-client-id");
      expect(authUrl).toContain("scope=accounting.transactions");
      expect(authUrl).toContain("response_type=code");
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
        "test-user-id"
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
        })
      );

      expect(mockAxios.post).toHaveBeenCalledWith(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
        })
      );
    });

    it("should throw error when QuickBooks OAuth fails", async () => {
      mockAxios.post.mockRejectedValue(new Error("OAuth failed"));

      await expect(
        accountingService.handleQuickBooksCallback("invalid-code", "test-realm-id", "test-user-id")
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

      const result = await accountingService.handleXeroCallback("test-code", "test-user-id");

      expect(result).toEqual(
        expect.objectContaining({
          id: "test-uuid-123",
          userId: "test-user-id",
          provider: AccountingProvider.XERO,
          tenantId: "test-tenant-id",
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          isActive: true,
        })
      );
    });

    it("should throw error when Xero OAuth fails", async () => {
      mockAxios.post.mockRejectedValue(new Error("OAuth failed"));

      await expect(
        accountingService.handleXeroCallback("invalid-code", "test-user-id")
      ).rejects.toThrow("Xero OAuth failed: Error: OAuth failed");
    });
  });

  describe("createCategoryMapping", () => {
    it("should create category mapping successfully", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await accountingService.createCategoryMapping(
        "test-connection-id",
        "Transaction Fees",
        "accounting-category-id",
        "Accounting Category Name"
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
        ]
      );
    });
  });

  describe("getConnection", () => {
    it("should return connection when found", async () => {
      mockPool.query.mockResolvedValue({
        rows: [mockConnection],
      });

      const result = await accountingService.getConnection("test-connection-id");

      expect(result).toEqual(mockConnection);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM accounting_connections WHERE id = $1",
        ["test-connection-id"]
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
        ["test-user-id"]
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

      const result = await accountingService.syncDailyPnL("test-connection-id", "2024-01-01");

      expect(result).toEqual(
        expect.objectContaining({
          connectionId: "test-connection-id",
          syncType: "daily_pnl",
          status: "completed",
          recordsProcessed: 1,
          recordsSucceeded: 1,
          recordsFailed: 0,
        })
      );
    });

    it("should handle sync failures gracefully", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockConnection] }); // getConnection
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // getCategoryMappings
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // createSyncLog
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // updateSyncLog

      mockAxios.post.mockRejectedValue(new Error("API Error"));

      const result = await accountingService.syncDailyPnL("test-connection-id", "2024-01-01");

      expect(result).toEqual(
        expect.objectContaining({
          connectionId: "test-connection-id",
          syncType: "daily_pnl",
          status: "failed",
          recordsProcessed: 1,
          recordsSucceeded: 0,
          recordsFailed: 1,
          errorMessage: "Error: API Error",
        })
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

      const result = await accountingService.getSyncLogs("test-connection-id", 50);

      expect(result).toEqual(mockSyncLogs);
      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT * FROM sync_logs WHERE connection_id = $1 ORDER BY synced_at DESC LIMIT $2",
        ["test-connection-id", 50]
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
        })
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounting_connections SET"),
        [
          "new-access-token",
          "new-refresh-token",
          expect.any(Date),
          expect.any(Date),
          "test-connection-id",
        ]
      );
    });

    it("should throw error when connection not found", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        accountingService.refreshQuickBooksToken("invalid-id")
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
      const result = await (accountingService as any).getFeeRevenueData("2024-01-01");

      expect(result).toEqual([
        { category: "Transaction Fees", amount: 30 },
        { category: "Processing Fees", amount: 20 },
      ]);
    });

    it("should handle null fee_category", async () => {
      const mockFeeData = [
        { fee_category: null, amount: 50 },
      ];

      mockPool.query.mockResolvedValue({ rows: mockFeeData });

      const result = await (accountingService as any).getFeeRevenueData("2024-01-01");

      expect(result).toEqual([
        { category: "General Fees", amount: 50 },
      ]);
    });
  });
});

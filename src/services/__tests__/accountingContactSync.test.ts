import { AccountingService, AccountingProvider } from "../accounting";
import { pool } from "../../config/database";

jest.mock("../../config/database");
jest.mock("axios");
jest.mock("uuid");

const mockPool = pool as jest.Mocked<typeof pool>;
const mockAxios = require("axios");
const mockUuid = require("uuid");

describe("AccountingService.syncContactForUser", () => {
  let accountingService: AccountingService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUuid.v4.mockReturnValue("test-uuid-123");
    process.env.XERO_CLIENT_ID = "test-xero-client-id";
    process.env.XERO_CLIENT_SECRET = "test-xero-client-secret";
    process.env.XERO_REDIRECT_URI = "http://localhost:3000/auth/xero/callback";
    process.env.QUICKBOOKS_CLIENT_ID = "test-qb-client-id";
    process.env.QUICKBOOKS_CLIENT_SECRET = "test-qb-client-secret";
    process.env.QUICKBOOKS_REDIRECT_URI = "http://localhost:3000/auth/quickbooks/callback";
    accountingService = new AccountingService();
  });

  describe("Xero contact sync", () => {
    it("reuses an existing Xero contact matched by email", async () => {
      const userRow = [{ id: "user-1", first_name: "Alice", last_name: "Smith", email: "alice@example.com" }];
      const xeroConnection = [{ id: "conn-1", user_id: "user-1", provider: AccountingProvider.XERO, tenant_id: "tenant-1", access_token: "token", refresh_token: "r", expires_at: new Date(), is_active: true, created_at: new Date(), updated_at: new Date() }];

      // 1: fetch user
      mockPool.query.mockResolvedValueOnce({ rows: userRow });
      // 2: getUserConnections
      mockPool.query.mockResolvedValueOnce({ rows: xeroConnection });
      // 3: check existing mapping -> none
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // 4: axios.get contacts returns a matching contact
      mockAxios.get.mockResolvedValue({ data: { Contacts: [ { ContactID: "contact-123", EmailAddress: "alice@example.com" } ] } });
      // 5: insert mapping
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await accountingService.syncContactForUser("user-1");

      // Ensure we looked up contacts and inserted mapping
      expect(mockAxios.get).toHaveBeenCalled();
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO accounting_contact_mappings"), expect.any(Array));
    });

    it("creates a new Xero contact when none match the email", async () => {
      const userRow = [{ id: "user-2", first_name: "Bob", last_name: "Jones", email: "bob@example.com" }];
      const xeroConnection = [{ id: "conn-2", user_id: "user-2", provider: AccountingProvider.XERO, tenant_id: "tenant-2", access_token: "token2", refresh_token: "r2", expires_at: new Date(), is_active: true, created_at: new Date(), updated_at: new Date() }];

      mockPool.query.mockResolvedValueOnce({ rows: userRow });
      mockPool.query.mockResolvedValueOnce({ rows: xeroConnection });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // No existing contacts
      mockAxios.get.mockResolvedValue({ data: { Contacts: [] } });

      // Creating contact returns created contact
      mockAxios.post.mockResolvedValue({ data: { Contacts: [ { ContactID: "new-contact-1" } ] } });

      // Insert mapping result
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await accountingService.syncContactForUser("user-2");

      expect(mockAxios.post).toHaveBeenCalledWith(
        "https://api.xero.com/api.xro/2.0/Contacts",
        expect.any(Object),
        expect.objectContaining({ headers: expect.any(Object) }),
      );

      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO accounting_contact_mappings"), expect.any(Array));
    });
  });

  describe("QuickBooks customer sync", () => {
    it("reuses an existing QuickBooks customer matched by email", async () => {
      const userRow = [{ id: "user-3", first_name: "Charlie", last_name: "Brown", email: "charlie@example.com" }];
      const qbConnection = [{ 
        id: "conn-3", 
        user_id: "user-3", 
        provider: AccountingProvider.QUICKBOOKS, 
        realm_id: "realm-1",
        access_token: "qb-token", 
        refresh_token: "qb-r", 
        expires_at: new Date(), 
        is_active: true, 
        created_at: new Date(), 
        updated_at: new Date() 
      }];

      // 1: fetch user
      mockPool.query.mockResolvedValueOnce({ rows: userRow });
      // 2: getUserConnections
      mockPool.query.mockResolvedValueOnce({ rows: qbConnection });
      // 3: check existing mapping -> none
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // 4: axios.get customers returns a matching customer
      mockAxios.get.mockResolvedValue({ 
        data: { 
          QueryResponse: { 
            Customer: [ { Id: "qb-customer-123", BillAddr: { Email: "charlie@example.com" } } ] 
          } 
        } 
      });
      // 5: insert mapping
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await accountingService.syncContactForUser("user-3");

      // Ensure we queried customers and inserted mapping
      expect(mockAxios.get).toHaveBeenCalled();
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO accounting_contact_mappings"), expect.any(Array));
    });

    it("creates a new QuickBooks customer when none match the email", async () => {
      const userRow = [{ id: "user-4", first_name: "Diana", last_name: "Prince", email: "diana@example.com" }];
      const qbConnection = [{ 
        id: "conn-4", 
        user_id: "user-4", 
        provider: AccountingProvider.QUICKBOOKS, 
        realm_id: "realm-2",
        access_token: "qb-token-2", 
        refresh_token: "qb-r-2", 
        expires_at: new Date(), 
        is_active: true, 
        created_at: new Date(), 
        updated_at: new Date() 
      }];

      mockPool.query.mockResolvedValueOnce({ rows: userRow });
      mockPool.query.mockResolvedValueOnce({ rows: qbConnection });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // No existing customers
      mockAxios.get.mockResolvedValue({ data: { QueryResponse: { Customer: [] } } });

      // Creating customer returns created customer
      mockAxios.post.mockResolvedValue({ 
        data: { 
          Customer: { Id: "qb-new-customer-1" } 
        } 
      });

      // Insert mapping result
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await accountingService.syncContactForUser("user-4");

      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.stringContaining("/customer"),
        expect.any(Object),
        expect.objectContaining({ headers: expect.any(Object) }),
      );

      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO accounting_contact_mappings"), expect.any(Array));
    });

    it("handles QuickBooks query failures gracefully and creates customer", async () => {
      const userRow = [{ id: "user-5", first_name: "Eve", last_name: "Adams", email: "eve@example.com" }];
      const qbConnection = [{ 
        id: "conn-5", 
        user_id: "user-5", 
        provider: AccountingProvider.QUICKBOOKS, 
        realm_id: "realm-3",
        access_token: "qb-token-3", 
        refresh_token: "qb-r-3", 
        expires_at: new Date(), 
        is_active: true, 
        created_at: new Date(), 
        updated_at: new Date() 
      }];

      mockPool.query.mockResolvedValueOnce({ rows: userRow });
      mockPool.query.mockResolvedValueOnce({ rows: qbConnection });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Query fails with 400
      mockAxios.get.mockRejectedValueOnce({ response: { status: 400 } });

      // Creating customer returns created customer
      mockAxios.post.mockResolvedValue({ 
        data: { 
          Customer: { Id: "qb-new-customer-2" } 
        } 
      });

      // Insert mapping result
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await accountingService.syncContactForUser("user-5");

      expect(mockAxios.post).toHaveBeenCalled();
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO accounting_contact_mappings"), expect.any(Array));
    });
  });
});

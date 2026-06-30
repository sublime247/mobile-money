/**
 * Support Service Tests
 *
 * Tests for Zendesk/Intercom API integration when creating dispute tickets.
 */

import { SupportService, CreateTicketResult } from "../support";
import { Dispute, DisputeStatus, DisputePriority } from "../../models/dispute";
import { Transaction, TransactionStatus } from "../../models/transaction";

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

// Test fixtures
const mockTransaction: Transaction = {
  id: "txn-123",
  referenceNumber: "REF-2024-001234",
  type: "deposit",
  amount: "50000",
  currency: "XAF",
  phoneNumber: "+237699123456",
  provider: "mtn",
  stellarAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  status: TransactionStatus.Completed,
  tags: [],
  createdAt: new Date("2024-01-15T10:30:00Z"),
  updatedAt: new Date("2024-01-15T10:35:00Z"),
};

const mockDispute: Dispute = {
  id: "dispute-456",
  transactionId: "txn-123",
  reason: "Transaction was charged twice",
  status: "open" as DisputeStatus,
  assignedTo: null,
  resolution: null,
  reportedBy: "user@example.com",
  priority: "high" as DisputePriority,
  category: "duplicate_charge",
  slaDueDate: new Date("2024-01-17T10:30:00Z"),
  slaWarningSent: false,
  internalNotes: null,
  createdAt: new Date("2024-01-15T11:00:00Z"),
  updatedAt: new Date("2024-01-15T11:00:00Z"),
};

describe("SupportService", () => {
  describe("isConfigured", () => {
    it("should return false when no provider is configured", () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.ZENDESK_API_TOKEN = "";
      process.env.ZENDESK_USER_EMAIL = "";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(false);
    });

    it("should return true when Zendesk is properly configured", () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(true);
    });

    it("should return true when Intercom is properly configured", () => {
      process.env.SUPPORT_PROVIDER = "intercom";
      process.env.INTERCOM_ACCESS_TOKEN = "test-token";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(true);
    });

    it('should return true when either provider is configured in "both" mode', () => {
      process.env.SUPPORT_PROVIDER = "both";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.INTERCOM_ACCESS_TOKEN = "";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("getConfigurationStatus", () => {
    it("should return correct status for configured providers", () => {
      process.env.SUPPORT_PROVIDER = "both";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.INTERCOM_ACCESS_TOKEN = "intercom-token";

      const service = new SupportService();
      const status = service.getConfigurationStatus();

      expect(status.provider).toBe("both");
      expect(status.zendesk.configured).toBe(true);
      expect(status.intercom.configured).toBe(true);
    });

    it("should return false for unconfigured providers", () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.INTERCOM_ACCESS_TOKEN = "";

      const service = new SupportService();
      const status = service.getConfigurationStatus();

      expect(status.zendesk.configured).toBe(false);
      expect(status.intercom.configured).toBe(false);
    });
  });

  describe("createDisputeTicket - Zendesk", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";
    });

    it("should create a Zendesk ticket successfully", async () => {
      const mockResponse = {
        ticket: {
          id: 12345,
          url: "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
          status: "new",
          created_at: "2024-01-15T11:05:00Z",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
        "user@example.com",
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].provider).toBe("zendesk");
      expect(result.results[0].ticket?.id).toBe("12345");
      expect(result.primaryTicketId).toBe("12345");

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://testcompany.zendesk.com/api/v2/tickets.json");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["Authorization"]).toContain("Basic ");
    });

    it("should handle Zendesk API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid credentials",
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("401");
      expect(result.primaryTicketId).toBeUndefined();
    });

    it("should handle network timeouts", async () => {
      mockFetch.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("aborted")), 100);
        });
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBeDefined();
    });

    it("should return configuration error when Zendesk is not configured", async () => {
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.ZENDESK_API_TOKEN = "";

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("configuration is incomplete");
    });
  });

  describe("createDisputeTicket - Intercom", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "intercom";
      process.env.INTERCOM_ACCESS_TOKEN = "test-token";
      process.env.INTERCOM_ADMIN_ID = "admin-123";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";
    });

    it("should create an Intercom conversation successfully", async () => {
      const mockResponse = {
        type: "conversation",
        id: "conv-789",
        created_at: 1705318800,
        source: {
          url: "https://app.intercom.com/a/inbox/conversation/conv-789",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
        undefined,
        "user-external-123",
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].provider).toBe("intercom");
      expect(result.results[0].ticket?.id).toBe("conv-789");
      expect(result.primaryTicketId).toBe("conv-789");

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.intercom.io/conversations");
      expect(options.method).toBe("POST");
      expect(options.headers["Authorization"]).toBe("Bearer test-token");
      expect(options.headers["Intercom-Version"]).toBe("2.10");
    });

    it("should handle Intercom API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("403");
    });
  });

  describe("createDisputeTicket - Both providers", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "both";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "zendesk-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.INTERCOM_ACCESS_TOKEN = "intercom-token";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";
    });

    it("should create tickets with both providers", async () => {
      const zendeskResponse = {
        ticket: {
          id: 12345,
          url: "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
          status: "new",
          created_at: "2024-01-15T11:05:00Z",
        },
      };

      const intercomResponse = {
        type: "conversation",
        id: "conv-789",
        created_at: 1705318800,
        source: {
          url: "https://app.intercom.com/a/inbox/conversation/conv-789",
        },
      };

      // Both calls succeed
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => zendeskResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => intercomResponse,
        });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(2);
      expect(result.results.filter((r) => r.success)).toHaveLength(2);
      // Zendesk should be primary
      expect(result.primaryTicketId).toBe("12345");
    });

    it("should use Intercom as fallback when Zendesk fails", async () => {
      const intercomResponse = {
        type: "conversation",
        id: "conv-789",
        created_at: 1705318800,
        source: {
          url: "https://app.intercom.com/a/inbox/conversation/conv-789",
        },
      };

      // Zendesk fails, Intercom succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => intercomResponse,
        });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(2);
      expect(result.results.filter((r) => r.success)).toHaveLength(1);
      // Intercom becomes primary since Zendesk failed
      expect(result.primaryTicketId).toBe("conv-789");
    });
  });

  describe("addZendeskComment", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";
    });

    it("should add a comment to a Zendesk ticket", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: { id: 12345 } }),
      });

      const service = new SupportService();
      const result = await service.addZendeskComment(
        "12345",
        "Status update: Investigation in progress",
        false,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
      );
      expect(options.method).toBe("PUT");
    });

    it("should handle errors when adding comments", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Ticket not found",
      });

      const service = new SupportService();
      const result = await service.addZendeskComment("99999", "Test comment");

      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
    });
  });

  describe("addIntercomReply", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "intercom";
      process.env.INTERCOM_ACCESS_TOKEN = "test-token";
      process.env.INTERCOM_ADMIN_ID = "admin-123";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";
    });

    it("should add a reply to an Intercom conversation", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: "conversation_part" }),
      });

      const service = new SupportService();
      const result = await service.addIntercomReply(
        "conv-789",
        "Investigation update",
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.intercom.io/conversations/conv-789/reply");
      expect(options.method).toBe("POST");
    });

    it("should handle errors when adding replies", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Conversation not found",
      });

      const service = new SupportService();
      const result = await service.addIntercomReply(
        "invalid-conv",
        "Test reply",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
    });

    it("should return error when Intercom is not configured", async () => {
      process.env.INTERCOM_ACCESS_TOKEN = "";

      const service = new SupportService();
      const result = await service.addIntercomReply("conv-123", "Test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("configuration incomplete");
    });

    it("should use custom adminId when provided", async () => {
      process.env.INTERCOM_ACCESS_TOKEN = "test-token";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: "conversation_part" }),
      });

      const service = new SupportService();
      const result = await service.addIntercomReply(
        "conv-789",
        "Test message",
        "custom-admin-456",
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.admin_id).toBe("custom-admin-456");
    });
  });

  describe("addZendeskComment - configuration incomplete", () => {
    it("should return error when Zendesk is not configured", async () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.ZENDESK_API_TOKEN = "";
      process.env.ZENDESK_USER_EMAIL = "";

      const service = new SupportService();
      const result = await service.addZendeskComment("12345", "Test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("configuration incomplete");
    });
  });

  describe("isConfigured - edge cases", () => {
    it("should return false for unknown provider", async () => {
      process.env.SUPPORT_PROVIDER = "unknown_provider";
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.INTERCOM_ACCESS_TOKEN = "";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(false);
    });

    it("should return true when only Intercom is configured in both mode", () => {
      process.env.SUPPORT_PROVIDER = "both";
      process.env.ZENDESK_SUBDOMAIN = "";
      process.env.ZENDESK_API_TOKEN = "";
      process.env.ZENDESK_USER_EMAIL = "";
      process.env.INTERCOM_ACCESS_TOKEN = "intercom-token";

      const service = new SupportService();
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("createDisputeTicket - edge cases", () => {
    it("should handle transaction with null userId", async () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";

      const transactionWithNullUser: Transaction = {
        ...mockTransaction,
        userId: null,
      };

      const mockResponse = {
        ticket: {
          id: 12345,
          url: "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
          status: "new",
          created_at: "2024-01-15T11:05:00Z",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        transactionWithNullUser,
      );

      expect(result.results[0].success).toBe(true);
    });

    it("should handle dispute with null optional fields", async () => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";

      const disputeWithNulls: Dispute = {
        ...mockDispute,
        category: null,
        reportedBy: null,
      };

      const mockResponse = {
        ticket: {
          id: 12345,
          url: "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
          status: "new",
          created_at: "2024-01-15T11:05:00Z",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        disputeWithNulls,
        mockTransaction,
      );

      expect(result.results[0].success).toBe(true);
    });

    it("should handle Intercom conversation without userExternalId", async () => {
      process.env.SUPPORT_PROVIDER = "intercom";
      process.env.INTERCOM_ACCESS_TOKEN = "test-token";
      process.env.INTERCOM_ADMIN_ID = "admin-123";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";

      const mockResponse = {
        type: "conversation",
        id: "conv-789",
        created_at: 1705318800,
        source: {
          url: "https://app.intercom.com/a/inbox/conversation/conv-789",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const service = new SupportService();
      // Call without userExternalId - should use admin-initiated conversation
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
        undefined,
        undefined, // no userExternalId
      );

      expect(result.results[0].success).toBe(true);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.from.type).toBe("admin");
    });

    it("should handle Promise.allSettled rejection in both mode", async () => {
      process.env.SUPPORT_PROVIDER = "both";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "zendesk-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.INTERCOM_ACCESS_TOKEN = "intercom-token";
      process.env.SUPPORT_RETRY_ATTEMPTS = "1";

      // Both fail with network errors
      mockFetch
        .mockRejectedValueOnce(new Error("Network error"))
        .mockRejectedValueOnce(new Error("Connection refused"));

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results).toHaveLength(2);
      expect(result.results.filter((r) => r.success)).toHaveLength(0);
      expect(result.primaryTicketId).toBeUndefined();
    });
  });

  describe("retry logic", () => {
    beforeEach(() => {
      process.env.SUPPORT_PROVIDER = "zendesk";
      process.env.ZENDESK_SUBDOMAIN = "testcompany";
      process.env.ZENDESK_API_TOKEN = "test-token";
      process.env.ZENDESK_USER_EMAIL = "admin@test.com";
      process.env.SUPPORT_API_TIMEOUT_MS = "5000";
      process.env.SUPPORT_RETRY_ATTEMPTS = "3";
      process.env.SUPPORT_RETRY_DELAY_MS = "100";
    });

    it("should retry on server errors and eventually succeed", async () => {
      const mockResponse = {
        ticket: {
          id: 12345,
          url: "https://testcompany.zendesk.com/api/v2/tickets/12345.json",
          status: "new",
          created_at: "2024-01-15T11:05:00Z",
        },
      };

      // Fail twice with 500, then succeed
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockResponse,
        });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results[0].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should not retry on 4xx client errors", async () => {
      process.env.SUPPORT_RETRY_ATTEMPTS = "3";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      const service = new SupportService();
      const result = await service.createDisputeTicket(
        mockDispute,
        mockTransaction,
      );

      expect(result.results[0].success).toBe(false);
      // Should only try once for 4xx errors
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

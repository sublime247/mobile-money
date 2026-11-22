import {
  CustomerService,
  customerEvents,
  Sep12CustomerStatus,
  CustomerStatusTransitionEvent,
} from "../../src/services/customerService";
import {
  deliverCustomerCallback,
  CustomerCallbackJobData,
} from "../../src/queue/customerCallbackQueue";
import { verifyWebhookSignature } from "../../src/utils/webhookSigner";

describe("CustomerService & KYC Callback Notifications (SEP-12 / Issue #2267)", () => {
  let customerService: CustomerService;
  let dispatchedJobs: CustomerCallbackJobData[];

  beforeEach(() => {
    dispatchedJobs = [];
    customerService = new CustomerService({
      enqueueFn: async (data: CustomerCallbackJobData) => {
        dispatchedJobs.push(data);
      },
    });
    customerEvents.removeAllListeners();
  });

  afterEach(() => {
    customerEvents.removeAllListeners();
  });

  describe("Internal Event Emission on KYC Status Transitions", () => {
    it("should emit an internal event when customer status transitions from PENDING to ACCEPTED", async () => {
      const eventSpy = jest.fn();
      const approvedSpy = jest.fn();

      customerEvents.on("customer:status_changed", eventSpy);
      customerEvents.on("customer:accepted", approvedSpy);

      const result = await customerService.transitionCustomerStatus({
        customerId: "cust-123",
        account: "GBX...123",
        previousStatus: Sep12CustomerStatus.PROCESSING,
        currentStatus: Sep12CustomerStatus.ACCEPTED,
        reason: "KYC documents verified and approved",
      });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      const emittedEvent: CustomerStatusTransitionEvent = eventSpy.mock.calls[0][0];
      expect(emittedEvent.customerId).toBe("cust-123");
      expect(emittedEvent.previousStatus).toBe(Sep12CustomerStatus.PROCESSING);
      expect(emittedEvent.currentStatus).toBe(Sep12CustomerStatus.ACCEPTED);
      expect(emittedEvent.reason).toBe("KYC documents verified and approved");

      expect(approvedSpy).toHaveBeenCalledTimes(1);
      expect(result.event.currentStatus).toBe(Sep12CustomerStatus.ACCEPTED);
    });

    it("should emit an internal event when customer status transitions from PENDING to REJECTED", async () => {
      const eventSpy = jest.fn();
      const rejectedSpy = jest.fn();

      customerEvents.on("customer:status_changed", eventSpy);
      customerEvents.on("customer:rejected", rejectedSpy);

      const result = await customerService.transitionCustomerStatus({
        customerId: "cust-456",
        account: "GBX...456",
        previousStatus: Sep12CustomerStatus.PROCESSING,
        currentStatus: Sep12CustomerStatus.REJECTED,
        reason: "Document expired",
      });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      const emittedEvent: CustomerStatusTransitionEvent = eventSpy.mock.calls[0][0];
      expect(emittedEvent.customerId).toBe("cust-456");
      expect(emittedEvent.previousStatus).toBe(Sep12CustomerStatus.PROCESSING);
      expect(emittedEvent.currentStatus).toBe(Sep12CustomerStatus.REJECTED);
      expect(emittedEvent.reason).toBe("Document expired");

      expect(rejectedSpy).toHaveBeenCalledTimes(1);
      expect(result.event.currentStatus).toBe(Sep12CustomerStatus.REJECTED);
    });

    it("should handle handleKycStatusChange convenience mapping", async () => {
      const eventSpy = jest.fn();
      customerEvents.on("customer:accepted", eventSpy);

      const result = await customerService.handleKycStatusChange(
        "cust-789",
        "approved",
        "pending",
        "Auto-approved via tier 1 check",
      );

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(result.event.currentStatus).toBe(Sep12CustomerStatus.ACCEPTED);
    });
  });

  describe("Triggering Client Webhook Callbacks & Background Queue Dispatch", () => {
    it("should dispatch webhook callback job to background queue for registered client", async () => {
      customerService.registerClientCallback({
        id: "reg-1",
        customerId: "cust-approval-1",
        callbackUrl: "https://partner.example.com/webhooks/kyc",
        secret: "test_secret_key_12345",
      });

      const result = await customerService.transitionCustomerStatus({
        customerId: "cust-approval-1",
        account: "GACCOUNT123",
        previousStatus: "PENDING",
        currentStatus: "ACCEPTED",
        reason: "ID confirmed",
      });

      expect(result.dispatchedCallbacks).toBe(1);
      expect(dispatchedJobs).toHaveLength(1);

      const job = dispatchedJobs[0];
      expect(job.customerId).toBe("cust-approval-1");
      expect(job.callbackUrl).toBe("https://partner.example.com/webhooks/kyc");
      expect(job.status).toBe("ACCEPTED");
      expect(job.secret).toBe("test_secret_key_12345");
      expect(job.payload).toMatchObject({
        event: "customer.kyc.accepted",
        customer_id: "cust-approval-1",
        account: "GACCOUNT123",
        status: "ACCEPTED",
        previous_status: "PENDING",
        reason: "ID confirmed",
      });
    });

    it("should dispatch for multiple registered clients matching account or customer", async () => {
      customerService.registerClientCallback({
        id: "reg-cust",
        customerId: "cust-shared",
        callbackUrl: "https://client-a.com/kyc",
        secret: "secret-a",
      });
      customerService.registerClientCallback({
        id: "reg-acct",
        account: "GACT_SHARED",
        callbackUrl: "https://client-b.com/kyc",
        secret: "secret-b",
      });

      const result = await customerService.transitionCustomerStatus({
        customerId: "cust-shared",
        account: "GACT_SHARED",
        previousStatus: "PENDING",
        currentStatus: "REJECTED",
        reason: "Sanction screening match",
      });

      expect(result.dispatchedCallbacks).toBe(2);
      expect(dispatchedJobs).toHaveLength(2);
      expect(dispatchedJobs[0].payload.event).toBe("customer.kyc.rejected");
      expect(dispatchedJobs[1].payload.event).toBe("customer.kyc.rejected");
    });
  });

  describe("HMAC Signature Attachment & Delivery Verification", () => {
    it("should attach valid HMAC signature headers to callback requests", async () => {
      const secret = "super_secret_webhook_signing_key";
      const payload = {
        event: "customer.kyc.accepted",
        customer_id: "cust-signed-1",
        status: "ACCEPTED",
      };
      const timestamp = Math.floor(Date.now() / 1000);

      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";

      const mockFetch = jest.fn().mockImplementation(async (url, init) => {
        capturedHeaders = init.headers;
        capturedBody = init.body;
        return {
          ok: true,
          status: 200,
          text: async () => "OK",
        };
      });

      const deliveryResult = await deliverCustomerCallback(
        {
          customerId: "cust-signed-1",
          callbackUrl: "https://valid-partner.com/webhook",
          secret,
          status: "ACCEPTED",
          previousStatus: "PENDING",
          payload,
          timestamp,
        },
        mockFetch as unknown as typeof fetch,
      );

      expect(deliveryResult.status).toBe("delivered");
      expect(deliveryResult.statusCode).toBe(200);

      // Verify HMAC signature headers are present
      expect(capturedHeaders["X-Momo-Signature"]).toBeDefined();
      expect(capturedHeaders["X-Momo-Timestamp"]).toBe(String(timestamp));
      expect(capturedHeaders["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Validate HMAC signature verification
      const isValid = verifyWebhookSignature(
        capturedBody,
        capturedHeaders["X-Momo-Signature"],
        capturedHeaders["X-Momo-Timestamp"],
        secret,
        timestamp,
      );
      expect(isValid).toBe(true);
    });

    it("should simulate KYC rejection delivery with reason and HMAC signature", async () => {
      const secret = "rejection_test_secret";
      const payload = {
        event: "customer.kyc.rejected",
        customer_id: "cust-reject-99",
        status: "REJECTED",
        reason: "Forged utility bill",
      };
      const timestamp = Math.floor(Date.now() / 1000);

      let sentHeaders: Record<string, string> = {};

      const mockFetch = jest.fn().mockImplementation(async (_url, init) => {
        sentHeaders = init.headers;
        return {
          ok: true,
          status: 200,
          text: async () => "Accepted",
        };
      });

      const deliveryResult = await deliverCustomerCallback(
        {
          customerId: "cust-reject-99",
          callbackUrl: "https://compliance-monitor.org/kyc-events",
          secret,
          status: "REJECTED",
          previousStatus: "PENDING",
          payload,
          timestamp,
        },
        mockFetch as unknown as typeof fetch,
      );

      expect(deliveryResult.status).toBe("delivered");
      expect(sentHeaders["X-Momo-Signature"]).toBeDefined();
      expect(sentHeaders["X-Webhook-Signature"]).toContain("sha256=");
    });

    it("should block callback delivery to loopback or private network under SSRF protection", async () => {
      const deliveryResult = await deliverCustomerCallback({
        customerId: "cust-ssrf",
        callbackUrl: "http://127.0.0.1:8080/internal-admin",
        secret: "secret",
        status: "ACCEPTED",
        previousStatus: "PENDING",
        payload: { test: true },
        timestamp: Math.floor(Date.now() / 1000),
      });

      expect(deliveryResult.status).toBe("blocked");
      expect(deliveryResult.error).toBeDefined();
    });
  });
});

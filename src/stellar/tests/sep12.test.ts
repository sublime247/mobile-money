/**
 * SEP-12 customer status webhook callbacks (#2427)
 *
 * When a customer's KYC review moves from PENDING to ACCEPTED or REJECTED,
 * registered partner anchors receive an HMAC-signed webhook queued in BullMQ.
 */
import { Pool } from "pg";
import { UnrecoverableError } from "bullmq";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../security/ssrf", () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../models/users");

import {
  Sep12CustomerStatus,
  Sep12Service,
  Sep12StatusWebhookPayloadSchema,
  attachKycStatusWebhookTrigger,
  createSep12Router,
  detachKycStatusWebhookTrigger,
  defaultCustomerService,
} from "../sep12";
import { CustomerService } from "../../services/customerService";
import KYCService, { KYCLevel, KYCStatus } from "../../services/kyc";
import {
  KYC_STATUS_UPDATED,
  KycStatusUpdatedEvent,
  emitKycStatusUpdated,
  kycStatusEvents,
} from "../../services/kycStatusEvents";
import {
  CustomerCallbackJobData,
  customerCallbackQueue,
  deliverCustomerCallback,
  enqueueCustomerCallback,
  processCustomerCallbackJob,
} from "../../queue/customerCallbackQueue";
import { verifyWebhookSignature } from "../../utils/webhookSigner";

const ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PARTNER_URL = "https://partner-anchor.example.com/kyc-callbacks";
const PARTNER_SECRET = "partner-shared-hmac-secret";

function mockDb(): jest.Mocked<Pool> {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ stellar_address: ACCOUNT }] }),
  } as any;
}

function statusEvent(
  overrides: Partial<KycStatusUpdatedEvent> = {},
): KycStatusUpdatedEvent {
  return {
    applicantId: "applicant-1",
    userId: "customer-1",
    previousStatus: KYCStatus.PENDING,
    status: KYCStatus.APPROVED,
    kycLevel: KYCLevel.FULL,
    rejectionReason: null,
    source: "workflow_run.completed",
    ...overrides,
  };
}

/** Wait for fire-and-forget listeners to settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SEP-12 customer status webhooks", () => {
  let jobs: CustomerCallbackJobData[];
  let customerService: CustomerService;
  let db: jest.Mocked<Pool>;
  let service: Sep12Service;

  beforeEach(() => {
    jobs = [];
    customerService = new CustomerService({
      enqueueFn: async (data) => {
        jobs.push(data);
      },
    });
    customerService.registerClientCallback({
      id: "partner-1",
      callbackUrl: PARTNER_URL,
      secret: PARTNER_SECRET,
    });
    db = mockDb();
    service = new Sep12Service(db, customerService);
  });

  afterEach(() => {
    detachKycStatusWebhookTrigger();
    jest.restoreAllMocks();
  });

  describe("webhook trigger", () => {
    it("dispatches a signed ACCEPTED webhook when KYC is approved", async () => {
      attachKycStatusWebhookTrigger(service);

      emitKycStatusUpdated(statusEvent());
      await flush();

      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.callbackUrl).toBe(PARTNER_URL);
      expect(job.secret).toBe(PARTNER_SECRET);
      expect(job.status).toBe(Sep12CustomerStatus.ACCEPTED);
      expect(job.previousStatus).toBe(Sep12CustomerStatus.PROCESSING);

      const payload = Sep12StatusWebhookPayloadSchema.parse(job.payload);
      expect(payload).toMatchObject({
        event: "customer.kyc.accepted",
        customer_id: "customer-1",
        account: ACCOUNT,
        status: Sep12CustomerStatus.ACCEPTED,
        reason: null,
      });
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT stellar_address FROM users"),
        ["customer-1"],
      );
    });

    it("includes the failure reason when KYC is rejected", async () => {
      attachKycStatusWebhookTrigger(service);

      emitKycStatusUpdated(
        statusEvent({
          status: KYCStatus.REJECTED,
          rejectionReason: "Fraudulent Document",
        }),
      );
      await flush();

      expect(jobs).toHaveLength(1);
      const payload = Sep12StatusWebhookPayloadSchema.parse(jobs[0].payload);
      expect(payload).toMatchObject({
        event: "customer.kyc.rejected",
        customer_id: "customer-1",
        status: Sep12CustomerStatus.REJECTED,
        reason: "Fraudulent Document",
      });
    });

    it("falls back to a generic reason for rejections without one", async () => {
      const result = await service.notifyCustomerStatusChange(
        statusEvent({ status: KYCStatus.REJECTED, rejectionReason: null }),
      );

      expect(result?.dispatchedCallbacks).toBe(1);
      expect(jobs[0].payload.reason).toBe("Customer verification was rejected");
    });

    it.each([
      ["still under review", { status: KYCStatus.REVIEW }],
      ["approved below the required KYC level", { kycLevel: KYCLevel.BASIC }],
      ["unchanged status", { previousStatus: KYCStatus.APPROVED }],
      [
        "repeat rejection",
        { previousStatus: KYCStatus.REJECTED, status: KYCStatus.REJECTED },
      ],
      ["applicant not linked to a customer", { userId: null }],
    ])("does not dispatch for %s", async (_label, overrides) => {
      const result = await service.notifyCustomerStatusChange(
        statusEvent(overrides as Partial<KycStatusUpdatedEvent>),
      );

      expect(result).toBeNull();
      expect(jobs).toHaveLength(0);
    });

    it("still dispatches when the account lookup fails", async () => {
      db.query.mockRejectedValueOnce(new Error("db down"));

      const result = await service.notifyCustomerStatusChange(statusEvent());

      expect(result?.dispatchedCallbacks).toBe(1);
      expect(jobs[0].payload.account).toBeNull();
    });

    it("keeps a single active trigger across router re-creation", async () => {
      const transition = jest
        .spyOn(defaultCustomerService, "transitionCustomerStatus")
        .mockResolvedValue({ event: {} as any, dispatchedCallbacks: 1 });

      createSep12Router(mockDb());
      createSep12Router(mockDb());
      expect(kycStatusEvents.listenerCount(KYC_STATUS_UPDATED)).toBe(1);

      emitKycStatusUpdated(statusEvent());
      await flush();

      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "customer-1",
          currentStatus: Sep12CustomerStatus.ACCEPTED,
        }),
      );
    });

    it("detaching stops further webhooks", async () => {
      const detach = attachKycStatusWebhookTrigger(service);
      detach();

      emitKycStatusUpdated(statusEvent());
      await flush();

      expect(jobs).toHaveLength(0);
      expect(kycStatusEvents.listenerCount(KYC_STATUS_UPDATED)).toBe(0);
    });
  });

  describe("KYC service status updates", () => {
    it("emits a status update with the previous status when verification is persisted", async () => {
      const kycDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                user_id: "customer-1",
                kyc_level: "full",
                previous_status: KYCStatus.PENDING,
              },
            ],
          })
          .mockResolvedValue({ rows: [] }),
      } as any;
      const kycService = new KYCService(kycDb);
      jest.spyOn(kycService, "updateUserKYCLevel").mockResolvedValue();

      attachKycStatusWebhookTrigger(service);
      await (kycService as any).persistVerificationStatus(
        "applicant-1",
        {
          status: KYCStatus.APPROVED,
          level: KYCLevel.FULL,
          rejectionReason: null,
          checks: [],
          reports: [],
        },
        "workflow_run.completed",
      );
      await flush();

      expect(kycDb.query.mock.calls[0][0]).toContain(
        "(SELECT verification_status FROM previous) AS previous_status",
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({
        customer_id: "customer-1",
        status: Sep12CustomerStatus.ACCEPTED,
      });
    });
  });

  describe("payload schema", () => {
    const base = {
      event: "customer.kyc.rejected",
      event_id: "evt-1",
      customer_id: "customer-1",
      account: ACCOUNT,
      previous_status: "PROCESSING",
      current_status: "REJECTED",
      status: "REJECTED",
      reason: "Forged document",
      timestamp: new Date().toISOString(),
    };

    it("accepts a rejection payload with a reason", () => {
      expect(Sep12StatusWebhookPayloadSchema.safeParse(base).success).toBe(true);
    });

    it("rejects non-terminal statuses", () => {
      expect(
        Sep12StatusWebhookPayloadSchema.safeParse({
          ...base,
          status: "PROCESSING",
          current_status: "PROCESSING",
        }).success,
      ).toBe(false);
    });

    it("rejects a reason on an ACCEPTED payload", () => {
      expect(
        Sep12StatusWebhookPayloadSchema.safeParse({
          ...base,
          event: "customer.kyc.accepted",
          status: "ACCEPTED",
          current_status: "ACCEPTED",
        }).success,
      ).toBe(false);
    });
  });

  describe("signed delivery and retries", () => {
    function jobData(): CustomerCallbackJobData {
      return {
        customerId: "customer-1",
        status: "REJECTED",
        previousStatus: "PROCESSING",
        callbackUrl: PARTNER_URL,
        secret: PARTNER_SECRET,
        payload: { customer_id: "customer-1", status: "REJECTED", reason: "x" },
        timestamp: Math.floor(Date.now() / 1000),
      };
    }

    function respond(status: number) {
      return jest.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: async () => "",
      }) as unknown as jest.Mock & typeof fetch;
    }

    it("signs the body with the partner's HMAC secret", async () => {
      const fetchFn = respond(200);
      const data = jobData();

      await expect(deliverCustomerCallback(data, fetchFn)).resolves.toMatchObject({
        status: "delivered",
      });

      const init = fetchFn.mock.calls[0][1];
      expect(
        verifyWebhookSignature(
          init.body,
          init.headers["X-Momo-Signature"],
          init.headers["X-Momo-Timestamp"],
          PARTNER_SECRET,
          data.timestamp,
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(
          init.body,
          init.headers["X-Momo-Signature"],
          init.headers["X-Momo-Timestamp"],
          "wrong-secret",
          data.timestamp,
        ),
      ).toBe(false);
    });

    it.each([500, 502, 503, 408, 429])(
      "retries transient partner failure HTTP %i",
      async (status) => {
        const error = await processCustomerCallbackJob(
          { data: jobData() },
          respond(status),
        ).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
      },
    );

    it("retries network errors", async () => {
      const fetchFn = jest
        .fn()
        .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
      const error = await processCustomerCallbackJob(
        { data: jobData() },
        fetchFn,
      ).catch((e) => e);
      expect(error.message).toBe("ECONNRESET");
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    });

    it.each([400, 401, 404, 410])(
      "does not retry permanent partner failure HTTP %i",
      async (status) => {
        await expect(
          processCustomerCallbackJob({ data: jobData() }, respond(status)),
        ).rejects.toBeInstanceOf(UnrecoverableError);
      },
    );

    it("queues deliveries in BullMQ with retry and backoff", async () => {
      const add = jest
        .spyOn(customerCallbackQueue, "add")
        .mockResolvedValue({} as any);

      await enqueueCustomerCallback(jobData());

      expect(add).toHaveBeenCalledWith(
        "deliver-customer-callback",
        expect.objectContaining({ customerId: "customer-1" }),
        expect.objectContaining({
          attempts: 5,
          backoff: { type: "exponential", delay: 2000 },
        }),
      );
    });
  });
});

afterAll(async () => {
  await customerCallbackQueue.close().catch(() => undefined);
});

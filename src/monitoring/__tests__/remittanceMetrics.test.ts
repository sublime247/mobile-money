import { register } from "../../utils/metrics";
import {
  classifyProviderFailure,
  normalizeCorridor,
  normalizeMetricLabel,
  providerRequestErrorsTotal,
  recordProviderRequestError,
  recordRemittanceStep,
  remittanceStepDurationSeconds,
  timeRemittanceStep,
} from "../remittanceMetrics";
import { BatchTransactionService } from "../../services/batchTransactionService";
import { MobileMoneyService } from "../../services/mobilemoney/mobileMoneyService";

jest.mock("../../services/mobilemoney/mobileMoneyService");
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

const MockMobileMoneyService = MobileMoneyService as jest.MockedClass<
  typeof MobileMoneyService
>;

async function counterValue(labels: Record<string, string>): Promise<number> {
  const metric = await providerRequestErrorsTotal.get();
  const match = metric.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

async function histogramCount(labels: Record<string, string>): Promise<number> {
  const metric = await remittanceStepDurationSeconds.get();
  const match = metric.values.find(
    (v) =>
      v.metricName === "remittance_step_duration_seconds_count" &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

beforeEach(() => {
  providerRequestErrorsTotal.reset();
  remittanceStepDurationSeconds.reset();
});

describe("label normalisation", () => {
  it("lowercases and strips characters that would inflate cardinality", () => {
    expect(normalizeMetricLabel("KE/UG +256 ")).toBe("ke_ug_256");
    expect(normalizeCorridor("NG-GH")).toBe("ng-gh");
  });

  it("falls back to unknown for empty or non-string input", () => {
    expect(normalizeMetricLabel("   ")).toBe("unknown");
    expect(normalizeMetricLabel("!!!")).toBe("unknown");
    expect(normalizeCorridor(undefined)).toBe("unknown");
    expect(normalizeCorridor(42)).toBe("unknown");
  });

  it("caps label length", () => {
    expect(normalizeMetricLabel("a".repeat(200))).toHaveLength(64);
  });
});

describe("remittance step histogram", () => {
  it("records a step duration under its corridor and step labels", async () => {
    recordRemittanceStep("KE-UG", "provider_call", 0.42);
    recordRemittanceStep("KE-UG", "provider_call", 1.1);

    expect(await histogramCount({ corridor: "ke-ug", step: "provider_call" })).toBe(2);
    expect(await histogramCount({ corridor: "ke-ug", step: "other" })).toBe(0);
  });

  it("discards negative, NaN and infinite durations", async () => {
    recordRemittanceStep("ke", "provider_call", -1);
    recordRemittanceStep("ke", "provider_call", Number.NaN);
    recordRemittanceStep("ke", "provider_call", Number.POSITIVE_INFINITY);

    expect(await histogramCount({ corridor: "ke", step: "provider_call" })).toBe(0);
  });

  it("times an async step and still records it when the step throws", async () => {
    let tick = 0;
    const now = () => tick;

    const ok = await timeRemittanceStep(
      "ng",
      "stellar_confirmation",
      async () => {
        tick += 2;
        return "done";
      },
      now,
    );
    expect(ok).toBe("done");

    await expect(
      timeRemittanceStep(
        "ng",
        "stellar_confirmation",
        async () => {
          tick += 1;
          throw new Error("horizon down");
        },
        now,
      ),
    ).rejects.toThrow("horizon down");

    expect(await histogramCount({ corridor: "ng", step: "stellar_confirmation" })).toBe(2);
  });
});

describe("provider request error counter", () => {
  it("increments by provider, status and error code", async () => {
    recordProviderRequestError("mtn", "failed", "provider_error");
    recordProviderRequestError("mtn", "failed", "provider_error");
    recordProviderRequestError("mtn", "timeout", "timeout");

    expect(
      await counterValue({ provider: "mtn", status: "failed", error_code: "provider_error" }),
    ).toBe(2);
    expect(
      await counterValue({ provider: "mtn", status: "timeout", error_code: "timeout" }),
    ).toBe(1);
    expect(
      await counterValue({ provider: "airtel", status: "failed", error_code: "provider_error" }),
    ).toBe(0);
  });

  it("classifies timeouts separately from other provider failures", () => {
    expect(classifyProviderFailure("Item k timed out after 30000ms")).toEqual({
      status: "timeout",
      errorCode: "timeout",
    });
    expect(classifyProviderFailure(new Error("request timeout"))).toEqual({
      status: "timeout",
      errorCode: "timeout",
    });
    expect(classifyProviderFailure("Insufficient funds")).toEqual({
      status: "failed",
      errorCode: "provider_error",
    });
  });

  it("is exposed on the application registry", async () => {
    recordProviderRequestError("mpesa", "500", "upstream");
    const exposition = await register.metrics();

    expect(exposition).toContain("# TYPE provider_request_errors_total counter");
    expect(exposition).toContain("# TYPE remittance_step_duration_seconds histogram");
  });
});

describe("batch transaction instrumentation", () => {
  it("records step timing and provider failures for each batch item", async () => {
    const service = new BatchTransactionService(
      new MockMobileMoneyService() as unknown as MobileMoneyService,
    );
    const mockService = (service as unknown as { mobileMoneyService: { initiatePayment: jest.Mock } })
      .mobileMoneyService;
    mockService.initiatePayment = jest
      .fn()
      .mockResolvedValueOnce({ success: true, data: { reference: "ok-1" } })
      .mockResolvedValueOnce({ success: false, error: "Insufficient funds" });

    const report = await service.submitBatch("deposit", [
      {
        idempotencyKey: "k1",
        phoneNumber: "+254700000001",
        amount: "100",
        provider: "mpesa",
        metadata: { corridor: "KE-UG" },
      },
      {
        idempotencyKey: "k2",
        phoneNumber: "+254700000002",
        amount: "100",
        provider: "mpesa",
        metadata: { corridor: "KE-UG" },
      },
    ]);

    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(await histogramCount({ corridor: "ke-ug", step: "provider_call" })).toBe(2);
    expect(
      await counterValue({ provider: "mpesa", status: "failed", error_code: "provider_error" }),
    ).toBe(1);
  });

  it("labels items without corridor metadata as unknown", async () => {
    const service = new BatchTransactionService(
      new MockMobileMoneyService() as unknown as MobileMoneyService,
    );
    (service as unknown as { mobileMoneyService: { sendPayout: jest.Mock } })
      .mobileMoneyService.sendPayout = jest.fn().mockResolvedValue({ success: true, data: {} });

    await service.submitBatch("withdraw", [
      { idempotencyKey: "w1", phoneNumber: "+254700000003", amount: "50", provider: "mtn" },
    ]);

    expect(await histogramCount({ corridor: "unknown", step: "provider_call" })).toBe(1);
  });
});

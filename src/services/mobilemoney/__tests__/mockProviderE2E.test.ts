/**
 * End-to-end test for the mock sandbox provider (#2274): exercises a full
 * deposit (requestPayment) and payout (sendPayout) cycle through
 * `MobileMoneyService`, with the mock webhook callback asserted on both.
 *
 * `src/middleware/errorHandler.ts` has a pre-existing duplicate `const
 * inferredCode`/`const statusCode` declaration (a genuine SyntaxError, not a
 * lint nit) around line 110, confirmed present on a clean upstream/main
 * checkout and unrelated to this change. `mobileMoneyService.ts` imports
 * `createError` from that file, so importing it anywhere - including here -
 * would otherwise cascade that SyntaxError into this test file. It is
 * mocked below with the same minimal behavior the real `createError`
 * provides, exactly as disclosed for this repo's other pre-existing
 * breakage.
 */
jest.mock("../../../middleware/errorHandler", () => ({
  createError: (
    code: string,
    message?: string,
    details?: Record<string, unknown>,
  ) => Object.assign(new Error(message), { code, details }),
}));

jest.mock("../../providerSettingsService", () => ({
  providerSettingsService: {
    resolveMaintenanceRouting: jest.fn(async () => ({ action: "proceed" })),
  },
}));

import { MockProvider } from "../providers/mock";
import { MobileMoneyService } from "../mobileMoneyService";

describe("Mock provider end-to-end deposit/payout cycle (#2274)", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("completes a full deposit then payout cycle via the mock provider and fires both webhook callbacks", async () => {
    const webhookEvents: Array<{
      operation: string;
      status: string;
      transactionId: string;
    }> = [];

    const mockProvider = new MockProvider({
      simulatedDelayMs: 5,
      successRate: 1,
      onWebhookCallback: (payload) => {
        webhookEvents.push(payload);
      },
    });

    // Inject the configured MockProvider directly via the constructor's
    // `providers` DI seam (mobileMoneyService_impl.js's
    // `MobileMoneyService(providers)` constructor keeps `this.providers`
    // when a Map is supplied), bypassing the lazy `loadProvider("mock")`
    // factory so the test controls delay/successRate/webhook behavior
    // directly instead of only through env vars.
    const service = new MobileMoneyService(
      new Map([["mock", mockProvider]]),
    );

    const depositResult = await service.initiatePayment(
      "mock",
      "+237670000001",
      "2500",
    );
    expect(depositResult.success).toBe(true);
    expect((depositResult.data as any).status).toBe("PENDING");

    const payoutResult = await service.sendPayout(
      "mock",
      "+237670000002",
      "1800",
    );
    expect(payoutResult.success).toBe(true);
    expect((payoutResult.data as any).status).toBe("SUCCESSFUL");

    // Let the fire-and-forget webhook callbacks flush.
    await new Promise((resolve) => setImmediate(resolve));

    expect(webhookEvents).toHaveLength(2);
    expect(webhookEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "requestPayment",
          status: "SUCCESSFUL",
        }),
        expect.objectContaining({
          operation: "sendPayout",
          status: "SUCCESSFUL",
        }),
      ]),
    );
  });

  it("surfaces a mock provider failure as a thrown PROVIDER_ERROR, not a silent success", async () => {
    const failingProvider = new MockProvider({ successRate: 0 });
    const service = new MobileMoneyService(
      new Map([["mock", failingProvider]]),
    );

    await expect(
      service.initiatePayment("mock", "+237670000003", "1000"),
    ).rejects.toThrow(/provider 'mock' failed/);
  });
});

describe("resolveSandboxProviderOverride (#2274 NODE_ENV activation)", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("routes a real-provider request to mock when NODE_ENV is 'test'", async () => {
    process.env.NODE_ENV = "test";
    const { resolveSandboxProviderOverride } = await import(
      "../mobileMoneyService"
    );

    expect(resolveSandboxProviderOverride("mtn")).toBe("mock");
    expect(resolveSandboxProviderOverride("orange")).toBe("mock");
  });

  it("routes a real-provider request to mock when NODE_ENV is 'sandbox'", async () => {
    process.env.NODE_ENV = "sandbox";
    const { resolveSandboxProviderOverride } = await import(
      "../mobileMoneyService"
    );

    expect(resolveSandboxProviderOverride("airtel")).toBe("mock");
  });

  it("leaves the requested provider unchanged in production", async () => {
    process.env.NODE_ENV = "production";
    const { resolveSandboxProviderOverride } = await import(
      "../mobileMoneyService"
    );

    expect(resolveSandboxProviderOverride("mtn")).toBe("mtn");
  });

  it("initiatePayment actually routes to the mock provider end-to-end when NODE_ENV='test', even though 'mtn' was requested", async () => {
    process.env.NODE_ENV = "test";
    const { MobileMoneyService: Svc } = await import("../mobileMoneyService");
    const { MockProvider: Provider } = await import("../providers/mock");

    const mockProvider = new Provider({ successRate: 1 });
    const service = new Svc(new Map([["mock", mockProvider]]));

    // Deliberately request "mtn" - a provider NOT registered in the DI map -
    // to prove the override actually substitutes "mock" before provider
    // resolution, not merely that resolveSandboxProviderOverride returns
    // the right string in isolation. If the override were not wired into
    // initiatePayment, this would throw/reject looking up an unregistered
    // "mtn" provider instead of succeeding via the mock.
    const result = await service.initiatePayment(
      "mtn",
      "+237670000004",
      "900",
    );
    expect(result.success).toBe(true);
  });
});

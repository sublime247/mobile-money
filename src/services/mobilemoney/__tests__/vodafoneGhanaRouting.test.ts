import {
  isVodafoneGhanaRoute,
  routeVodafoneGhanaPayment,
  routeVodafoneGhanaPayout,
  getVodafoneGhanaTransactionStatus,
  setVodafoneGhanaProvider,
  getVodafoneGhanaProvider,
  isValidGhanaPhoneNumber,
  VODAFONE_GHANA_PROVIDER_KEY,
} from "../vodafoneGhanaRouting";
import { VodafoneGhanaProvider } from "../providers/vodafoneGhana";

const GH_PHONE = "+233241234567";

type FakeProvider = Pick<
  VodafoneGhanaProvider,
  "requestPayment" | "sendPayout" | "getTransactionStatus"
>;

function fakeProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  return {
    requestPayment: jest
      .fn<
        Promise<{ success: boolean; data?: unknown }>,
        [string, string, string?]
      >()
      .mockResolvedValue({ success: true, data: { transactionId: "vf-1" } }),
    sendPayout: jest
      .fn<Promise<{ success: boolean; data?: unknown }>, [string, string]>()
      .mockResolvedValue({ success: true, data: { transactionId: "out-1" } }),
    getTransactionStatus: jest
      .fn<Promise<{ status: string }>, [string]>()
      .mockResolvedValue({ status: "completed" }),
    ...overrides,
  };
}

afterEach(() => {
  setVodafoneGhanaProvider(null);
  jest.clearAllMocks();
});

describe("isValidGhanaPhoneNumber", () => {
  it("accepts a valid Ghanaian MSISDN", () => {
    expect(isValidGhanaPhoneNumber(GH_PHONE)).toBe(true);
  });

  it("rejects a non-Ghanaian MSISDN", () => {
    expect(isValidGhanaPhoneNumber("+221770000000")).toBe(false);
  });
});

describe("isVodafoneGhanaRoute", () => {
  it("routes when the vodafone_ghana provider key is explicitly chosen", () => {
    expect(
      isVodafoneGhanaRoute({ provider: VODAFONE_GHANA_PROVIDER_KEY }),
    ).toBe(true);
    expect(isVodafoneGhanaRoute({ provider: "VODAFONE_GHANA" })).toBe(true);
  });

  it("does not route when another provider is explicitly chosen", () => {
    expect(
      isVodafoneGhanaRoute({ provider: "mtn", phoneNumber: GH_PHONE }),
    ).toBe(false);
  });

  it("routes an unqualified request by Ghanaian MSISDN", () => {
    expect(isVodafoneGhanaRoute({ phoneNumber: GH_PHONE })).toBe(true);
    expect(isVodafoneGhanaRoute({ phoneNumber: "+221770000000" })).toBe(false);
    expect(isVodafoneGhanaRoute({})).toBe(false);
  });
});

describe("getVodafoneGhanaProvider", () => {
  it("returns a singleton VodafoneGhanaProvider by default", () => {
    const a = getVodafoneGhanaProvider();
    const b = getVodafoneGhanaProvider();
    expect(a).toBeInstanceOf(VodafoneGhanaProvider);
    expect(a).toBe(b);
  });
});

describe("routeVodafoneGhanaPayment", () => {
  it("delegates to the provider for a valid request", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayment(GH_PHONE, "50");

    expect(result.success).toBe(true);
    expect(provider.requestPayment).toHaveBeenCalledWith(
      GH_PHONE,
      "50",
      undefined,
    );
  });

  it("forwards a voucher code to the provider (#1961)", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayment(
      GH_PHONE,
      "50",
      "VOUCH-ROUTE-1",
    );

    expect(result.success).toBe(true);
    expect(provider.requestPayment).toHaveBeenCalledWith(
      GH_PHONE,
      "50",
      "VOUCH-ROUTE-1",
    );
  });

  it("rejects a non-Ghanaian phone number without calling the provider", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayment("+221770000000", "50");

    expect(result.success).toBe(false);
    expect(provider.requestPayment).not.toHaveBeenCalled();
  });

  it("rejects an amount above the configured maximum", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayment(GH_PHONE, "9999999999");

    expect(result.success).toBe(false);
    expect((result.error as Error).message).toMatch(/maximum/i);
    expect(provider.requestPayment).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric amount", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayment(GH_PHONE, "abc");

    expect(result.success).toBe(false);
    expect(provider.requestPayment).not.toHaveBeenCalled();
  });
});

describe("routeVodafoneGhanaPayout", () => {
  it("delegates payouts to the provider", async () => {
    const provider = fakeProvider();
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const result = await routeVodafoneGhanaPayout(GH_PHONE, 40);

    expect(result.success).toBe(true);
    expect(provider.sendPayout).toHaveBeenCalledWith(GH_PHONE, "40");
  });
});

describe("getVodafoneGhanaTransactionStatus", () => {
  it("proxies to the provider status lookup", async () => {
    const provider = fakeProvider({
      getTransactionStatus: jest
        .fn<Promise<{ status: string }>, [string]>()
        .mockResolvedValue({ status: "pending" }),
    });
    setVodafoneGhanaProvider(provider as unknown as VodafoneGhanaProvider);

    const status = await getVodafoneGhanaTransactionStatus("tx-123");

    expect(status).toEqual({ status: "pending" });
    expect(provider.getTransactionStatus).toHaveBeenCalledWith("tx-123");
  });
});

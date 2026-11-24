import axios from "axios";
import { MTNProvider } from "../mtn";

jest.mock("axios");

const axiosMock = axios as jest.Mocked<typeof axios>;

const env = { ...process.env };

interface PayCall {
  body: Record<string, unknown>;
  config: { headers: Record<string, string> };
}

/** Capture the body + config of the `requesttopay` POST. */
function mockMtn(): {
  getPayCall: () => PayCall | undefined;
} {
  let payCall: PayCall | undefined;

  (axiosMock.post as jest.Mock).mockImplementation(
    async (url: string, body?: unknown, config?: unknown) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "tok", expires_in: 3600 } };
      }
      if (String(url).includes("/collection/v1_0/requesttopay")) {
        payCall = { body, config } as PayCall;
        return { status: 202, data: {} };
      }
      throw new Error(`Unexpected axios.post url: ${String(url)}`);
    },
  );

  return { getPayCall: () => payCall };
}

describe("MTNProvider.requestPayment — MTN Cameroon integration", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env };
    process.env.MTN_API_KEY = "k";
    process.env.MTN_API_SECRET = "s";
    process.env.MTN_SUBSCRIPTION_KEY = "sub";
    process.env.MTN_TARGET_ENVIRONMENT = "sandbox";
    delete process.env.MTN_CURRENCY;
  });

  afterAll(() => {
    process.env = env;
  });

  it("settles in XAF by default (Cameroon)", async () => {
    const { getPayCall } = mockMtn();
    const provider = new MTNProvider();

    const result = await provider.requestPayment("+237670000001", "5000");

    expect(result.success).toBe(true);
    expect(getPayCall()?.body.currency).toBe("XAF");
  });

  it("honours the MTN_CURRENCY override for other MTN markets", async () => {
    process.env.MTN_CURRENCY = "UGX";
    const { getPayCall } = mockMtn();
    const provider = new MTNProvider();

    await provider.requestPayment("+256770000001", "5000");

    expect(getPayCall()?.body.currency).toBe("UGX");
  });

  it("authenticates the collection request with a bearer token", async () => {
    const { getPayCall } = mockMtn();
    const provider = new MTNProvider();

    await provider.requestPayment("+237670000001", "5000");

    expect(getPayCall()?.config.headers.Authorization).toBe("Bearer tok");
    expect(getPayCall()?.config.headers["X-Target-Environment"]).toBe(
      "sandbox",
    );
  });

  it("sends an X-Reference-Id and returns it for status polling", async () => {
    const { getPayCall } = mockMtn();
    const provider = new MTNProvider();

    const result = await provider.requestPayment("+237670000001", "5000");

    const headerRef = getPayCall()?.config.headers["X-Reference-Id"];
    expect(headerRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Same id echoed in the body and surfaced to the caller.
    expect(getPayCall()?.body.externalId).toBe(headerRef);
    expect((result as { referenceId?: string }).referenceId).toBe(headerRef);
  });

  it("propagates the X-Target-Environment from configuration", async () => {
    process.env.MTN_TARGET_ENVIRONMENT = "production";
    const { getPayCall } = mockMtn();
    const provider = new MTNProvider();

    await provider.requestPayment("+237670000001", "5000");

    expect(getPayCall()?.config.headers["X-Target-Environment"]).toBe(
      "production",
    );
  });

  it("still returns a reference id when the request fails", async () => {
    (axiosMock.post as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "tok", expires_in: 3600 } };
      }
      throw new Error("network down");
    });
    const provider = new MTNProvider();

    const result = await provider.requestPayment("+237670000001", "5000");

    expect(result.success).toBe(false);
    expect((result as { referenceId?: string }).referenceId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("refreshes the token and retries once when MTN returns 401", async () => {
    let tokenCalls = 0;
    const payAuthHeaders: string[] = [];
    (axiosMock.post as jest.Mock).mockImplementation(
      async (url: string, _body?: unknown, config?: any) => {
        if (String(url).includes("/collection/token/")) {
          tokenCalls += 1;
          return {
            data: { access_token: `tok-${tokenCalls}`, expires_in: 3600 },
          };
        }
        payAuthHeaders.push(config.headers.Authorization);
        if (payAuthHeaders.length === 1) {
          throw Object.assign(new Error("Unauthorized"), {
            response: { status: 401 },
          });
        }
        return { status: 202, data: {} };
      },
    );
    const provider = new MTNProvider();

    const result = await provider.requestPayment("+237670000001", "5000");

    expect(result.success).toBe(true);
    expect(tokenCalls).toBe(2);
    expect(payAuthHeaders).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });
});

import axios from "axios";
import { OrangeProvider } from "../../../../src/services/mobilemoney/providers/orange";

jest.mock("axios");

describe("OrangeProvider", () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  // Type guard that narrows the union returned by the provider
  function assertSuccess<T = any>(
    res: unknown,
  ): asserts res is { success: true; data?: T; reference?: string } {
    if (!res || (res as any).success !== true) {
      throw new Error("Expected successful response");
    }
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("requestPayment authenticates and returns success", async () => {
    const client: any = {
      post: jest.fn(),
      get: jest.fn(),
    };

    // axios.create should return our client
    mockedAxios.create.mockReturnValue(client as any);

    // First post call is /oauth/token
    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === "/oauth/token")
        return Promise.resolve({
          data: { access_token: "tok", expires_in: 3600 },
        });
      return Promise.reject(new Error("unexpected"));
    });

    // Second call is /v1/payments/collect
    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === "/v1/payments/collect")
        return Promise.resolve({
          data: { status: "PENDING", id: body.transaction.id },
        });
      return Promise.reject(new Error("unexpected"));
    });

    const p = new OrangeProvider();
    const res = await p.requestPayment("+237600000000", 1000);

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.data).toBeDefined();
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  test("sendPayout succeeds", async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === "/oauth/token")
        return Promise.resolve({
          data: { access_token: "tok2", expires_in: 3600 },
        });
      return Promise.reject(new Error("unexpected"));
    });

    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === "/v1/payments/disburse")
        return Promise.resolve({
          data: { status: "SUCCESS", id: body.transaction.id },
        });
      return Promise.reject(new Error("unexpected"));
    });

    const p = new OrangeProvider();
    const res = await p.sendPayout("+237600000001", 500);

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.reference).toBeDefined();
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  test("checkStatus returns data", async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockResolvedValue({
      data: { access_token: "tok3", expires_in: 3600 },
    });
    client.get.mockResolvedValue({ data: { status: "COMPLETED" } });

    const p = new OrangeProvider();
    const res = await p.checkStatus("REF-123");

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.data).toEqual({ status: "COMPLETED" });
  });

  test("retries on 5xx then succeeds", async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    // Auth
    client.post.mockImplementationOnce((url: string) => {
      if (url === "/oauth/token")
        return Promise.resolve({
          data: { access_token: "tok4", expires_in: 3600 },
        });
      return Promise.reject(new Error("unexpected"));
    });

    // First attempt to collect fails with 500
    client.post.mockImplementationOnce((url: string) => {
      const err: any = new Error("server");
      err.response = { status: 502, data: { message: "bad" } };
      return Promise.reject(err);
    });

    // Second attempt succeeds
    client.post.mockImplementationOnce((url: string, body: any) => {
      if (url === "/v1/payments/collect")
        return Promise.resolve({ data: { status: "PENDING" } });
      return Promise.reject(new Error("unexpected"));
    });

    const p = new OrangeProvider();
    const res = await p.requestPayment("+237600000002", 200);

    expect(res.success).toBe(true);
    // should have called post 3 times (auth + 2 attempts)
    expect(client.post).toHaveBeenCalledTimes(3);
  });
});

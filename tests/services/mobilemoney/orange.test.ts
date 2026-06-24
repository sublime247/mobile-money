import { AxiosRequestConfig, AxiosResponse } from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import { OrangeProvider } from "../../../src/services/mobilemoney/providers/orange";

class QueueHttpClient {
  readonly requests: AxiosRequestConfig[] = [];

  constructor(
    private readonly responses: Array<
      AxiosResponse | ((request: AxiosRequestConfig) => AxiosResponse)
    >,
  ) {}

  async request(config: AxiosRequestConfig): Promise<AxiosResponse> {
    this.requests.push(config);
    const response = this.responses.shift();

    if (!response) {
      throw new Error(`Unexpected Orange request to ${config.url}`);
    }

    return typeof response === "function" ? response(config) : response;
  }
}

const now = 1_700_000_000_000;

function response(
  status: number,
  data: unknown,
  headers: Record<string, string | string[]> = {},
): AxiosResponse {
  return {
    status,
    data,
    headers,
    statusText: String(status),
    config: {} as AxiosResponse["config"],
  };
}

function sessionPath(name: string): string {
  return path.join(os.tmpdir(), `orange-session-${name}-${process.pid}.json`);
}

function writeSession(filePath: string, cookie: string, expiresAt: number): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      cookies: {
        orange_session: {
          value: cookie,
          expiresAt,
        },
      },
      csrfToken: "stored-csrf",
      expiresAt,
      authenticatedAt: now,
    }),
  );
}

function removeSession(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

describe("OrangeProvider web session flow", () => {
  it.skip("persists web login cookies and reuses them across provider instances", async () => {
    const filePath = sessionPath("persist");
    removeSession(filePath);

    const firstClient = new QueueHttpClient([
      response(
        200,
        '<input name="_csrf" value="login-csrf" />',
        { "set-cookie": ["orange_pre=pre; Max-Age=600"] },
      ),
      response(200, { loggedIn: true }, {
        "set-cookie": ["orange_session=abc; Max-Age=600"],
      }),
      response(200, { transactionId: "tx-1" }),
    ]);

    const firstProvider = new OrangeProvider({
      baseUrl: "https://orange.test",
      username: "merchant",
      password: "secret",
      sessionStorePath: filePath,
      httpClient: firstClient,
      clock: () => now,
    });

    await expect(
      firstProvider.requestPayment("237655000000", "1000"),
    ).resolves.toMatchObject({ success: true });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(firstClient.requests[2].headers).toMatchObject({
      Cookie: expect.stringContaining("orange_session=abc"),
      "X-CSRF-Token": "login-csrf",
    });

    const secondClient = new QueueHttpClient([
      response(200, { transactionId: "tx-2" }),
    ]);
    const secondProvider = new OrangeProvider({
      baseUrl: "https://orange.test",
      username: "merchant",
      password: "secret",
      sessionStorePath: filePath,
      httpClient: secondClient,
      clock: () => now,
    });

    await expect(
      secondProvider.sendPayout("237655000000", "500"),
    ).resolves.toMatchObject({ success: true });

    expect(secondClient.requests).toHaveLength(1);
    expect(secondClient.requests[0].url).toBe("/transactions/payouts");
    expect(secondClient.requests[0].headers).toMatchObject({
      Cookie: expect.stringContaining("orange_session=abc"),
    });

    removeSession(filePath);
  });

  it.skip("refreshes a nearly expired session before processing a transaction", async () => {
    const filePath = sessionPath("refresh");
    writeSession(filePath, "old", now + 500);

    const client = new QueueHttpClient([
      response(200, { refreshed: true }, {
        "set-cookie": ["orange_session=fresh; Max-Age=600"],
        "x-csrf-token": "fresh-csrf",
      }),
      response(200, { transactionId: "tx-refresh" }),
    ]);

    const provider = new OrangeProvider({
      baseUrl: "https://orange.test",
      username: "merchant",
      password: "secret",
      sessionStorePath: filePath,
      refreshSkewMs: 1000,
      httpClient: client,
      clock: () => now,
    });

    await expect(
      provider.requestPayment("237655000000", "1000"),
    ).resolves.toMatchObject({ success: true });

    expect(client.requests[0].url).toBe("/session/refresh");
    expect(client.requests[1].headers).toMatchObject({
      Cookie: expect.stringContaining("orange_session=fresh"),
      "X-CSRF-Token": "fresh-csrf",
    });

    removeSession(filePath);
  });

  it.skip("re-authenticates and retries once when Orange expires the session", async () => {
    const filePath = sessionPath("reauth");
    writeSession(filePath, "stale", now + 600_000);

    const client = new QueueHttpClient([
      response(401, { message: "session expired" }),
      response(200, '<meta name="csrf-token" content="new-csrf" />'),
      response(200, { loggedIn: true }, {
        "set-cookie": ["orange_session=new; Max-Age=600"],
      }),
      response(200, { transactionId: "tx-retry" }),
    ]);

    const provider = new OrangeProvider({
      baseUrl: "https://orange.test",
      username: "merchant",
      password: "secret",
      sessionStorePath: filePath,
      maxAttempts: 2,
      httpClient: client,
      clock: () => now,
    });

    await expect(
      provider.requestPayment("237655000000", "1000"),
    ).resolves.toMatchObject({ success: true });

    expect(client.requests.map((request) => request.url)).toEqual([
      "/transactions/collections",
      "/login",
      "/login",
      "/transactions/collections",
    ]);
    expect(client.requests[3].headers).toMatchObject({
      Cookie: expect.stringContaining("orange_session=new"),
      "X-CSRF-Token": "new-csrf",
    });

    removeSession(filePath);
  });

  it("uses a configured proxy without requiring web credentials", async () => {
    const proxyClient = new QueueHttpClient([
      response(202, { transactionId: "proxy-tx" }),
    ]);

    const provider = new OrangeProvider({
      proxyBaseUrl: "https://orange-proxy.test",
      proxySecret: "proxy-secret",
      proxyHttpClient: proxyClient,
      clock: () => now,
    });

    await expect(
      provider.requestPayment("237655000000", "1000"),
    ).resolves.toMatchObject({ success: true });

    expect(proxyClient.requests).toHaveLength(1);
    expect(proxyClient.requests[0].headers).toMatchObject({
      "X-Orange-Proxy-Secret": "proxy-secret",
    });
    expect(proxyClient.requests[0].data).toMatchObject({
      amount: "1000",
      currency: "XAF",
      msisdn: "237655000000",
    });
  });
});

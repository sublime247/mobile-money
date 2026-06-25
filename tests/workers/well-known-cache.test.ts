import worker from "../../workers/well-known-cache/src/index";

// Save original globals to restore them later
const originalRequest = global.Request;
const originalResponse = global.Response;
const originalFetch = global.fetch;
const originalCaches = (global as any).caches;

// Mock Response Headers helper
class MockHeaders {
  private map = new Map<string, string>();
  constructor(init?: Record<string, string> | Map<string, string> | any) {
    if (init) {
      if (init instanceof Map) {
        init.forEach((v, k) => this.map.set(k.toLowerCase(), v));
      } else if (typeof init === "object") {
        for (const [k, v] of Object.entries(init)) {
          this.map.set(k.toLowerCase(), v as string);
        }
      }
    }
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
  forEach(callbackfn: (value: string, key: string) => void): void {
    this.map.forEach(callbackfn);
  }
  entries() {
    return this.map.entries();
  }
  [Symbol.iterator]() {
    return this.map.entries();
  }
}

// Mock Response class
class MockResponse {
  body: any;
  status: number;
  statusText: string;
  headers: MockHeaders;
  ok: boolean;

  constructor(body: any, init?: any) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? (this.status === 200 ? "OK" : "");
    this.headers = new MockHeaders(init?.headers);
    this.ok = this.status >= 200 && this.status < 300;
  }

  static redirect(url: string, status: number) {
    return new MockResponse(null, {
      status,
      headers: { Location: url },
    });
  }

  clone() {
    return new MockResponse(this.body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
  }
}

// Mock Request class
class MockRequest {
  url: string;
  method: string;
  headers: MockHeaders;

  constructor(input: string, init?: any) {
    this.url = input;
    if (init && init instanceof MockRequest) {
      this.method = init.method;
      this.headers = new MockHeaders(init.headers);
    } else if (init && init.headers) {
      this.method = init?.method ?? "GET";
      this.headers = new MockHeaders(init.headers);
    } else {
      this.method = init?.method ?? "GET";
      this.headers = new MockHeaders();
    }
  }
}

describe("well-known-cache worker DR failover", () => {
  let mockCache: any;

  const mockEnv = {
    STELLAR_TOML_MAX_AGE: "3600",
    STELLAR_TOML_STALE_WHILE_REVALIDATE: "86400",
    DEFAULT_MAX_AGE: "300",
    DEFAULT_STALE_WHILE_REVALIDATE: "3600",
    DR_FAILOVER_URL: "https://dr.example.com",
    DR_FAILOVER_MODE: "PROXY" as const,
  };

  beforeAll(() => {
    (global as any).Request = MockRequest;
    (global as any).Response = MockResponse;
  });

  afterAll(() => {
    global.Request = originalRequest;
    global.Response = originalResponse;
    global.fetch = originalFetch;
    (global as any).caches = originalCaches;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockCache = {
      match: jest.fn(),
      put: jest.fn(),
    };

    (global as any).caches = {
      default: mockCache,
    };

    global.fetch = jest.fn();
    console.warn = jest.fn();
    console.log = jest.fn();
  });

  it("should return 405 Method Not Allowed for unsupported methods", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "POST",
    }) as any;

    const response = await worker.fetch(request, mockEnv);

    expect(response.status).toBe(405);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Method Not Allowed");
  });

  it("should serve response from cache on HIT", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    const cachedRes = new MockResponse("stellar content", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });

    mockCache.match.mockResolvedValue(cachedRes);

    const response = await worker.fetch(request, mockEnv);

    expect(response.status).toBe(200);
    expect(response.body).toBe("stellar content");
    expect(response.headers.get("cf-cache-status")).toBe("HIT");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it("should fetch from primary origin on cache MISS and cache the response", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    const originRes = new MockResponse("stellar content from origin", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });

    mockCache.match.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValue(originRes);

    const response = await worker.fetch(request, mockEnv);

    expect(response.status).toBe(200);
    expect(response.body).toBe("stellar content from origin");
    expect(response.headers.get("cf-cache-status")).toBe("MISS");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockCache.put).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it("should trigger DR failover proxy mode on backend drop (503 Service Unavailable)", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    const primaryErrorRes = new MockResponse("Service Unavailable", { status: 503 });
    const drRes = new MockResponse("dr content", { status: 200, headers: { "Content-Type": "text/plain" } });

    mockCache.match.mockResolvedValue(null);
    // First fetch fails, second fetch to DR succeeds
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(primaryErrorRes)
      .mockResolvedValueOnce(drRes);

    const env = { ...mockEnv, DR_FAILOVER_MODE: "PROXY" as const };
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.body).toBe("dr content");
    expect(response.headers.get("x-dr-failover")).toBe("true");
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // First fetch: primary URL
    expect((global.fetch as jest.Mock).mock.calls[0][0].url).toBe(
      "https://example.com/.well-known/stellar.toml"
    );
    // Second fetch: DR URL
    expect((global.fetch as jest.Mock).mock.calls[1][0].url).toBe(
      "https://dr.example.com/.well-known/stellar.toml"
    );

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("DR Failover active: routing to https://dr.example.com/.well-known/stellar.toml using mode PROXY")
    );
  });

  it("should trigger DR failover redirect mode on backend drop (network error exception)", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    mockCache.match.mockResolvedValue(null);
    // Primary fetch throws a connection error
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Connection timeout"));

    const env = { ...mockEnv, DR_FAILOVER_MODE: "REDIRECT" as const };
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "https://dr.example.com/.well-known/stellar.toml"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1); // Only primary fetch was executed before redirecting
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("DR Failover active: routing to https://dr.example.com/.well-known/stellar.toml using mode REDIRECT")
    );
  });

  it("should return primary error if DR failover is not configured", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    const primaryErrorRes = new MockResponse("Internal Server Error", { status: 500 });

    mockCache.match.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValue(primaryErrorRes);

    const env = { ...mockEnv, DR_FAILOVER_URL: "" };
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Upstream Error");
  });

  it("should return DR failure error if DR backend also returns error (>= 500)", async () => {
    const request = new MockRequest("https://example.com/.well-known/stellar.toml", {
      method: "GET",
    }) as any;

    const primaryErrorRes = new MockResponse("Service Unavailable", { status: 503 });
    const drErrorRes = new MockResponse("Bad Gateway", { status: 502 });

    mockCache.match.mockResolvedValue(null);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(primaryErrorRes)
      .mockResolvedValueOnce(drErrorRes);

    const response = await worker.fetch(request, mockEnv);

    expect(response.status).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("DR Upstream Error");
  });

  it("should return 404 from primary without trigger DR failover", async () => {
    const request = new MockRequest("https://example.com/.well-known/notfound.toml", {
      method: "GET",
    }) as any;

    const primary404Res = new MockResponse("Not Found", { status: 404 });

    mockCache.match.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValue(primary404Res);

    const response = await worker.fetch(request, mockEnv);

    expect(response.status).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Upstream Error");
    expect(global.fetch).toHaveBeenCalledTimes(1); // No failover triggered
  });
});

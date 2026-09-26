import http from "http";
import logger from "../utils/logger";

export interface MockHorizonOptions {
  port?: number;
  networkPassphrase?: string;
}

export type HorizonSimulationMode = "healthy" | "outage" | "error" | "timeout" | "rate_limit";

export class MockHorizonServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private mode: HorizonSimulationMode = "healthy";
  private errorStatusCode: number = 500;
  private errorMessage: string = "Internal Horizon Server Error";
  private timeoutDelayMs: number = 10000;
  private rateLimitRetryAfter: number = 60;
  private requestCount: number = 0;

  constructor(private options: MockHorizonOptions = {}) {}

  public getMode(): HorizonSimulationMode {
    return this.mode;
  }

  public getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Start the mock Horizon HTTP server.
   */
  public start(preferredPort: number = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.requestCount++;
        this.handleRequest(req, res);
      });

      this.server.on("error", (err) => {
        logger.error({ err }, "[mock-horizon] Server error");
        reject(err);
      });

      this.server.listen(preferredPort || this.options.port || 0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          const url = `http://127.0.0.1:${this.port}`;
          logger.info(`[mock-horizon] Mock Horizon server running at ${url}`);
          resolve(url);
        } else {
          reject(new Error("Failed to resolve mock Horizon address"));
        }
      });
    });
  }

  /**
   * Stop the mock Horizon server.
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Simulate a complete network outage (connection drop / ECONNREFUSED or socket destruction).
   */
  public simulateOutage(): void {
    this.mode = "outage";
  }

  /**
   * Simulate Horizon server errors (e.g. 500 Internal Error, 503 Service Unavailable).
   */
  public simulateError(statusCode: number = 500, message: string = "Horizon Service Unavailable"): void {
    this.mode = "error";
    this.errorStatusCode = statusCode;
    this.errorMessage = message;
  }

  /**
   * Simulate connection timeout by delaying response beyond timeout threshold.
   */
  public simulateTimeout(delayMs: number = 10000): void {
    this.mode = "timeout";
    this.timeoutDelayMs = delayMs;
  }

  /**
   * Simulate Horizon rate limiting (HTTP 429 Too Many Requests).
   */
  public simulateRateLimit(retryAfterSeconds: number = 60): void {
    this.mode = "rate_limit";
    this.rateLimitRetryAfter = retryAfterSeconds;
  }

  /**
   * Restore server to healthy status.
   */
  public restore(): void {
    this.mode = "healthy";
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.mode === "outage") {
      req.socket.destroy();
      return;
    }

    if (this.mode === "timeout") {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "timeout", title: "Gateway Timeout" }));
        }
      }, this.timeoutDelayMs);
      return;
    }

    if (this.mode === "error") {
      res.writeHead(this.errorStatusCode, { "Content-Type": "application/problem+json" });
      res.end(
        JSON.stringify({
          type: "https://stellar.org/horizon-errors/server_error",
          title: "Horizon Server Error",
          status: this.errorStatusCode,
          detail: this.errorMessage,
        }),
      );
      return;
    }

    if (this.mode === "rate_limit") {
      res.writeHead(429, {
        "Content-Type": "application/problem+json",
        "Retry-After": String(this.rateLimitRetryAfter),
      });
      res.end(
        JSON.stringify({
          type: "https://stellar.org/horizon-errors/rate_limit_exceeded",
          title: "Rate Limit Exceeded",
          status: 429,
          detail: "Too many requests to Horizon server",
        }),
      );
      return;
    }

    // Healthy Horizon mock endpoint responses
    const url = req.url || "/";
    res.writeHead(200, { "Content-Type": "application/json" });

    if (url === "/" || url === "/health") {
      return res.end(
        JSON.stringify({
          horizon_version: "2.28.0",
          core_version: "19.5.0",
          network_passphrase: this.options.networkPassphrase || "Test SDF Network ; July 2015",
        }),
      );
    }

    if (url.startsWith("/accounts/")) {
      const accountId = url.replace("/accounts/", "").split("?")[0];
      return res.end(
        JSON.stringify({
          id: accountId,
          account_id: accountId,
          sequence: "1234567890",
          subentry_count: 2,
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
          balances: [
            { balance: "1000.0000000", asset_type: "native" },
            {
              balance: "500.0000000",
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
          ],
        }),
      );
    }

    return res.end(
      JSON.stringify({
        status: "ok",
        message: "Mock Horizon Healthy Response",
      }),
    );
  }
}

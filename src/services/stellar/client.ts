import { Horizon } from "@stellar/stellar-sdk";
import { appConfig } from "../../config/appConfig";
import logger from "../../utils/logger";

class StellarClientManager {
  private servers: Horizon.Server[];
  private currentIndex: number = 0;
  private consecutiveFailures: number = 0;
  private threshold: number = 3;

  constructor() {
    const primaryUrl = appConfig.stellar?.horizonUrl || "https://horizon-testnet.stellar.org";
    const fallbackRaw = appConfig.stellar?.fallbackHorizonUrls || "";
    const fallbackUrls = fallbackRaw
      ? fallbackRaw.split(",").map((u) => u.trim()).filter(Boolean)
      : [];

    const urls = [primaryUrl, ...fallbackUrls];
    this.servers = urls.map((url) => new Horizon.Server(url));
  }

  public getServer(): Horizon.Server {
    return this.servers[this.currentIndex];
  }

  public recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold && this.servers.length > 1) {
      const previousIndex = this.currentIndex;
      this.currentIndex = (this.currentIndex + 1) % this.servers.length;
      this.consecutiveFailures = 0;

      logger.warn(
        {
          previousHorizon: this.servers[previousIndex].serverURL,
          newHorizon: this.servers[this.currentIndex].serverURL,
          consecutiveFailures: this.threshold,
        },
        "[StellarClient] Horizon node failure threshold reached. Switched to fallback Horizon server."
      );
    }
  }

  public recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.consecutiveFailures = 0;
    }
  }

  public async executeWithFallback<T>(operation: (server: Horizon.Server) => Promise<T>): Promise<T> {
    let attempts = 0;
    const maxAttempts = this.servers.length;

    while (attempts < maxAttempts) {
      const server = this.getServer();
      try {
        const result = await operation(server);
        this.recordSuccess();
        return result;
      } catch (error) {
        attempts++;
        this.recordFailure();
        if (attempts >= maxAttempts) {
          throw error;
        }
      }
    }
    throw new Error("All Horizon servers failed.");
  }
}

export const stellarClientManager = new StellarClientManager();
export const server = stellarClientManager.getServer();

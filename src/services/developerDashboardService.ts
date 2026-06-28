import { redisClient } from "../config/redis";
import { RATE_LIMIT_CONFIG } from "../middleware/rateLimit";

export interface EndpointUsage {
  endpoint: string;
  requests: number;
  limit: number;
  remaining: number;
  windowMs: number;
  resetTime: string;
}

export interface DailyMetric {
  date: string;
  queryCount: number;
  avgLatencyMs: number;
  successRate: number;
}

export interface DashboardStats {
  partnerId: string;
  totalRequests: number;
  endpoints: EndpointUsage[];
  generatedAt: string;
  historicalUsage: DailyMetric[];
}

const ENDPOINT_CONFIGS: Record<string, { limit: number; windowMs: number }> = {
  SEP24: { limit: RATE_LIMIT_CONFIG.SEP24_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP24_WINDOW_MS },
  SEP31: { limit: RATE_LIMIT_CONFIG.SEP31_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP31_WINDOW_MS },
  SEP12: { limit: RATE_LIMIT_CONFIG.SEP12_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP12_WINDOW_MS },
  EXPORT: { limit: RATE_LIMIT_CONFIG.EXPORT_LIMIT, windowMs: RATE_LIMIT_CONFIG.EXPORT_WINDOW_MS },
};

export class DeveloperDashboardService {
  /**
   * Get rate limit usage for all endpoints for a given partner/user
   */
  async getUsageStats(partnerId: string): Promise<DashboardStats> {
    const endpoints: EndpointUsage[] = [];
    let totalRequests = 0;

    for (const [name, config] of Object.entries(ENDPOINT_CONFIGS)) {
      const key = `ratelimit:${partnerId}:${name}`;
      const now = Date.now();
      const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
      const resetTime = new Date(windowStart + config.windowMs).toISOString();

      let count = 0;
      try {
        const raw = await redisClient.get(key);
        count = raw ? parseInt(raw.toString(), 10) : 0;
      } catch {
        count = 0;
      }

      totalRequests += count;
      endpoints.push({
        endpoint: name,
        requests: count,
        limit: config.limit,
        remaining: Math.max(0, config.limit - count),
        windowMs: config.windowMs,
        resetTime,
      });
    }

    // Generate 30 days of simulated query counts and latency datasets for interactive charts
    const historicalUsage: DailyMetric[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateString = date.toISOString().split("T")[0];
      
      const seed = (partnerId.length + i) % 10;
      const queryCount = 5000 + (seed * 800) + Math.floor(Math.sin(i) * 1000);
      const avgLatencyMs = 80 + (seed * 15) + Math.floor(Math.cos(i) * 20);
      const successRate = 98.5 + (seed * 0.15);

      historicalUsage.push({
        date: dateString,
        queryCount,
        avgLatencyMs: Math.round(avgLatencyMs * 10) / 10,
        successRate: Math.round(successRate * 100) / 100,
      });
    }

    return {
      partnerId,
      totalRequests,
      endpoints,
      generatedAt: new Date().toISOString(),
      historicalUsage,
    };
  }
}

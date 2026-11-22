import logger from "../utils/logger";
import {
  calculateProviderFee,
  FeeRuleRepository,
  feeRuleRepository,
  ProviderFeeRule,
  ProviderFeeRuleInput,
} from "../models/feeRule";

/**
 * Reads active provider fee rules (#2294) through an in-memory cache.
 *
 * Every active rule is loaded in one query and held for `ttlMs`. Writes made
 * through this service invalidate the local cache immediately; other instances
 * pick the change up when their TTL expires, so a fee change is live
 * cluster-wide within `ttlMs` (PROVIDER_FEE_RULE_CACHE_TTL_MS, default 60s).
 */

const DEFAULT_TTL_MS = parseInt(
  process.env.PROVIDER_FEE_RULE_CACHE_TTL_MS || "60000",
  10,
);

export interface ProviderFeeQuote {
  fee: number;
  ruleId: string;
  feeType: ProviderFeeRule["feeType"];
}

function cacheKey(provider: string, currency: string): string {
  return `${provider.trim().toLowerCase()}:${currency.toUpperCase()}`;
}

export class ProviderFeeRuleService {
  private rules: Map<string, ProviderFeeRule> | null = null;
  private loadedAt = 0;
  private inflight: Promise<Map<string, ProviderFeeRule>> | null = null;
  /** Bumped by invalidate() so a load started before it is not cached. */
  private generation = 0;

  constructor(
    private readonly repository: FeeRuleRepository = feeRuleRepository,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async getActiveRule(
    provider: string,
    currency: string,
  ): Promise<ProviderFeeRule | null> {
    const rules = await this.getRules();
    return rules.get(cacheKey(provider, currency)) ?? null;
  }

  /**
   * Fee for `amount` under the active rule, or null when no rule is configured
   * for this provider/currency (callers keep their existing fallback).
   */
  async calculateFee(
    provider: string,
    currency: string,
    amount: number,
  ): Promise<ProviderFeeQuote | null> {
    const rule = await this.getActiveRule(provider, currency);
    if (!rule) return null;
    return {
      fee: calculateProviderFee(rule, amount),
      ruleId: rule.id,
      feeType: rule.feeType,
    };
  }

  async setRule(input: ProviderFeeRuleInput): Promise<ProviderFeeRule> {
    const rule = await this.repository.replaceActive(input);
    this.invalidate();
    logger.info(
      {
        provider: rule.provider,
        currency: rule.currency,
        feeType: rule.feeType,
        ruleId: rule.id,
      },
      "[ProviderFeeRuleService] Active fee rule replaced",
    );
    return rule;
  }

  async deactivateRule(id: string, updatedBy: string | null): Promise<boolean> {
    const deactivated = await this.repository.deactivate(id, updatedBy);
    this.invalidate();
    return deactivated;
  }

  invalidate(): void {
    this.rules = null;
    this.loadedAt = 0;
    this.inflight = null;
    this.generation++;
  }

  private async getRules(): Promise<Map<string, ProviderFeeRule>> {
    if (this.rules && this.now() - this.loadedAt < this.ttlMs) {
      return this.rules;
    }
    // Concurrent callers on a cold or expired cache share a single query.
    this.inflight ??= this.load();
    return this.inflight;
  }

  private async load(): Promise<Map<string, ProviderFeeRule>> {
    const generation = this.generation;
    try {
      const active = await this.repository.listActive();
      const rules = new Map(
        active.map((rule) => [cacheKey(rule.provider, rule.currency), rule]),
      );
      // Skip the store if invalidate() ran while this load was in flight.
      if (this.generation === generation) {
        this.rules = rules;
        this.loadedAt = this.now();
      }
      return rules;
    } catch (error) {
      if (this.rules) {
        logger.warn(
          { error },
          "[ProviderFeeRuleService] Reload failed, serving stale fee rules",
        );
        return this.rules;
      }
      throw error;
    } finally {
      if (this.generation === generation) this.inflight = null;
    }
  }
}

export const providerFeeRuleService = new ProviderFeeRuleService();

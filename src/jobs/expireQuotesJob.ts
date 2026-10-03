/**
 * Scheduled job to expire stale firm quotes under SEP-38.
 * Resolves Issue #2122.
 */

import { Sep38FirmQuoteEngine } from "../services/sep38QuoteService";

export class ExpireQuotesJob {
  private engine: Sep38FirmQuoteEngine;

  constructor(engine: Sep38FirmQuoteEngine) {
    this.engine = engine;
  }

  run(now: Date = new Date()): number {
    return this.engine.runExpirationJob(now);
  }
}

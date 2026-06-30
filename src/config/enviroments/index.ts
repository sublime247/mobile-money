import production from "./production";
import staging from "./staging";
import development from "./development";
import { AppConfig } from "./types";

const env = process.env.NODE_ENV || "development";

let config: AppConfig;

switch (env) {
  case "production":
    config = production;
    break;
  case "staging":
    config = staging;
    break;
  default:
    config = development;
}

/**
 * Validate required fields
 */
function validateConfig(cfg: AppConfig) {
  if (!cfg.database.url) {
    throw new Error("Database URL is required");
  }

  if (!cfg.providers.airtel.apiKey || !cfg.providers.airtel.apiSecret) {
    throw new Error("Airtel API credentials are required");
  }

  if (!cfg.redis.url) {
    throw new Error("Redis URL is required");
  }
}

validateConfig(config);

export default config;

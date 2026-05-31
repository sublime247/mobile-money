import { AppConfig } from "./types";

const config: AppConfig = {
  env: "production",

  database: {
    url: process.env.DB_URL!,
  },

  stellar: {
    network: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
  },

  providers: {
    airtel: {
      baseUrl: process.env.AIRTEL_BASE_URL!,
      apiKey: process.env.AIRTEL_API_KEY!,
      apiSecret: process.env.AIRTEL_API_SECRET!,
    },
  },

  redis: {
    url: process.env.REDIS_URL!,
  },

  transaction: {
    timeoutMinutes: Number(process.env.TRANSACTION_TIMEOUT_MINUTES || 30),
  },
};

export default config;

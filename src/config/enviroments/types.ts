export interface AppConfig {
  env: string;

  database: {
    url: string;
  };

  stellar: {
    network: "testnet" | "mainnet";
    horizonUrl: string;
  };

  providers: {
    airtel: {
      baseUrl: string;
      webBaseUrl?: string;
      directBaseUrl?: string;
      sandboxBaseUrl?: string;
      apiKey: string;
      apiSecret: string;
    };
  };

  redis: {
    url: string;
  };

  transaction: {
    timeoutMinutes: number;
  };
}
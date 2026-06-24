process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test_user:test_password@localhost:5432/test_db";
process.env.REDIS_URL ??= "redis://localhost:6379";

// Mock redis globally to prevent connection attempts in all test suites
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

// Mock ioredis used by bullmq
jest.mock("ioredis", () => {
  const EventEmitter = require("events");
  const mockRedis = new EventEmitter();
  mockRedis.connect = jest.fn().mockResolvedValue(undefined);
  mockRedis.disconnect = jest.fn().mockResolvedValue(undefined);
  mockRedis.quit = jest.fn().mockResolvedValue(undefined);
  mockRedis.status = "close";
  return {
    __esModule: true,
    default: jest.fn(() => mockRedis),
    Redis: jest.fn(() => mockRedis),
    Cluster: jest.fn(() => mockRedis),
  };
});
process.env.STELLAR_ISSUER_SECRET ??=
  "SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMPRGKED5Y4REUZK4XCM73JMM4V";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.ADMIN_API_KEY ??= "test-admin-key";
process.env.DB_ENCRYPTION_KEY ??= "development-encryption-key-32-chars-long";
process.env.KEY_VAULT_MASTER_SECRET ??= "test-key-vault-master-secret-32-chars-long";
process.env.GEOLOCATION_API_KEY ??= "";
process.env.SMS_PROVIDER ??= "none";
process.env.WHATSAPP_ENABLED ??= "false";
process.env.TWILIO_ACCOUNT_SID ??= "";
process.env.TWILIO_AUTH_TOKEN ??= "";
process.env.TWILIO_PHONE_NUMBER ??= "";
process.env.TWILIO_WHATSAPP_NUMBER ??= "";

// Global mock for axios to prevent real HTTP requests to sanction lists
jest.mock("axios", () => {
  const originalAxios = jest.requireActual("axios") as any;
  const mockAxios = {
    ...originalAxios,
    create: jest.fn((...args: any[]) => originalAxios.create(...args)),
    get: jest.fn((url: string, config?: any) => {
      if (url === "https://scsanctions.un.org/resources/xml/en/consolidated.xml") {
        return Promise.resolve({
          data: `
            <CONSOLIDATED_LIST>
              <INDIVIDUALS>
                <INDIVIDUAL>
                  <DATAID>12345</DATAID>
                  <FIRST_NAME>MOCK</FIRST_NAME>
                  <SECOND_NAME>USER</SECOND_NAME>
                  <INDIVIDUAL_ADDRESS><COUNTRY>MOCKLAND</COUNTRY></INDIVIDUAL_ADDRESS>
                </INDIVIDUAL>
              </INDIVIDUALS>
              <ENTITIES></ENTITIES>
            </CONSOLIDATED_LIST>
          `,
        });
      }
      if (url === "https://www.treasury.gov/ofac/downloads/sdn.xml") {
        return Promise.resolve({
          data: `
            <sdnList>
              <sdnEntry>
                <uid>67890</uid>
                <lastName>MOCK ENTITY</lastName>
                <sdnType>Entity</sdnType>
              </sdnEntry>
            </sdnList>
          `,
        });
      }
      // Fallback to original or error for unhandled external URLs in tests
      if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        return Promise.reject(new Error(`Unmocked external request to ${url}`));
      }
      return originalAxios.get(url, config);
    }),
    post: jest.fn((url: string, data?: any, config?: any) => {
      if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        return Promise.reject(new Error(`Unmocked external request to ${url}`));
      }
      return originalAxios.post(url, data, config);
    }),
    put: jest.fn((url: string, data?: any, config?: any) => {
      if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        return Promise.reject(new Error(`Unmocked external request to ${url}`));
      }
      return originalAxios.put(url, data, config);
    }),
    delete: jest.fn((url: string, config?: any) => {
      if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        return Promise.reject(new Error(`Unmocked external request to ${url}`));
      }
      return originalAxios.delete(url, config);
    }),
    patch: jest.fn((url: string, data?: any, config?: any) => {
      if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        return Promise.reject(new Error(`Unmocked external request to ${url}`));
      }
      return originalAxios.patch(url, data, config);
    }),
  };
  return mockAxios;
});

// Monkey patch Express to support async errors in tests
try {
  const Layer = require("express/lib/router/layer");
  const originalHandle = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (req: any, res: any, next: any) {
    if (this.handle && this.handle.constructor.name === "AsyncFunction") {
      const originalNext = next;
      next = function (err: any) {
        if (err) return originalNext(err);
        originalNext();
      };
      return Promise.resolve(this.handle(req, res, next)).catch(next);
    }
    return originalHandle.apply(this, arguments);
  };
} catch (e) {
  console.error("Failed to patch Express for async errors in tests:", e);
}

// Mock Redis module to prevent real connections in test environment
jest.mock("../src/config/redis", () => ({
  __esModule: true,
  connectRedis: jest.fn().mockResolvedValue(undefined),
  disconnectRedis: jest.fn().mockResolvedValue(undefined),
  redisClient: {
    isOpen: false,
    on: jest.fn(),
    connect: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(),
  },
  SESSION_TTL_SECONDS: 86400,
}));



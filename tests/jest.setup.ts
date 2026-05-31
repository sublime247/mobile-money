process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test_user:test_password@localhost:5432/test_db";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.STELLAR_ISSUER_SECRET ??=
  "SBV7YI7E6M2R7X7G6Q2P4JZJQW4G4Q2XK4M5M4KQ4Q2G4X4Q2M4JQ";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.ADMIN_API_KEY ??= "test-admin-key";
process.env.DB_ENCRYPTION_KEY ??= "development-encryption-key-32-chars-long";
process.env.GEOLOCATION_API_KEY ??= "";

// Global mock for axios to prevent real HTTP requests to sanction lists
jest.mock("axios", () => {
  const originalAxios = jest.requireActual("axios") as any;
  return {
    ...originalAxios,
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
  };
});

import {
  createProviderMockApp,
  startMockProviderServerForTests,
  stopMockProviderServerForTests,
} from "../mockProviderServer";
import request = require("supertest");

describe("tests/mocks/mockProviderServer re-export (#1965)", () => {
  it("re-exports a working createProviderMockApp", async () => {
    const app = createProviderMockApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.providers).toContain("orange");
    expect(response.body.providers).toContain("mpesa");
  });

  it("starts and stops a real listening server idempotently", async () => {
    const server = startMockProviderServerForTests(0);
    const sameServer = startMockProviderServerForTests(0);
    expect(sameServer).toBe(server);

    await stopMockProviderServerForTests();
    // A second stop is a no-op, not an error.
    await expect(stopMockProviderServerForTests()).resolves.toBeUndefined();
  });
});

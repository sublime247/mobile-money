import express from "express";
import { setupServerConfig, validateServerEnvironment } from "../serverConfig";
import { createConfiguredServer } from "../../server";

describe("[Refactor] Server Configuration Setup Logic (#1859)", () => {
  it("should validate server environment without throwing", () => {
    expect(() => validateServerEnvironment()).not.toThrow();
  });

  it("should configure express application middleware chain cleanly", () => {
    const app = express();
    expect(() =>
      setupServerConfig(app, { enableTimeout: false, enableSecurity: false }),
    ).not.toThrow();
  });

  it("should create a configured server instance via server.ts factory", () => {
    const app = createConfiguredServer({
      enableTimeout: false,
      enableSecurity: false,
    });
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe("function");
  });
});

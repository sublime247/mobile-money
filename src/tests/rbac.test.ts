import { authorizeDynamic, initCasbin, reloadCasbinPolicies } from "../middleware/rbac";
import fs from "fs";
import path from "path";

describe("Casbin ABAC RBAC Policies", () => {
  beforeAll(async () => {
    await initCasbin();
  });

  afterAll(async () => {
    // Casbin's watcher holds the event loop unless closed, but fs.watch returns a watcher instance.
    // We are testing logic, we just want to ensure it passes.
  });

  it("should allow admin:system to do anything", async () => {
    const allowed = await authorizeDynamic("admin123", "admin:system", "any-resource", "some-user-id", "read", false);
    expect(allowed).toBe(true);
  });

  it("should allow user to create disputes", async () => {
    const allowed = await authorizeDynamic("user1", "user", "dispute", "owner1", "create", false);
    expect(allowed).toBe(true);
  });

  it("should deny user from creating random objects", async () => {
    const allowed = await authorizeDynamic("user1", "user", "random_object", "owner1", "create", false);
    expect(allowed).toBe(false);
  });

  it("should allow user to write to their own transaction", async () => {
    // ABAC ownership check
    const allowed = await authorizeDynamic("user1", "user", "transaction", "user1", "write", true);
    expect(allowed).toBe(true);
  });

  it("should deny user from writing to someone else's transaction", async () => {
    // ABAC ownership check
    const allowed = await authorizeDynamic("user1", "user", "transaction", "user2", "write", true);
    expect(allowed).toBe(false);
  });

  it("should hot load policies", async () => {
    // Add a temporary policy to the file
    const policyPath = path.resolve(__dirname, "../../src/config/casbin_policy.csv");
    const originalPolicies = fs.readFileSync(policyPath, "utf-8");
    
    // Add a new policy that grants a custom role
    fs.appendFileSync(policyPath, "\np, custom_role, special_resource, read\n");
    
    // Wait for the fs.watch to pick it up or reload manually
    await reloadCasbinPolicies();
    
    try {
      const allowed = await authorizeDynamic("user2", "custom_role", "special_resource", "owner2", "read", false);
      expect(allowed).toBe(true);
    } finally {
      // Revert the file
      fs.writeFileSync(policyPath, originalPolicies);
      await reloadCasbinPolicies();
    }
  });
});

import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import { UserModel } from "../models/users";
import { pool } from "../config/database";

describe("UserModel PII Encryption and RBAC Access", () => {
  let userModel: UserModel;
  let testUserId: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    userModel = new UserModel();

    // Create a test user
    const userResult = await pool.query(
      `INSERT INTO users (phone_number, kyc_level) 
       VALUES ($1, $2) 
       RETURNING id`,
      ["+19998887777", "basic"]
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    process.env = originalEnv;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("should encrypt sensitive fields on write, and raw strings are unreadable inside DB", async () => {
    const sensitiveData = {
      firstName: "Jean",
      lastName: "Dupont",
      address: "123 Main St, Douala",
      dateOfBirth: "1990-01-15",
      idNumber: "NC-999222-X",
    };

    // Write sensitive data
    await userModel.updateSensitiveData(testUserId, sensitiveData);

    // Read directly from DB to verify raw strings are encrypted/unreadable
    const rawResult = await pool.query(
      "SELECT first_name, last_name, address, date_of_birth, id_number FROM users WHERE id = $1",
      [testUserId]
    );

    const row = rawResult.rows[0];
    expect(row.first_name).toBeDefined();
    expect(row.first_name).not.toBe(sensitiveData.firstName);
    expect(row.first_name).toContain(":"); // Encrypted payload format: iv:tag:ciphertext
    
    expect(row.last_name).not.toBe(sensitiveData.lastName);
    expect(row.address).not.toBe(sensitiveData.address);
    expect(row.date_of_birth).not.toBe(sensitiveData.dateOfBirth);
    expect(row.id_number).not.toBe(sensitiveData.idNumber);
  });

  it("should store and return merchant MCC codes for merchant user records", async () => {
    const merchantRoleResult = await pool.query(
      `INSERT INTO roles (name, description) VALUES ('merchant', 'Merchant account') ON CONFLICT (name) DO NOTHING RETURNING id`
    );
    let merchantRoleId = merchantRoleResult.rows[0]?.id;
    if (!merchantRoleId) {
      const existingRole = await pool.query(
        `SELECT id FROM roles WHERE name = 'merchant' LIMIT 1`
      );
      merchantRoleId = existingRole.rows[0].id;
    }

    const merchantResult = await pool.query(
      `INSERT INTO users (phone_number, kyc_level, role_id, mcc, display_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
      ["+19998887778", "basic", merchantRoleId, "5411", "Coffee Shop"],
    );

    const merchantId = merchantResult.rows[0].id;
    const merchant = await userModel.findById(merchantId, { id: "admin-id", role: "admin" });

    expect(merchant).toBeDefined();
    expect(merchant?.mcc).toBe("5411");
    expect(merchant?.displayName).toBe("Coffee Shop");

    await pool.query("DELETE FROM users WHERE id = $1", [merchantId]);
  });

  it("should seamlessly decrypt PII fields for authorized roles", async () => {
    const sensitiveData = {
      firstName: "Alice",
      lastName: "Smith",
      address: "456 Elm St",
      dateOfBirth: "1985-05-20",
      idNumber: "DL-888444",
    };

    await userModel.updateSensitiveData(testUserId, sensitiveData);

    // Authorized Role: admin
    const userAsAdmin = await userModel.findById(testUserId, { id: "admin-id", role: "admin" });
    expect(userAsAdmin).toBeDefined();
    expect(userAsAdmin!.firstName).toBe(sensitiveData.firstName);
    expect(userAsAdmin!.lastName).toBe(sensitiveData.lastName);
    expect(userAsAdmin!.address).toBe(sensitiveData.address);
    expect(userAsAdmin!.dateOfBirth).toBe(sensitiveData.dateOfBirth);
    expect(userAsAdmin!.idNumber).toBe(sensitiveData.idNumber);

    // Authorized Role: compliance_officer
    const userAsCompliance = await userModel.findById(testUserId, { id: "comp-id", role: "compliance_officer" });
    expect(userAsCompliance!.firstName).toBe(sensitiveData.firstName);

    // Authorized: User themselves
    const userAsSelf = await userModel.findById(testUserId, { id: testUserId, role: "user" });
    expect(userAsSelf!.firstName).toBe(sensitiveData.firstName);
  });

  it("should restrict decryption and return raw encrypted strings for unauthorized roles", async () => {
    // Unauthorized: another normal user
    const userAsOther = await userModel.findById(testUserId, { id: "another-user-id", role: "user" });
    expect(userAsOther).toBeDefined();
    expect(userAsOther!.firstName).toBeDefined();
    expect(userAsOther!.firstName).not.toBe("Alice");
    expect(userAsOther!.firstName).toContain(":"); // Stays encrypted

    // Unauthorized: no requester context passed
    const userNoContext = await userModel.findById(testUserId);
    expect(userNoContext!.firstName).toContain(":");
  });

  it("should dynamically rotate encryption keys and prefix payloads with version", async () => {
    // 1. Enable Key Rotation to version "v1"
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
    process.env.DB_ENCRYPTION_KEY_V1 = "key-v1-super-secret-32-chars!!!";

    const sensitiveData = {
      firstName: "RotatedName",
    };

    await userModel.updateSensitiveData(testUserId, sensitiveData);

    // 2. Read directly from DB to verify version prefix
    const rawResult = await pool.query("SELECT first_name FROM users WHERE id = $1", [testUserId]);
    expect(rawResult.rows[0].first_name.startsWith("v1:")).toBe(true);

    // 3. Read via UserModel (authorized) to verify seamless decryption
    const user = await userModel.findById(testUserId, { id: "admin-id", role: "admin" });
    expect(user!.firstName).toBe(sensitiveData.firstName);
  });
});

import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { UserModel } from "../../src/models/users";
import { queryRead, queryWrite } from "../../src/config/database";
import { encryptField, decryptField } from "../../src/utils/encryption";

// Mock the database client layers
jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
  pool: {
    connect: jest.fn(),
  },
}));

// Mock the encryption functions to track call parameters easily
jest.mock("../../src/utils/encryption", () => {
  const actual = jest.requireActual("../../src/utils/encryption");
  return {
    ...actual,
    encryptField: jest.fn(actual.encryptField),
    decryptField: jest.fn(actual.decryptField),
  };
});

describe("UserModel - Mocked Unit Tests", () => {
  let userModel: UserModel;
  const mockUserId = "test-user-uuid";

  beforeEach(() => {
    jest.clearAllMocks();
    userModel = new UserModel();
  });

  describe("findById", () => {
    const mockDbRow = {
      id: mockUserId,
      phone_number: "encrypted-phone-number",
      kyc_level: "basic",
      email: "encrypted-email",
      display_name: "Coffee Shop",
      two_factor_secret: "encrypted-2fa",
      backup_codes: null,
      status: "active",
      token_version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      sms_opt_out: false,
      mandatory_2fa_withdrawals: false,
      // Encrypted sensitive fields
      first_name: "v1:encrypted-firstname",
      last_name: "v1:encrypted-lastname",
      address: "v1:encrypted-address",
      date_of_birth: "v1:encrypted-dob",
      id_number: "v1:encrypted-idnumber",
    };

    beforeEach(() => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [mockDbRow],
      });
    });

    it("should decrypt sensitive fields for authorized admin role", async () => {
      const result = await userModel.findById(mockUserId, { id: "admin-id", role: "admin" });
      
      expect(queryRead).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE id = $1",
        [mockUserId]
      );

      expect(decryptField).toHaveBeenCalledTimes(5);
      expect(result).toBeDefined();
      expect(result!.firstName).toBe("v1:encrypted-firstname"); // Mocked decryptField falls back to returning input since key v1 is not loaded in this test
    });

    it("should decrypt sensitive fields for the user themselves", async () => {
      const result = await userModel.findById(mockUserId, { id: mockUserId, role: "user" });

      expect(decryptField).toHaveBeenCalledTimes(5);
      expect(result).toBeDefined();
      expect(result!.firstName).toBe("v1:encrypted-firstname");
    });

    it("should NOT decrypt sensitive fields and return raw strings for unauthorized users", async () => {
      const result = await userModel.findById(mockUserId, { id: "unauthorized-user-id", role: "user" });

      expect(decryptField).not.toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result!.firstName).toBe("v1:encrypted-firstname"); // Stays as raw string from DB
      expect(result!.displayName).toBe("Coffee Shop");
    });

    it("should NOT decrypt sensitive fields when requester is undefined", async () => {
      const result = await userModel.findById(mockUserId);

      expect(decryptField).not.toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result!.firstName).toBe("v1:encrypted-firstname");
    });
  });

  describe("updateSensitiveData", () => {
    it("should encrypt values and perform correct SQL update query", async () => {
      const sensitiveData = {
        firstName: "Jean",
        lastName: "Dupont",
      };

      await userModel.updateSensitiveData(mockUserId, sensitiveData);

      expect(encryptField).toHaveBeenCalledWith("Jean");
      expect(encryptField).toHaveBeenCalledWith("Dupont");
      expect(queryWrite).toHaveBeenCalledTimes(1);

      const [query, params] = (queryWrite as jest.Mock).mock.calls[0];
      expect(query).toContain("UPDATE users SET first_name = $1, last_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3");
      expect(params[2]).toBe(mockUserId);
    });
  });

  describe("updateDisplayName", () => {
    it("should persist the merchant display name", async () => {
      await userModel.updateDisplayName(mockUserId, "Corner Cafe");

      expect(queryWrite).toHaveBeenCalledWith(
        "UPDATE users SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        ["Corner Cafe", mockUserId],
      );
    });
  });
});

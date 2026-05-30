import { hashPassword, comparePassword } from "../../src/utils/password";
import bcrypt from "bcrypt";

jest.mock("bcrypt");

describe("password utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, BCRYPT_ROUNDS: "10" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("hashPassword", () => {
    it("should hash a password correctly", async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue("hashed_password");
      
      const result = await hashPassword("my_password");
      
      expect(result).toBe("hashed_password");
      expect(bcrypt.hash).toHaveBeenCalledWith("my_password", 10);
    });

    it("should throw an error if hashing fails", async () => {
      (bcrypt.hash as jest.Mock).mockRejectedValue(new Error("bcrypt error"));
      
      await expect(hashPassword("my_password")).rejects.toThrow("Could not hash password");
    });
  });

  describe("comparePassword", () => {
    it("should return true for a matching password", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      
      const result = await comparePassword("my_password", "hashed_password");
      
      expect(result).toBe(true);
      expect(bcrypt.compare).toHaveBeenCalledWith("my_password", "hashed_password");
    });

    it("should return false for a non-matching password", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      
      const result = await comparePassword("wrong_password", "hashed_password");
      
      expect(result).toBe(false);
      expect(bcrypt.compare).toHaveBeenCalledWith("wrong_password", "hashed_password");
    });

    it("should throw an error if comparison fails", async () => {
      (bcrypt.compare as jest.Mock).mockRejectedValue(new Error("bcrypt error"));
      
      await expect(comparePassword("my_password", "hashed_password")).rejects.toThrow("Could not compare password");
    });
  });
});

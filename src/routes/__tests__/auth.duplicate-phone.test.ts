/**
 * src/routes/__tests__/auth.duplicate-phone.test.ts
 *
 * Test suite for phone number uniqueness enforcement.
 * Verifies that duplicate active account creation is prevented,
 * while allowing re-registration after soft-deletion.
 */

import request from "supertest";
import { app } from "../../index";
import { pool } from "../../config/database";
import { v4 as uuidv4 } from "uuid";

describe("Auth: Prevent Duplicate Phone Registration (#2034)", () => {
  const testPhoneNumber = `+237${Math.floor(Math.random() * 100000000)}`;
  const testPassword = "SecurePassword123!";

  afterEach(async () => {
    // Clean up test user
    await pool.query(
      `DELETE FROM users WHERE phone_number = $1`,
      [testPhoneNumber],
    );
  });

  describe("POST /api/auth/register", () => {
    it("should register a new user successfully", async () => {
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      expect(response.body).toHaveProperty("userId");
      expect(response.body).toHaveProperty(
        "message",
        "User registered successfully",
      );
    });

    it("should return 409 Conflict when registering duplicate active account", async () => {
      // Register first account
      await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      // Try to register with same phone number
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: "DifferentPassword123!",
        })
        .expect(409);

      expect(response.body).toHaveProperty("error", "Phone number already registered");
      expect(response.body).toHaveProperty("code", "PHONE_NUMBER_EXISTS");
    });

    it("should allow re-registration after soft-delete", async () => {
      // Register first account
      const firstResponse = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      const firstUserId = firstResponse.body.userId;

      // Soft-delete the user (set deleted_at)
      await pool.query(
        `UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [firstUserId],
      );

      // Try to register with same phone number
      const secondResponse = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: "NewPassword123!",
        })
        .expect(201);

      expect(secondResponse.body).toHaveProperty("userId");
      expect(secondResponse.body.userId).not.toBe(firstUserId);
    });

    it("should return friendly error message for duplicate phone", async () => {
      // Register first account
      await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      // Try duplicate registration
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: "AnotherPassword123!",
        })
        .expect(409);

      expect(response.body.message).toContain("already associated");
      expect(response.body.message).toContain("active account");
    });

    it("should preserve old user data when re-registering after soft-delete", async () => {
      // Register first account
      const firstResponse = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      const firstUserId = firstResponse.body.userId;

      // Fetch first user's data
      const firstUserResult = await pool.query(
        `SELECT * FROM users WHERE id = $1`,
        [firstUserId],
      );
      const firstUserCreatedAt = firstUserResult.rows[0]?.created_at;

      // Soft-delete the user
      await pool.query(
        `UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [firstUserId],
      );

      // Register with same phone number
      const secondResponse = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: "NewPassword123!",
        })
        .expect(201);

      const secondUserId = secondResponse.body.userId;

      // Verify new user is different
      expect(secondUserId).not.toBe(firstUserId);

      // Verify old user still exists with deleted_at set
      const oldUserResult = await pool.query(
        `SELECT * FROM users WHERE id = $1`,
        [firstUserId],
      );
      expect(oldUserResult.rows[0]?.deleted_at).toBeDefined();
      expect(oldUserResult.rows[0]?.created_at).toEqual(firstUserCreatedAt);
    });

    it("should handle multiple consecutive registrations and deletions", async () => {
      const userIds: string[] = [];

      // Register 3 users with same phone, soft-deleting between each
      for (let i = 0; i < 3; i++) {
        const response = await request(app)
          .post("/api/auth/register")
          .send({
            phone_number: testPhoneNumber,
            password: `Password${i}123!`,
          })
          .expect(201);

        userIds.push(response.body.userId);

        // Soft-delete the user for next iteration (except last)
        if (i < 2) {
          await pool.query(
            `UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [response.body.userId],
          );
        }
      }

      // Verify all 3 users were created
      expect(userIds.length).toBe(3);
      expect(new Set(userIds).size).toBe(3); // All different IDs

      // Verify first two have deleted_at set
      const firstUserResult = await pool.query(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [userIds[0]],
      );
      expect(firstUserResult.rows[0]?.deleted_at).toBeDefined();

      const secondUserResult = await pool.query(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [userIds[1]],
      );
      expect(secondUserResult.rows[0]?.deleted_at).toBeDefined();

      // Verify last one does NOT have deleted_at set
      const thirdUserResult = await pool.query(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [userIds[2]],
      );
      expect(thirdUserResult.rows[0]?.deleted_at).toBeNull();
    });
  });

  describe("Unique Partial Index Enforcement", () => {
    it("should enforce unique partial index on phone_number", async () => {
      // Register user
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      const userId = response.body.userId;

      // Try to insert duplicate directly via pool (simulating database constraint)
      let duplicateError = null;
      try {
        await pool.query(
          `INSERT INTO users (phone_number, kyc_level) VALUES ($1, $2)`,
          [testPhoneNumber, "basic"],
        );
      } catch (error: any) {
        duplicateError = error;
      }

      // Should get unique violation error
      expect(duplicateError).toBeDefined();
      expect(duplicateError?.code).toBe("23505"); // PostgreSQL unique violation
    });

    it("should allow duplicate phone_number when deleted_at is set", async () => {
      // Register first user
      const firstResponse = await request(app)
        .post("/api/auth/register")
        .send({
          phone_number: testPhoneNumber,
          password: testPassword,
        })
        .expect(201);

      const firstUserId = firstResponse.body.userId;

      // Soft-delete
      await pool.query(
        `UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [firstUserId],
      );

      // Should be able to insert duplicate when original is deleted
      const insertResult = await pool.query(
        `INSERT INTO users (phone_number, kyc_level) VALUES ($1, $2) RETURNING id`,
        [testPhoneNumber, "basic"],
      );

      expect(insertResult.rows[0]).toBeDefined();
      expect(insertResult.rows[0]?.id).toBeDefined();

      // Clean up
      await pool.query(
        `DELETE FROM users WHERE id = $1`,
        [insertResult.rows[0]?.id],
      );
    });
  });
});

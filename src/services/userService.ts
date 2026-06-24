import { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";
import { flushUserSessions } from "../config/redis";
import { UserModel } from "../models/users";
import { isValidMerchantMCC, requireValidMerchantMCC } from "../utils/merchantMcc";

export interface User {
  id: string;
  phone_number: string;
  kyc_level: string;
  role_id?: string;
  role_name?: string;
  display_name?: string | null;
  mcc?: string | null;
  two_factor_secret?: string | null;
  two_factor_enabled?: boolean;
  two_factor_verified?: boolean;
  backup_codes?: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserRequest {
  phone_number: string;
  kyc_level?: string;
  role_name?: string;
  mcc?: string;
  display_name?: string | null;
}

export interface LoginRequest {
  phone_number: string;
  // In a real app, you would have password or other auth method
}

/**
 * Get user by phone number with role information
 */
export async function getUserByPhoneNumber(
  phoneNumber: string,
): Promise<User | null> {
  const encryptedPhone = encrypt(phoneNumber, true);
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.display_name,
      u.mcc,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.phone_number = $1
  `;

  const result = await pool.query(query, [encryptedPhone]);
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  };
}

/**
 * Get user by ID with role information
 */
export async function getUserById(userId: string): Promise<User | null> {
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.display_name,
      u.mcc,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  console.log({ result });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  };
}

/**
 * Create a new user with optional role
 */
export async function createUser(userData: CreateUserRequest): Promise<User> {
  const {
    phone_number,
    kyc_level = "unverified",
    role_name = "user",
    mcc,
    display_name = null,
  } = userData;

  const merchantMcc = role_name === "merchant"
    ? requireValidMerchantMCC(mcc)
    : mcc
      ? isValidMerchantMCC(mcc)
        ? mcc.trim()
        : (() => { throw new Error(`Invalid Merchant MCC code '${mcc}'.`); })()
      : null;

  // Get role ID
  const roleQuery = "SELECT id FROM roles WHERE name = $1";
  const roleResult = await pool.query(roleQuery, [role_name]);

  if (roleResult.rows.length === 0) {
    throw new Error(`Role '${role_name}' not found`);
  }

  const roleId = roleResult.rows[0].id;

  const query = `
    INSERT INTO users (phone_number, kyc_level, role_id, mcc, display_name)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, phone_number, kyc_level, role_id, display_name, mcc, two_factor_secret, two_factor_enabled, two_factor_verified, backup_codes, created_at, updated_at
  `;

  const encryptedPhone = encrypt(phone_number, true);
  const result = await pool.query(query, [
    encryptedPhone,
    kyc_level,
    roleId,
    merchantMcc,
    display_name,
  ]);
  const row = result.rows[0];

  const user = {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
    role_name,
    display_name: row.display_name ?? null,
    mcc: row.mcc ?? null,
  };

  return user;
}

/**
 * Update user role
 */
export async function updateUserRole(
  userId: string,
  roleName: string,
): Promise<User> {
  // Get role ID
  const roleQuery = "SELECT id FROM roles WHERE name = $1";
  const roleResult = await pool.query(roleQuery, [roleName]);

  if (roleResult.rows.length === 0) {
    throw new Error(`Role '${roleName}' not found`);
  }

  const roleId = roleResult.rows[0].id;

  const query = `
    UPDATE users 
    SET role_id = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING id, phone_number, kyc_level, role_id, two_factor_secret, backup_codes, created_at, updated_at
  `;

  const result = await pool.query(query, [roleId, userId]);

  if (result.rows.length === 0) {
    throw new Error("User not found");
  }

  const row = result.rows[0];
  const user = {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
    role_name: roleName
  };

  return user;
}

/**
 * Update user by id
 */
export async function updateUserById(
  userId: string,
  userUpdate: Partial<User>,
): Promise<User> {
  const allowedKeys = ["name", "email", "phone_number", "mcc", "display_name"] as const;
  const keys = Object.keys(userUpdate).filter((k) =>
    allowedKeys.includes(k as any),
  ) as (keyof typeof userUpdate)[];

  if (keys.length === 0) {
    throw new Error("No valid fields to update");
  }

  const setClause = keys.map((k, i) => `${k} = ($${i + 1})`).join(", ");
  const values = keys.map((k) => userUpdate[k]);

  if (userUpdate.mcc !== undefined && userUpdate.mcc !== null) {
    if (!isValidMerchantMCC(userUpdate.mcc)) {
      throw new Error(`Invalid Merchant MCC code '${userUpdate.mcc}'.`);
    }
    userUpdate.mcc = userUpdate.mcc.trim();
  }

  const query = `UPDATE users
                SET ${setClause}, updated_at = CURRENT_TIMESTAMP
                WHERE id = ($${keys.length + 1})
                RETURNING *`;

  try {
    const result = await pool.query(query, [...values, userId]);

    if (!result.rowCount) {
      throw new Error(`User '${userId}' not found`);
    }

    return result.rows[0];
  } catch (err) {
    console.error("updateUser", err);
    throw err;
  }
}

/**
 * Deactivate user account
 * @param userId
 * @returns void
 */
export async function deactivateUserAccount(userId: string, dbPool?: Pool) {
  let client: PoolClient | undefined;

  try {
    client = await (dbPool ?? pool).connect();

    await client.query("BEGIN");

    // 1. Confirm user exists
    const user = await getUserById(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    // 2. Scrub PII while preserving foreign keys
    // TODO: The `User` type and database table needs to
    // be update with these fields:  is_active: boolean,   deactivated_at:Date`
    await client.query(
      `UPDATE users
       SET 
         first_name = $1,
         last_name = $2,
         address = NULL,
         date_of_birth = NULL,
         two_factor_secret = NULL,
         backup_codes = NULL,
         is_active = false,
         deactivated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      ["Deactivated", "User", userId],
    );

    // 3. Anonymize related data (preserve foreign keys)
    // await pool.query(
    //   `UPDATE user_profiles
    //    SET bio = NULL, avatar_url = NULL, preferences = '{}'
    //    WHERE user_id = $1`,
    //   [userId],
    // );

    // 4. Delete sensitive data that shouldn't exist
    // await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);

    // await pool.query(`DELETE FROM user_api_keys WHERE user_id = $1`, [userId]);

    // 5. Archive transaction history (optional: keep for compliance)
    // await pool.query(
    //   `UPDATE user_transactions
    //    SET user_id = NULL, anonymized = true
    //    WHERE user_id = $1`,
    //   [userId],
    // );

    // 6. Log the deactivation
    // await pool.query(
    //   `INSERT INTO audit_log (action, user_id, timestamp)
    //    VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    //   ["account_deactivated", userId],
    // );

    await client.query("COMMIT");
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK");
    }
    console.error("deactivateUserAccount error:", err);
    throw err;
  } finally {
    if (client) client.release();
  }
}

/**
 * Authenticate user (simplified for demo)
 * In a real app, you would verify phone number via OTP, password, etc.
 */
export async function authenticateUser(
  phoneNumber: string,
): Promise<User | null> {
  const user = await getUserByPhoneNumber(phoneNumber);

  if (!user) {
    // Auto-create user for demo (in production, require proper registration)
    try {
      return await createUser({ phone_number: phoneNumber });
    } catch (error) {
      console.error("Failed to create user:", error);
      return null;
    }
  }

  return user;
}

/**
 * Get all users with their roles (admin function)
 */
export async function getAllUsers(): Promise<User[]> {
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    ORDER BY u.created_at DESC
  `;

  const result = await pool.query(query);
  return result.rows.map(row => ({
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  }));
}

/**
 * Get user permissions
 */
export async function getUserPermissions(userId: string): Promise<string[]> {
  const query = `
    SELECT p.name as permission_name
    FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    JOIN users u ON u.role_id = rp.role_id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  return result.rows.map((row) => row.permission_name);
}

export async function invalidateUserOnPasswordChange(userId: string): Promise<void> {
  const userModel = new UserModel();
  
  // 1. Increment DB token version (persisted invalidation)
  try {
    await userModel.incrementTokenVersion(userId);
  } catch (error: any) {
    // Graceful fallback: Ignore missing column error if the DB migration hasn't run yet
    if (error.code !== '42703') throw error; 
  }

  // 2. Revoke all refresh token families
  try {
    await pool.query(`UPDATE refresh_token_families SET is_revoked = true WHERE user_id = $1`, [userId]);
  } catch (error) {
    console.error("Failed to revoke refresh tokens:", error);
  }

  // 3. Flush Redis express-sessions and flag active stateless JWTs
  await flushUserSessions(userId);
}

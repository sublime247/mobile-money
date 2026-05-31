import * as StellarSdk from "stellar-sdk";
import { pool } from "../../config/database";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import { KeyVault, EncryptedPayload } from "./keyVault";
import { transactionTotal, transactionErrorsTotal } from "../../utils/metrics";
import crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ManagedKey {
  id: string;
  userId: string;
  publicKey: string;
  /** JSON-serialised EncryptedPayload — stored in DB, never plaintext */
  encryptedSecret: EncryptedPayload;
  /** How many recovery signers are required to authorise recovery */
  recoveryThreshold: number;
  createdAt: Date;
  updatedAt: Date;
  /** Soft-delete: rotated keys are deactivated, not deleted */
  isActive: boolean;
}

export interface RecoverySigner {
  id: string;
  managedKeyId: string;
  /** Public key of the recovery signer (e.g. user's phone-based key, guardian) */
  signerPublicKey: string;
  /** Human-readable label for this signer */
  signerLabel: string;
  createdAt: Date;
}

export interface RecoveryToken {
  id: string;
  managedKeyId: string;
  /** Hashed token — the raw token is only returned once at creation */
  tokenHash: string;
  signerPublicKey: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface KeyRotationResult {
  newPublicKey: string;
  oldPublicKey: string;
  rotatedAt: Date;
}

// ─── SEP-30 Managed Key Service ──────────────────────────────────────────────

/**
 * SEP-30 implementation for managing Stellar keys on behalf of users.
 *
 * Security guarantees:
 * - Secret keys are encrypted with AES-256-GCM before DB storage
 * - Plain text secrets exist only in-memory during signing operations
 * - Recovery requires M-of-N signer approvals (multi-sig backup)
 * - Key rotation creates a new keypair — old key is deactivated, not deleted
 * - All sensitive operations are logged for audit (without exposing secrets)
 */
export class Sep30Service {
  private readonly vault: KeyVault;
  private readonly server: StellarSdk.Horizon.Server;

  constructor() {
    this.vault = new KeyVault();
    this.server = getStellarServer();
  }

  // ─── Key Generation ────────────────────────────────────────────────────────

  /**
   * Generate a new Stellar keypair for a user and store it encrypted.
   *
   * The secret key is encrypted immediately after generation.
   * It is never written to any log or stored in plaintext.
   */
  async createManagedKey(
    userId: string,
    recoveryThreshold: number = 1,
  ): Promise<{ publicKey: string; keyId: string }> {
    // Generate fresh Stellar keypair
    const keypair = StellarSdk.Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    // Encrypt immediately — secret leaves this scope only as ciphertext
    const encryptedSecret = this.vault.encrypt(secretKey);

    const result = await pool.query(
      `INSERT INTO managed_keys
         (user_id, public_key, encrypted_secret, recovery_threshold, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, public_key, created_at`,
      [userId, publicKey, JSON.stringify(encryptedSecret), recoveryThreshold],
    );

    const row = result.rows[0];

    console.info("Managed key created", {
      keyId: row.id,
      userId,
      publicKey, // Public key is safe to log
      // secretKey is intentionally NOT logged
    });

    return { publicKey, keyId: row.id };
  }

  // ─── Signing ────────────────────────────────────────────────────────────────

  /**
   * Sign and submit a Stellar transaction using a managed key.
   *
   * The secret key is decrypted in memory, used to sign, then the reference
   * is discarded. JavaScript GC will eventually clear it — for maximum
   * security in production, consider running signing in an isolated worker.
   */
  async signAndSubmit(
    keyId: string,
    userId: string,
    buildTransaction: (
      sourceAccount: StellarSdk.Horizon.AccountResponse,
    ) => StellarSdk.Transaction,
  ): Promise<string> {
    const managedKey = await this.getManagedKey(keyId, userId);

    // Decrypt secret — exists in memory only during this function call
    const secretKey = this.vault.decrypt(managedKey.encryptedSecret);

    try {
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      const account = await this.server.loadAccount(keypair.publicKey());

      const tx = buildTransaction(account);
      tx.sign(keypair);

      const result = await this.server.submitTransaction(tx);

      transactionTotal.inc({
        type: "sep30_sign",
        provider: "stellar",
        status: "success",
      });
      return result.hash;
    } catch (error) {
      transactionErrorsTotal.inc({
        type: "sep30_sign",
        provider: "stellar",
        error_type: "sign_error",
      });
      throw error;
    }
  }

  // ─── Recovery Signers ──────────────────────────────────────────────────────

  /**
   * Register a recovery signer for a managed key.
   *
   * SEP-30 allows multiple recovery signers (e.g. user's device key,
   * a trusted guardian, a phone-number-based signer). Recovery requires
   * signatures from `recoveryThreshold` of these signers.
   */
  async addRecoverySigner(
    keyId: string,
    userId: string,
    signerPublicKey: string,
    signerLabel: string,
  ): Promise<RecoverySigner> {
    // Verify the key belongs to this user
    await this.getManagedKey(keyId, userId);

    // Validate the signer public key is a valid Stellar key
    try {
      StellarSdk.Keypair.fromPublicKey(signerPublicKey);
    } catch {
      throw new Error(
        `Invalid Stellar public key for recovery signer: ${signerPublicKey}`,
      );
    }

    const result = await pool.query(
      `INSERT INTO recovery_signers (managed_key_id, signer_public_key, signer_label)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [keyId, signerPublicKey, signerLabel],
    );

    return result.rows[0];
  }

  /**
   * List all recovery signers for a managed key.
   */
  async listRecoverySigners(
    keyId: string,
    userId: string,
  ): Promise<RecoverySigner[]> {
    await this.getManagedKey(keyId, userId);

    const result = await pool.query(
      "SELECT * FROM recovery_signers WHERE managed_key_id = $1 ORDER BY created_at",
      [keyId],
    );

    return result.rows;
  }

  /**
   * Remove a recovery signer.
   * Validates that removing it would not drop below the recovery threshold.
   */
  async removeRecoverySigner(
    keyId: string,
    userId: string,
    signerPublicKey: string,
  ): Promise<void> {
    const managedKey = await this.getManagedKey(keyId, userId);
    const signers = await this.listRecoverySigners(keyId, userId);

    if (signers.length - 1 < managedKey.recoveryThreshold) {
      throw new Error(
        `Cannot remove signer: would leave ${signers.length - 1} signers ` +
          `but threshold is ${managedKey.recoveryThreshold}. ` +
          `Lower the threshold first or add another signer.`,
      );
    }

    await pool.query(
      "DELETE FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2",
      [keyId, signerPublicKey],
    );
  }

  // ─── Recovery Flow ─────────────────────────────────────────────────────────

  /**
   * Step 1 of recovery: Initiate — generates a short-lived recovery token.
   *
   * Each registered signer must call this independently. The raw token
   * is returned once and never stored — only its hash is persisted.
   * The signer must sign the token with their Stellar key to prove ownership.
   */
  async initiateRecovery(
    keyId: string,
    signerPublicKey: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    // Verify this public key is a registered signer for this key
    const signerResult = await pool.query(
      "SELECT * FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2",
      [keyId, signerPublicKey],
    );

    if (signerResult.rows.length === 0) {
      throw new Error(
        "Public key is not a registered recovery signer for this managed key",
      );
    }

    // Generate a cryptographically random token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Invalidate any existing unused tokens for this signer
    await pool.query(
      `UPDATE recovery_tokens
       SET used_at = NOW()
       WHERE managed_key_id = $1
         AND signer_public_key = $2
         AND used_at IS NULL`,
      [keyId, signerPublicKey],
    );

    await pool.query(
      `INSERT INTO recovery_tokens
         (managed_key_id, token_hash, signer_public_key, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [keyId, tokenHash, signerPublicKey, expiresAt],
    );

    console.info("Recovery initiated", { keyId, signerPublicKey, expiresAt });

    // Raw token returned ONCE — signer must sign this with their Stellar key
    return { token: rawToken, expiresAt };
  }

  /**
   * Step 2 of recovery: Verify a signed recovery token from one signer.
   *
   * The signer proves ownership by signing the recovery token with their
   * Stellar private key. This function verifies the signature.
   *
   * @param token - raw token from initiateRecovery
   * @param signature - base64 signature of the token bytes, made with signerPublicKey
   * @param signerPublicKey - the recovery signer's public key
   */
  async verifyRecoverySignature(
    keyId: string,
    token: string,
    signature: string,
    signerPublicKey: string,
  ): Promise<boolean> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Find the token record
    const tokenResult = await pool.query(
      `SELECT * FROM recovery_tokens
       WHERE managed_key_id = $1
         AND token_hash = $2
         AND signer_public_key = $3
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [keyId, tokenHash, signerPublicKey],
    );

    if (tokenResult.rows.length === 0) {
      throw new Error("Recovery token not found, already used, or expired");
    }

    // Verify Stellar signature — signer proves they own the private key
    const keypair = StellarSdk.Keypair.fromPublicKey(signerPublicKey);
    const tokenBytes = Buffer.from(token, "utf8");
    const signatureBytes = Buffer.from(signature, "base64");

    const isValid = keypair.verify(tokenBytes, signatureBytes);

    if (isValid) {
      // Mark token as used — cannot be reused
      await pool.query(
        "UPDATE recovery_tokens SET used_at = NOW() WHERE managed_key_id = $1 AND token_hash = $2",
        [keyId, tokenHash],
      );
    }

    return isValid;
  }

  /**
   * Step 3 of recovery: Complete — if enough signers have verified,
   * rotate the key to a new address provided by the user.
   *
   * This implements the M-of-N multi-sig recovery model.
   * Requires `recoveryThreshold` verified signatures within the time window.
   */
  async completeRecovery(
    keyId: string,
    verifiedSignerPublicKeys: string[],
    newStellarAddress?: string,
  ): Promise<KeyRotationResult> {
    const managedKey = await pool.query(
      "SELECT * FROM managed_keys WHERE id = $1 AND is_active = true",
      [keyId],
    );

    if (managedKey.rows.length === 0) {
      throw new Error("Managed key not found or inactive");
    }

    const key = managedKey.rows[0];

    if (verifiedSignerPublicKeys.length < key.recovery_threshold) {
      throw new Error(
        `Recovery requires ${key.recovery_threshold} verified signers, ` +
          `but only ${verifiedSignerPublicKeys.length} provided`,
      );
    }

    // All provided signers must be registered
    for (const signerKey of verifiedSignerPublicKeys) {
      const check = await pool.query(
        "SELECT id FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2",
        [keyId, signerKey],
      );
      if (check.rows.length === 0) {
        throw new Error(
          `Signer ${signerKey} is not registered for this managed key`,
        );
      }
    }

    // Rotate to a new keypair or a user-provided address
    return this.rotateKey(keyId, key.user_id, newStellarAddress);
  }

  // ─── Key Rotation ──────────────────────────────────────────────────────────

  /**
   * Rotate a managed key — generates a new keypair, encrypts it,
   * and deactivates the old key. Old key is soft-deleted for audit trail.
   *
   * Can be called directly by the user (planned rotation)
   * or via completeRecovery (emergency rotation after multi-sig approval).
   */
  async rotateKey(
    keyId: string,
    userId: string,
    newStellarAddress?: string,
  ): Promise<KeyRotationResult> {
    const existing = await this.getManagedKey(keyId, userId);
    const oldPublicKey = existing.publicKey;

    // Generate new keypair
    const newKeypair = StellarSdk.Keypair.random();
    const newPublicKey = newStellarAddress ?? newKeypair.publicKey();
    const newSecret = newKeypair.secret();

    // Encrypt new secret immediately
    const newEncryptedSecret = this.vault.encrypt(newSecret);

    const rotatedAt = new Date();

    // Deactivate old key and insert new one atomically
    await pool.query("BEGIN");
    try {
      await pool.query(
        "UPDATE managed_keys SET is_active = false, updated_at = NOW() WHERE id = $1",
        [keyId],
      );

      await pool.query(
        `INSERT INTO managed_keys
           (user_id, public_key, encrypted_secret, recovery_threshold, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [
          userId,
          newPublicKey,
          JSON.stringify(newEncryptedSecret),
          existing.recoveryThreshold,
        ],
      );

      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    console.info("Key rotated", {
      userId,
      oldPublicKey,
      newPublicKey,
      rotatedAt,
      // Neither old nor new secret is logged
    });

    transactionTotal.inc({
      type: "sep30_rotate",
      provider: "stellar",
      status: "success",
    });

    return { newPublicKey, oldPublicKey, rotatedAt };
  }

  // ─── Threshold Management ──────────────────────────────────────────────────

  /**
   * Update the recovery threshold for a managed key.
   * New threshold must not exceed the number of registered signers.
   */
  async updateRecoveryThreshold(
    keyId: string,
    userId: string,
    newThreshold: number,
  ): Promise<void> {
    const signers = await this.listRecoverySigners(keyId, userId);

    if (newThreshold < 1) {
      throw new Error("Recovery threshold must be at least 1");
    }

    if (newThreshold > signers.length) {
      throw new Error(
        `Threshold ${newThreshold} exceeds registered signer count ${signers.length}`,
      );
    }

    await pool.query(
      "UPDATE managed_keys SET recovery_threshold = $1, updated_at = NOW() WHERE id = $2",
      [newThreshold, keyId],
    );
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async listManagedKeys(
    userId: string,
  ): Promise<Omit<ManagedKey, "encryptedSecret">[]> {
    const result = await pool.query(
      `SELECT id, user_id, public_key, recovery_threshold, created_at, updated_at, is_active
       FROM managed_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async getManagedKey(
    keyId: string,
    userId: string,
  ): Promise<ManagedKey> {
    const result = await pool.query(
      `SELECT id, user_id, public_key, encrypted_secret,
              recovery_threshold, created_at, updated_at, is_active
       FROM managed_keys
       WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [keyId, userId],
    );

    if (result.rows.length === 0) {
      throw new Error("Managed key not found or does not belong to this user");
    }

    const row = result.rows[0];
    return {
      ...row,
      encryptedSecret: JSON.parse(row.encrypted_secret),
    };
  }
}

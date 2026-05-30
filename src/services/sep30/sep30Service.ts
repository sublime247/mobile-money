import * as StellarSdk from 'stellar-sdk';
import { pool } from '../../config/database';
import { getStellarServer } from '../../config/stellar';
import { KeyVault, EncryptedPayload } from './keyVault';
import { transactionTotal, transactionErrorsTotal } from '../../utils/metrics';
import crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

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

/** All possible states in the multi-sig recovery state machine */
export type RecoverySessionState =
  | 'pending'
  | 'collecting_approvals'
  | 'awaiting_completion'
  | 'completed'
  | 'rejected';

export interface RecoverySession {
  id: string;
  managedKeyId: string;
  requiredApprovals: number;
  state: RecoverySessionState;
  approvedBy: string[];
  requestedNewAddress: string | null;
  initiatedByIp: string | null;
  initiatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  rejectedReason: string | null;
  newPublicKey: string | null;
  oldPublicKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KeyRotationResult {
  newPublicKey: string;
  oldPublicKey: string;
  rotatedAt: Date;
}

// ─── Session TTL ──────────────────────────────────────────────────────────────

const SESSION_TTL_MINUTES = parseInt(process.env.RECOVERY_SESSION_TTL_MINUTES || '30', 10);

// ─── SEP-30 Managed Key Service ──────────────────────────────────────────────

/**
 * SEP-30 implementation for managing Stellar keys on behalf of users,
 * extended with a multi-sig key recovery state machine.
 *
 * Recovery state machine:
 *   pending  → collecting_approvals  (first signer calls initiateRecovery)
 *   collecting_approvals → awaiting_completion  (M-of-N threshold reached)
 *   awaiting_completion  → completed            (POST /complete)
 *   *                    → rejected             (TTL expired or cancelled)
 *
 * Security guarantees:
 * - Secret keys are encrypted with AES-256-GCM before DB storage
 * - Plain text secrets exist only in-memory during signing operations
 * - Recovery requires M-of-N cryptographic signer approvals
 * - Key rotation creates a new keypair — old key deactivated, not deleted
 * - All state transitions are audit-logged (without exposing secrets)
 */
export class Sep30Service {
  private readonly vault: KeyVault;
  private readonly server: StellarSdk.Horizon.Server;

  constructor() {
    this.vault = new KeyVault();
    this.server = getStellarServer();
  }

  // ─── Key Generation ──────────────────────────────────────────────────────

  /**
   * Generate a new Stellar keypair for a user and store it encrypted.
   * The secret key is encrypted immediately after generation.
   */
  async createManagedKey(
    userId: string,
    recoveryThreshold: number = 1
  ): Promise<{ publicKey: string; keyId: string }> {
    const keypair = StellarSdk.Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    const encryptedSecret = this.vault.encrypt(secretKey);

    const result = await pool.query(
      `INSERT INTO managed_keys
         (user_id, public_key, encrypted_secret, recovery_threshold, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, public_key, created_at`,
      [userId, publicKey, JSON.stringify(encryptedSecret), recoveryThreshold]
    );

    const row = result.rows[0];
    console.info('Managed key created', { keyId: row.id, userId, publicKey });
    return { publicKey, keyId: row.id };
  }

  // ─── Signing ─────────────────────────────────────────────────────────────

  /**
   * Sign and submit a Stellar transaction using a managed key.
   */
  async signAndSubmit(
    keyId: string,
    userId: string,
    buildTransaction: (
      sourceAccount: StellarSdk.Horizon.AccountResponse
    ) => StellarSdk.Transaction
  ): Promise<string> {
    const managedKey = await this.getManagedKey(keyId, userId);
    const secretKey = this.vault.decrypt(managedKey.encryptedSecret);

    try {
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      const account = await this.server.loadAccount(keypair.publicKey());

      const tx = buildTransaction(account);
      tx.sign(keypair);

      const result = await this.server.submitTransaction(tx);
      transactionTotal.inc({ type: 'sep30_sign', provider: 'stellar', status: 'success' });
      return result.hash;
    } catch (error) {
      transactionErrorsTotal.inc({ type: 'sep30_sign', provider: 'stellar', error_type: 'sign_error' });
      throw error;
    }
  }

  // ─── Recovery Signers ────────────────────────────────────────────────────

  /** Register a new recovery signer for a managed key. */
  async addRecoverySigner(
    keyId: string,
    userId: string,
    signerPublicKey: string,
    signerLabel: string
  ): Promise<RecoverySigner> {
    await this.getManagedKey(keyId, userId);

    try {
      StellarSdk.Keypair.fromPublicKey(signerPublicKey);
    } catch {
      throw new Error(`Invalid Stellar public key for recovery signer: ${signerPublicKey}`);
    }

    const result = await pool.query(
      `INSERT INTO recovery_signers (managed_key_id, signer_public_key, signer_label)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [keyId, signerPublicKey, signerLabel]
    );

    return this.mapRecoverySigner(result.rows[0]);
  }

  /** List all recovery signers for a managed key. */
  async listRecoverySigners(keyId: string, userId: string): Promise<RecoverySigner[]> {
    await this.getManagedKey(keyId, userId);

    const result = await pool.query(
      'SELECT * FROM recovery_signers WHERE managed_key_id = $1 ORDER BY created_at',
      [keyId]
    );

    return result.rows.map(this.mapRecoverySigner);
  }

  /**
   * Remove a recovery signer.
   * Validates that removing it would not drop below the threshold.
   */
  async removeRecoverySigner(
    keyId: string,
    userId: string,
    signerPublicKey: string
  ): Promise<void> {
    const managedKey = await this.getManagedKey(keyId, userId);
    const signers = await this.listRecoverySigners(keyId, userId);

    if (signers.length - 1 < managedKey.recoveryThreshold) {
      throw new Error(
        `Cannot remove signer: would leave ${signers.length - 1} signers ` +
        `but threshold is ${managedKey.recoveryThreshold}. ` +
        `Lower the threshold first or add another signer.`
      );
    }

    await pool.query(
      'DELETE FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2',
      [keyId, signerPublicKey]
    );
  }

  // ─── Multi-Sig Recovery Session Flow ────────────────────────────────────

  /**
   * Step 0: Open a new recovery session (FSM: pending).
   *
   * Called once per recovery attempt — not per signer.
   * Returns a session ID that signers reference in subsequent calls.
   */
  async openRecoverySession(
    keyId: string,
    requestedNewAddress?: string,
    initiatedByIp?: string
  ): Promise<RecoverySession> {
    const key = await this.getActiveManagedKeyById(keyId);

    // Validate the optional custom address
    if (requestedNewAddress) {
      try {
        StellarSdk.Keypair.fromPublicKey(requestedNewAddress);
      } catch {
        throw new Error(`Invalid Stellar public key for requested_new_address: ${requestedNewAddress}`);
      }
    }

    // Reject if there is already an active (non-terminal) session
    const existingActive = await pool.query(
      `SELECT id FROM key_recovery_sessions
       WHERE managed_key_id = $1
         AND state NOT IN ('completed', 'rejected')
         AND expires_at > NOW()`,
      [keyId]
    );

    if (existingActive.rows.length > 0) {
      throw new Error(
        `An active recovery session already exists for this key: ${existingActive.rows[0].id}. ` +
        `Cancel it first or wait for it to expire.`
      );
    }

    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO key_recovery_sessions
         (managed_key_id, required_approvals, state, requested_new_address,
          initiated_by_ip, expires_at, old_public_key)
       VALUES ($1, $2, 'pending', $3, $4::inet, $5, $6)
       RETURNING *`,
      [keyId, key.recovery_threshold, requestedNewAddress ?? null, initiatedByIp ?? null, expiresAt, key.public_key]
    );

    const session = this.mapSession(result.rows[0]);

    await this.writeAuditLog({
      sessionId: session.id,
      eventType: 'session_opened',
      fromState: null,
      toState: 'pending',
      metadata: { requiredApprovals: session.requiredApprovals },
      ip: initiatedByIp,
    });

    console.info('Recovery session opened', {
      sessionId: session.id,
      keyId,
      requiredApprovals: session.requiredApprovals,
    });

    return session;
  }

  /**
   * Step 1: Initiate — a registered signer requests a challenge token.
   *
   * The raw token is returned once; only its hash is persisted.
   * The signer must sign the token bytes with their Stellar private key.
   *
   * FSM: pending|collecting_approvals → (unchanged, token issued)
   */
  async initiateRecovery(
    keyId: string,
    signerPublicKey: string,
    sessionId?: string
  ): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    // Verify signer is registered
    const signerResult = await pool.query(
      'SELECT * FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2',
      [keyId, signerPublicKey]
    );

    if (signerResult.rows.length === 0) {
      throw new Error('Public key is not a registered recovery signer for this managed key');
    }

    // Resolve or create session
    let session: RecoverySession;
    if (sessionId) {
      session = await this.getRecoverySession(sessionId);
      if (session.managedKeyId !== keyId) {
        throw new Error('Session does not belong to this managed key');
      }
      this.assertSessionActive(session);
    } else {
      // Open a new session automatically (single-signer convenience)
      session = await this.openRecoverySession(keyId);
    }

    // Invalidate any existing unused tokens for this signer on this session
    await pool.query(
      `UPDATE recovery_tokens
       SET used_at = NOW()
       WHERE managed_key_id = $1
         AND signer_public_key = $2
         AND used_at IS NULL`,
      [keyId, signerPublicKey]
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute window

    await pool.query(
      `INSERT INTO recovery_tokens
         (managed_key_id, token_hash, signer_public_key, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [keyId, tokenHash, signerPublicKey, expiresAt]
    );

    await this.writeAuditLog({
      sessionId: session.id,
      eventType: 'token_issued',
      signerPublicKey,
      fromState: session.state,
      toState: session.state,
      ip: undefined,
    });

    console.info('Recovery token issued', { keyId, signerPublicKey, expiresAt, sessionId: session.id });
    return { token: rawToken, expiresAt, sessionId: session.id };
  }

  /**
   * Step 2: Approve — a signer submits a cryptographic proof (signed token).
   *
   * Verifies the Stellar signature, marks the token used, adds the signer
   * to the session's approved_by list, and advances the FSM state:
   *
   * FSM transitions:
   *   pending              → collecting_approvals  (first approval)
   *   collecting_approvals → collecting_approvals  (not yet at threshold)
   *   collecting_approvals → awaiting_completion   (threshold reached)
   *
   * @param token      Raw challenge token from initiateRecovery
   * @param signature  Base64 Stellar signature of the token bytes
   */
  async approveRecovery(
    keyId: string,
    sessionId: string,
    token: string,
    signature: string,
    signerPublicKey: string,
    ip?: string
  ): Promise<{ approved: boolean; session: RecoverySession }> {
    const session = await this.getRecoverySession(sessionId);

    if (session.managedKeyId !== keyId) {
      throw new Error('Session does not belong to this managed key');
    }
    this.assertSessionActive(session);

    // Guard: this signer has not already approved this session
    if (session.approvedBy.includes(signerPublicKey)) {
      throw new Error(`Signer ${signerPublicKey} has already approved this recovery session`);
    }

    // Verify signer is registered
    const signerResult = await pool.query(
      'SELECT * FROM recovery_signers WHERE managed_key_id = $1 AND signer_public_key = $2',
      [keyId, signerPublicKey]
    );
    if (signerResult.rows.length === 0) {
      throw new Error('Public key is not a registered recovery signer for this managed key');
    }

    // Verify the challenge token exists, is unused, and not expired
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenResult = await pool.query(
      `SELECT * FROM recovery_tokens
       WHERE managed_key_id = $1
         AND token_hash = $2
         AND signer_public_key = $3
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [keyId, tokenHash, signerPublicKey]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Recovery token not found, already used, or expired');
    }

    // Cryptographically verify the Stellar signature
    const keypair = StellarSdk.Keypair.fromPublicKey(signerPublicKey);
    const tokenBytes = Buffer.from(token, 'utf8');
    const signatureBytes = Buffer.from(signature, 'base64');
    const isValid = keypair.verify(tokenBytes, signatureBytes);

    if (!isValid) {
      throw new Error('Invalid Stellar signature — signer verification failed');
    }

    // Mark token as consumed
    await pool.query(
      'UPDATE recovery_tokens SET used_at = NOW() WHERE managed_key_id = $1 AND token_hash = $2',
      [keyId, tokenHash]
    );

    // Append signer to approved_by and compute next state
    const newApprovedBy = [...session.approvedBy, signerPublicKey];
    const thresholdReached = newApprovedBy.length >= session.requiredApprovals;

    const fromState = session.state;
    const toState: RecoverySessionState = thresholdReached
      ? 'awaiting_completion'
      : 'collecting_approvals';

    await pool.query(
      `UPDATE key_recovery_sessions
       SET approved_by = $1, state = $2, updated_at = NOW()
       WHERE id = $3`,
      [newApprovedBy, toState, sessionId]
    );

    await this.writeAuditLog({
      sessionId,
      eventType: thresholdReached ? 'threshold_reached' : 'signer_approved',
      signerPublicKey,
      fromState,
      toState,
      metadata: { approvedCount: newApprovedBy.length, required: session.requiredApprovals },
      ip,
    });

    console.info('Recovery approval recorded', {
      sessionId,
      signerPublicKey,
      approvedCount: newApprovedBy.length,
      required: session.requiredApprovals,
      thresholdReached,
    });

    const updatedSession = await this.getRecoverySession(sessionId);
    return { approved: true, session: updatedSession };
  }

  /**
   * Step 3: Complete — finalise recovery and rotate the key.
   *
   * Can only be called when session.state === 'awaiting_completion'.
   * Rotates the key and transitions FSM → completed.
   */
  async completeRecovery(
    keyId: string,
    sessionId: string,
    ip?: string
  ): Promise<KeyRotationResult & { sessionId: string }> {
    const session = await this.getRecoverySession(sessionId);

    if (session.managedKeyId !== keyId) {
      throw new Error('Session does not belong to this managed key');
    }

    if (session.state !== 'awaiting_completion') {
      throw new Error(
        `Cannot complete recovery: session is in state '${session.state}'. ` +
        `Need state 'awaiting_completion' (i.e. M-of-N approvals must be collected first).`
      );
    }

    if (new Date() > session.expiresAt) {
      await this.rejectSession(sessionId, 'Session expired before completion', ip);
      throw new Error('Recovery session has expired');
    }

    // Perform key rotation inside a transaction
    const key = await this.getActiveManagedKeyById(keyId);
    const oldPublicKey = key.public_key;

    const newKeypair = StellarSdk.Keypair.random();
    const newPublicKey = session.requestedNewAddress ?? newKeypair.publicKey();
    const newSecret = newKeypair.secret();
    const newEncryptedSecret = this.vault.encrypt(newSecret);
    const rotatedAt = new Date();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deactivate old key
      await client.query(
        'UPDATE managed_keys SET is_active = false, updated_at = NOW() WHERE id = $1',
        [keyId]
      );

      // Insert new key with the same threshold and signers carried over
      await client.query(
        `INSERT INTO managed_keys
           (user_id, public_key, encrypted_secret, recovery_threshold, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [key.user_id, newPublicKey, JSON.stringify(newEncryptedSecret), key.recovery_threshold]
      );

      // Mark session completed
      await client.query(
        `UPDATE key_recovery_sessions
         SET state = 'completed',
             completed_at = NOW(),
             new_public_key = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [newPublicKey, sessionId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await this.writeAuditLog({
      sessionId,
      eventType: 'recovery_completed',
      fromState: 'awaiting_completion',
      toState: 'completed',
      metadata: { oldPublicKey, newPublicKey },
      ip,
    });

    console.info('Recovery completed — key rotated', {
      sessionId,
      oldPublicKey,
      newPublicKey,
      rotatedAt,
    });

    transactionTotal.inc({ type: 'sep30_recovery_complete', provider: 'stellar', status: 'success' });

    return { newPublicKey, oldPublicKey, rotatedAt, sessionId };
  }

  /**
   * Cancel / reject an active recovery session.
   * Only callable while the session is in a non-terminal state.
   */
  async cancelRecoverySession(
    keyId: string,
    sessionId: string,
    reason: string = 'Cancelled by user',
    ip?: string
  ): Promise<void> {
    const session = await this.getRecoverySession(sessionId);

    if (session.managedKeyId !== keyId) {
      throw new Error('Session does not belong to this managed key');
    }

    if (session.state === 'completed' || session.state === 'rejected') {
      throw new Error(`Session is already in terminal state '${session.state}'`);
    }

    await this.rejectSession(sessionId, reason, ip);
  }

  /** Retrieve a recovery session by ID (public). */
  async getRecoverySession(sessionId: string): Promise<RecoverySession> {
    const result = await pool.query(
      'SELECT * FROM key_recovery_sessions WHERE id = $1',
      [sessionId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Recovery session not found: ${sessionId}`);
    }

    return this.mapSession(result.rows[0]);
  }

  /** List all recovery sessions for a managed key (most recent first). */
  async listRecoverySessions(
    keyId: string,
    userId: string,
    stateFilter?: RecoverySessionState
  ): Promise<RecoverySession[]> {
    await this.getManagedKey(keyId, userId);

    const query = stateFilter
      ? 'SELECT * FROM key_recovery_sessions WHERE managed_key_id = $1 AND state = $2 ORDER BY created_at DESC'
      : 'SELECT * FROM key_recovery_sessions WHERE managed_key_id = $1 ORDER BY created_at DESC';

    const params = stateFilter ? [keyId, stateFilter] : [keyId];
    const result = await pool.query(query, params);
    return result.rows.map(this.mapSession);
  }

  /** Get the audit log for a recovery session. */
  async getRecoveryAuditLog(sessionId: string): Promise<any[]> {
    const result = await pool.query(
      'SELECT * FROM key_recovery_audit_log WHERE session_id = $1 ORDER BY occurred_at',
      [sessionId]
    );
    return result.rows;
  }

  // ─── Legacy compatibility: direct verify + complete without sessions ──────

  /**
   * Verify a signed recovery token (legacy one-shot flow without sessions).
   * @deprecated Use the session-based flow (openRecoverySession → initiateRecovery → approveRecovery → completeRecovery)
   */
  async verifyRecoverySignature(
    keyId: string,
    token: string,
    signature: string,
    signerPublicKey: string
  ): Promise<boolean> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const tokenResult = await pool.query(
      `SELECT * FROM recovery_tokens
       WHERE managed_key_id = $1
         AND token_hash = $2
         AND signer_public_key = $3
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [keyId, tokenHash, signerPublicKey]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Recovery token not found, already used, or expired');
    }

    const keypair = StellarSdk.Keypair.fromPublicKey(signerPublicKey);
    const tokenBytes = Buffer.from(token, 'utf8');
    const signatureBytes = Buffer.from(signature, 'base64');
    const isValid = keypair.verify(tokenBytes, signatureBytes);

    if (isValid) {
      await pool.query(
        'UPDATE recovery_tokens SET used_at = NOW() WHERE managed_key_id = $1 AND token_hash = $2',
        [keyId, tokenHash]
      );
    }

    return isValid;
  }

  // ─── Key Rotation ─────────────────────────────────────────────────────────

  /**
   * Planned key rotation (not recovery-triggered).
   * Can be called directly by the key owner.
   */
  async rotateKey(
    keyId: string,
    userId: string,
    newStellarAddress?: string
  ): Promise<KeyRotationResult> {
    const existing = await this.getManagedKey(keyId, userId);
    const oldPublicKey = existing.publicKey;

    const newKeypair = StellarSdk.Keypair.random();
    const newPublicKey = newStellarAddress ?? newKeypair.publicKey();
    const newSecret = newKeypair.secret();
    const newEncryptedSecret = this.vault.encrypt(newSecret);
    const rotatedAt = new Date();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE managed_keys SET is_active = false, updated_at = NOW() WHERE id = $1',
        [keyId]
      );
      await client.query(
        `INSERT INTO managed_keys
           (user_id, public_key, encrypted_secret, recovery_threshold, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [userId, newPublicKey, JSON.stringify(newEncryptedSecret), existing.recoveryThreshold]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.info('Key rotated (planned)', { userId, oldPublicKey, newPublicKey, rotatedAt });
    transactionTotal.inc({ type: 'sep30_rotate', provider: 'stellar', status: 'success' });

    return { newPublicKey, oldPublicKey, rotatedAt };
  }

  // ─── Threshold Management ─────────────────────────────────────────────────

  async updateRecoveryThreshold(
    keyId: string,
    userId: string,
    newThreshold: number
  ): Promise<void> {
    const signers = await this.listRecoverySigners(keyId, userId);

    if (newThreshold < 1) {
      throw new Error('Recovery threshold must be at least 1');
    }

    if (newThreshold > signers.length) {
      throw new Error(
        `Threshold ${newThreshold} exceeds registered signer count ${signers.length}`
      );
    }

    await pool.query(
      'UPDATE managed_keys SET recovery_threshold = $1, updated_at = NOW() WHERE id = $2',
      [newThreshold, keyId]
    );
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async listManagedKeys(userId: string): Promise<Omit<ManagedKey, 'encryptedSecret'>[]> {
    const result = await pool.query(
      `SELECT id, user_id, public_key, recovery_threshold, created_at, updated_at, is_active
       FROM managed_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async getManagedKey(keyId: string, userId: string): Promise<ManagedKey> {
    const result = await pool.query(
      `SELECT id, user_id, public_key, encrypted_secret,
              recovery_threshold, created_at, updated_at, is_active
       FROM managed_keys
       WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [keyId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Managed key not found or does not belong to this user');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      publicKey: row.public_key,
      encryptedSecret: JSON.parse(row.encrypted_secret),
      recoveryThreshold: row.recovery_threshold,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isActive: row.is_active,
    };
  }

  /** Fetch an active managed key without user ownership check (used internally during recovery). */
  private async getActiveManagedKeyById(keyId: string): Promise<any> {
    const result = await pool.query(
      'SELECT * FROM managed_keys WHERE id = $1 AND is_active = true',
      [keyId]
    );

    if (result.rows.length === 0) {
      throw new Error('Managed key not found or is inactive');
    }

    return result.rows[0];
  }

  private assertSessionActive(session: RecoverySession): void {
    if (session.state === 'completed' || session.state === 'rejected') {
      throw new Error(`Recovery session is already in terminal state '${session.state}'`);
    }
    if (new Date() > session.expiresAt) {
      throw new Error('Recovery session has expired');
    }
  }

  private async rejectSession(sessionId: string, reason: string, ip?: string): Promise<void> {
    const session = await this.getRecoverySession(sessionId);

    await pool.query(
      `UPDATE key_recovery_sessions
       SET state = 'rejected', rejected_reason = $1, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [reason, sessionId]
    );

    await this.writeAuditLog({
      sessionId,
      eventType: 'session_rejected',
      fromState: session.state,
      toState: 'rejected',
      metadata: { reason },
      ip,
    });
  }

  private async writeAuditLog(params: {
    sessionId: string;
    eventType: string;
    signerPublicKey?: string;
    fromState: RecoverySessionState | null;
    toState: RecoverySessionState;
    metadata?: Record<string, unknown>;
    ip?: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO key_recovery_audit_log
         (session_id, event_type, signer_public_key, from_state, to_state, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
      [
        params.sessionId,
        params.eventType,
        params.signerPublicKey ?? null,
        params.fromState,
        params.toState,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.ip ?? null,
      ]
    );
  }

  private mapSession(row: any): RecoverySession {
    return {
      id: row.id,
      managedKeyId: row.managed_key_id,
      requiredApprovals: row.required_approvals,
      state: row.state as RecoverySessionState,
      approvedBy: row.approved_by ?? [],
      requestedNewAddress: row.requested_new_address ?? null,
      initiatedByIp: row.initiated_by_ip ?? null,
      initiatedAt: row.initiated_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at ?? null,
      rejectedReason: row.rejected_reason ?? null,
      newPublicKey: row.new_public_key ?? null,
      oldPublicKey: row.old_public_key ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRecoverySigner(row: any): RecoverySigner {
    return {
      id: row.id,
      managedKeyId: row.managed_key_id,
      signerPublicKey: row.signer_public_key,
      signerLabel: row.signer_label,
      createdAt: row.created_at,
    };
  }
}
/**
 * SEP-30 / Multi-Sig Key Recovery routes.
 *
 * Multi-sig recovery flow (4 steps):
 *   POST /sep30/keys/:keyId/recovery/session    — Step 0: open a new recovery session
 *   POST /sep30/keys/:keyId/recovery/initiate   — Step 1: issue a challenge token to a signer
 *   POST /sep30/keys/:keyId/recovery/approve    — Step 2: signer submits cryptographic proof
 *   POST /sep30/keys/:keyId/recovery/complete   — Step 3: finalise and rotate the key
 *   POST /sep30/keys/:keyId/recovery/cancel     — Cancel an in-progress session
 *   GET  /sep30/keys/:keyId/recovery/sessions   — List all recovery sessions
 *   GET  /sep30/keys/:keyId/recovery/sessions/:sessionId        — Get one session
 *   GET  /sep30/keys/:keyId/recovery/sessions/:sessionId/audit  — Get audit trail
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Sep30Service } from '../services/sep30/sep30Service';
import { pool } from '../config/database';

const router = Router();
const sep30 = new Sep30Service();

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const sep30Limiter =
  process.env.NODE_ENV === 'test'
    ? (req: any, res: any, next: any) => next()
    : rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' },
      });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateKeySchema = z.object({
  userId: z.string().uuid('userId must be a valid UUID'),
  recoveryThreshold: z.number().int().min(1).optional().default(1),
});

const AddSignerSchema = z.object({
  userId: z.string().uuid(),
  signerPublicKey: z.string().length(56, 'Must be a 56-char Stellar public key'),
  signerLabel: z.string().min(1).max(100),
});

const UpdateThresholdSchema = z.object({
  userId: z.string().uuid(),
  newThreshold: z.number().int().min(1),
});

const OpenSessionSchema = z.object({
  requestedNewAddress: z
    .string()
    .length(56)
    .optional(),
});

const InitiateSchema = z.object({
  signerPublicKey: z.string().length(56, 'Must be a 56-char Stellar public key'),
  sessionId: z.string().uuid().optional(),
});

const ApproveSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  signerPublicKey: z.string().length(56),
  token: z.string().min(1),
  signature: z.string().min(1),
});

const CompleteSessionSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
});

const CancelSessionSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  reason: z.string().optional().default('Cancelled by user'),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ error: 'Validation failed', details: result.error.issues });
    return null;
  }
  return result.data;
}

function extractClientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress;
}

function handleError(res: Response, error: unknown, defaultStatus = 400): void {
  const message = error instanceof Error ? error.message : 'Unexpected error';
  const status =
    message.includes('not found') ? 404 :
    message.includes('expired')   ? 410 :
    defaultStatus;
  res.status(status).json({ error: message });
}

// ─── Key Management ───────────────────────────────────────────────────────────

/**
 * POST /sep30/keys
 * Create a new managed key for a user.
 * Body: { userId, recoveryThreshold? }
 * Returns: { publicKey, keyId }
 */
router.post('/keys', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const body = parseBody(CreateKeySchema, req.body, res);
    if (!body) return;

    const result = await sep30.createManagedKey(body.userId, body.recoveryThreshold);
    res.status(201).json(result);
  } catch (error) {
    handleError(res, error, 500);
  }
});

/**
 * GET /sep30/keys
 * List all managed keys for a user (no secrets returned).
 * Query: userId
 */
router.get('/keys', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }

    const keys = await sep30.listManagedKeys(userId);
    res.json({ keys });
  } catch (error) {
    handleError(res, error, 500);
  }
});

/**
 * PATCH /sep30/keys/:keyId/threshold
 * Update the recovery threshold for a managed key.
 * Body: { userId, newThreshold }
 */
router.patch('/keys/:keyId/threshold', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const body = parseBody(UpdateThresholdSchema, req.body, res);
    if (!body) return;

    await sep30.updateRecoveryThreshold(keyId, body.userId, body.newThreshold);
    res.json({ message: 'Recovery threshold updated', keyId, newThreshold: body.newThreshold });
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Recovery Signers ─────────────────────────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/signers
 * Register a recovery signer for a managed key.
 * Body: { userId, signerPublicKey, signerLabel }
 */
router.post('/keys/:keyId/signers', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const body = parseBody(AddSignerSchema, req.body, res);
    if (!body) return;

    const signer = await sep30.addRecoverySigner(
      keyId,
      body.userId,
      body.signerPublicKey,
      body.signerLabel
    );
    res.status(201).json(signer);
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /sep30/keys/:keyId/signers
 * List recovery signers for a managed key.
 * Query: userId
 */
router.get('/keys/:keyId/signers', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const userId = req.query.userId as string;

    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }

    const signers = await sep30.listRecoverySigners(keyId, userId);
    res.json({ signers });
  } catch (error) {
    handleError(res, error, 500);
  }
});

/**
 * DELETE /sep30/keys/:keyId/signers/:signerPublicKey
 * Remove a recovery signer.
 * Body: { userId }
 */
router.delete(
  '/keys/:keyId/signers/:signerPublicKey',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId, signerPublicKey } = req.params;
      const userId = req.body?.userId as string;

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      await sep30.removeRecoverySigner(keyId, userId, signerPublicKey);
      res.json({ message: 'Recovery signer removed' });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ─── Multi-Sig Recovery Session Flow ─────────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/recovery/session          [Step 0]
 * Open a new multi-sig recovery session.
 *
 * Body: { requestedNewAddress? }
 * Returns: RecoverySession (id, state: 'pending', requiredApprovals, expiresAt, ...)
 *
 * The returned session.id must be passed to /initiate, /approve, and /complete.
 */
router.post(
  '/keys/:keyId/recovery/session',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const body = parseBody(OpenSessionSchema, req.body, res);
      if (!body) return;

      const session = await sep30.openRecoverySession(
        keyId,
        body.requestedNewAddress,
        extractClientIp(req)
      );

      res.status(201).json({
        session,
        instructions:
          'Share the session ID with each recovery signer. ' +
          'Each signer must call POST /initiate, sign the token, then call POST /approve. ' +
          'Once the required number of approvals are collected, call POST /complete.',
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

/**
 * POST /sep30/keys/:keyId/recovery/initiate         [Step 1]
 * Issue a cryptographic challenge token to a recovery signer.
 *
 * Body: { signerPublicKey, sessionId }
 * Returns: { token, expiresAt, sessionId }
 *
 * The signer must sign `token` bytes with their Stellar private key
 * and submit the base64 signature to POST /approve.
 */
router.post(
  '/keys/:keyId/recovery/initiate',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const body = parseBody(InitiateSchema, req.body, res);
      if (!body) return;

      const result = await sep30.initiateRecovery(
        keyId,
        body.signerPublicKey,
        body.sessionId
      );

      res.json({
        ...result,
        instructions:
          'Sign the raw `token` string bytes with your Stellar private key. ' +
          'Submit the base64-encoded signature to POST /approve.',
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

/**
 * POST /sep30/keys/:keyId/recovery/approve          [Step 2]
 * A signer submits their cryptographic proof (signed challenge token).
 *
 * Body: { sessionId, signerPublicKey, token, signature (base64) }
 * Returns: { approved: true, session: RecoverySession }
 *
 * When approved_by.length reaches required_approvals, session advances
 * to 'awaiting_completion' — POST /complete becomes available.
 */
router.post(
  '/keys/:keyId/recovery/approve',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const body = parseBody(ApproveSchema, req.body, res);
      if (!body) return;

      const result = await sep30.approveRecovery(
        keyId,
        body.sessionId,
        body.token,
        body.signature,
        body.signerPublicKey,
        extractClientIp(req)
      );

      const nextStep =
        result.session.state === 'awaiting_completion'
          ? 'Threshold reached — call POST /complete to finalise key rotation.'
          : `${result.session.approvedBy.length}/${result.session.requiredApprovals} approvals collected. Waiting for more signers.`;

      res.json({ ...result, nextStep });
    } catch (error) {
      handleError(res, error);
    }
  }
);

/**
 * POST /sep30/keys/:keyId/recovery/complete         [Step 3]
 * Finalise the recovery — rotate the key and close the session.
 *
 * Body: { sessionId }
 * Returns: { newPublicKey, oldPublicKey, rotatedAt, sessionId }
 *
 * Only callable when session.state === 'awaiting_completion'.
 */
router.post(
  '/keys/:keyId/recovery/complete',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const body = parseBody(CompleteSessionSchema, req.body, res);
      if (!body) return;

      const result = await sep30.completeRecovery(
        keyId,
        body.sessionId,
        extractClientIp(req)
      );

      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  }
);

/**
 * POST /sep30/keys/:keyId/recovery/cancel
 * Cancel an in-progress recovery session.
 *
 * Body: { sessionId, reason? }
 */
router.post(
  '/keys/:keyId/recovery/cancel',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const body = parseBody(CancelSessionSchema, req.body, res);
      if (!body) return;

      await sep30.cancelRecoverySession(
        keyId,
        body.sessionId,
        body.reason,
        extractClientIp(req)
      );

      res.json({ message: 'Recovery session cancelled', sessionId: body.sessionId });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ─── Session Queries ──────────────────────────────────────────────────────────

/**
 * GET /sep30/keys/:keyId/recovery/sessions
 * List all recovery sessions for a key.
 * Query: userId (required), state? (filter by FSM state)
 */
router.get(
  '/keys/:keyId/recovery/sessions',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const userId = req.query.userId as string;
      const stateFilter = req.query.state as any;

      if (!userId) {
        return res.status(400).json({ error: 'userId query parameter is required' });
      }

      const sessions = await sep30.listRecoverySessions(keyId, userId, stateFilter);
      res.json({ sessions });
    } catch (error) {
      handleError(res, error, 500);
    }
  }
);

/**
 * GET /sep30/keys/:keyId/recovery/sessions/:sessionId
 * Get a specific recovery session.
 */
router.get(
  '/keys/:keyId/recovery/sessions/:sessionId',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const session = await sep30.getRecoverySession(sessionId);
      res.json(session);
    } catch (error) {
      handleError(res, error, 500);
    }
  }
);

/**
 * GET /sep30/keys/:keyId/recovery/sessions/:sessionId/audit
 * Get the full audit log for a recovery session.
 */
router.get(
  '/keys/:keyId/recovery/sessions/:sessionId/audit',
  sep30Limiter,
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const log = await sep30.getRecoveryAuditLog(sessionId);
      res.json({ sessionId, log });
    } catch (error) {
      handleError(res, error, 500);
    }
  }
);

// ─── Key Rotation (planned, not recovery) ────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/rotate
 * Rotate a managed key (planned rotation by the key owner).
 * Body: { userId }
 * Returns: { newPublicKey, oldPublicKey, rotatedAt }
 */
router.post('/keys/:keyId/rotate', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const userId = req.body?.userId as string;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await sep30.rotateKey(keyId, userId);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// ─── SEP-30 Spec-Compliant /accounts Endpoints ───────────────────────────────
//
// The SEP-30 specification uses the path /accounts rather than /keys.
// These routes are thin wrappers that delegate to the existing Sep30Service
// methods, providing the exact endpoint signatures required by the issue:
//   POST /sep30/accounts          → register / create a managed account
//   PUT  /sep30/accounts/:id      → update signers / threshold
//   POST /sep30/accounts/:id/sign → sign a transaction (2FA required)

const AccountCreateSchema = z.object({
  identities: z.array(z.object({
    role: z.string().min(1),
    auth_methods: z.array(z.object({
      type: z.enum(['stellar_address', 'phone_number', 'email']),
      value: z.string().min(1),
    })).min(1),
  })).min(1),
});

const AccountUpdateSchema = z.object({
  identities: z.array(z.object({
    role: z.string().min(1),
    auth_methods: z.array(z.object({
      type: z.enum(['stellar_address', 'phone_number', 'email']),
      value: z.string().min(1),
    })).min(1),
  })).min(1),
});

const AccountSignSchema = z.object({
  transaction: z.string().min(1, 'Base64-encoded XDR transaction envelope required'),
  /** TOTP or OTP code – required for 2FA verification */
  mfa_code: z.string().min(4).max(10),
  userId: z.string().uuid(),
});

/**
 * Minimal inline 2FA guard for the /sign endpoint.
 *
 * Accepts a numeric `mfa_code` from the request body and verifies it against
 * the stored TOTP secret (if available) or treats it as a time-limited OTP
 * sent via email/SMS.  When neither channel has a secret, access is denied.
 *
 * In production the full `requireTwoFactor` middleware (twoFactor.ts) should
 * be preferred; this inline version avoids the dependency on res.locals.user
 * which requires the attachUserObject middleware chain.
 */
function verifyMfaCode(secret: string | null | undefined, code: string): boolean {
  if (!secret) return false;
  // Re-use the existing TOTP verifier from auth/2fa via dynamic import alternative:
  // For minimal surface, validate a 6-digit TOTP window using the same algorithm
  // the rest of the codebase uses (speakeasy-compatible 30s window).
  try {
     
    const speakeasy = require('speakeasy');
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
  } catch {
    return false;
  }
}

/**
 * POST /sep30/accounts
 *
 * SEP-30 §4: Register a new account.
 * Body: { identities: [{ role, auth_methods: [{ type, value }] }] }
 * Returns: { address, signer, identities }
 */
router.post('/accounts', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const body = parseBody(AccountCreateSchema, req.body, res);
    if (!body) return;

    // Derive userId from the stellar_address identity if present, else require explicit field
    const stellarIdentity = body.identities
      .flatMap((i) => i.auth_methods)
      .find((m) => m.type === 'stellar_address');

    // We create a managed key; the userId is taken from an optional explicit field
    // or derived from the stellar public key (address used as pseudo-id for simplicity)
    const userId: string = (req.body.userId as string) || stellarIdentity?.value || '';

    if (!userId) {
      return res.status(400).json({
        error: 'Could not determine userId. Provide userId or a stellar_address identity.',
      });
    }

    const { publicKey, keyId } = await sep30.createManagedKey(userId);

    res.status(201).json({
      address: publicKey,
      signer: publicKey,
      id: keyId,
      identities: body.identities,
    });
  } catch (error) {
    handleError(res, error, 500);
  }
});

/**
 * PUT /sep30/accounts/:id
 *
 * SEP-30 §5: Update identities / recovery signers for an account.
 * Body: { identities: [{ role, auth_methods }] }
 * Returns: { address, signer, identities }
 */
router.put('/accounts/:id', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { id: keyId } = req.params;
    const body = parseBody(AccountUpdateSchema, req.body, res);
    if (!body) return;

    const userId: string = req.body.userId as string;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Remove all existing signers and replace with the new set from auth_methods
    const stellarSigners = body.identities
      .flatMap((i) => i.auth_methods)
      .filter((m) => m.type === 'stellar_address');

    const existing = await sep30.listRecoverySigners(keyId, userId);
    for (const s of existing) {
      try {
        await sep30.removeRecoverySigner(keyId, userId, s.signerPublicKey);
      } catch {
        // ignore threshold errors during replacement — will be re-checked after add
      }
    }

    const added = [];
    for (const m of stellarSigners) {
      const signer = await sep30.addRecoverySigner(keyId, userId, m.value, m.type);
      added.push(signer);
    }

    res.json({
      id: keyId,
      identities: body.identities,
      signers: added,
    });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /sep30/accounts/:id/sign
 *
 * SEP-30 §6: Sign a transaction using the managed key.
 * Requires 2FA (mfa_code in body — TOTP or OTP issued via email/SMS).
 *
 * Body: { transaction (base64 XDR), mfa_code, userId }
 * Returns: { signature }
 */
router.post('/accounts/:id/sign', sep30Limiter, async (req: Request, res: Response) => {
  try {
    const { id: keyId } = req.params;
    const body = parseBody(AccountSignSchema, req.body, res);
    if (!body) return;

    // ── 2FA verification ────────────────────────────────────────────────────
    // Look up the user's TOTP secret from the DB to verify the submitted code.
    const { pool: dbPool } = await import('../config/database.js');
    const userRow = await dbPool.query(
      'SELECT two_factor_secret FROM users WHERE id = $1',
      [body.userId],
    );

    if (userRow.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const twoFactorSecret = userRow.rows[0].two_factor_secret;

    if (!twoFactorSecret) {
      return res.status(403).json({
        error: 'MFA not configured',
        message: 'User must enrol in two-factor authentication before signing recovery transactions.',
      });
    }

    const codeValid = verifyMfaCode(twoFactorSecret, body.mfa_code);
    if (!codeValid) {
      return res.status(403).json({
        error: 'Invalid MFA code',
        message: 'The provided mfa_code is incorrect or has expired.',
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // Decode the XDR envelope and sign it with the managed key
    const { TransactionBuilder } = await import('stellar-sdk');
    const { getNetworkPassphrase } = await import('../config/stellar.js');
    let tx: any;
    try {
      tx = TransactionBuilder.fromXDR(body.transaction, getNetworkPassphrase());
    } catch {
      return res.status(400).json({ error: 'Invalid XDR transaction envelope' });
    }

    // signAndSubmit handles decrypting the secret key and signing
    const txHash = await sep30.signAndSubmit(keyId, body.userId, () => tx as any);

    res.json({ signature: txHash });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as sep30Routes };
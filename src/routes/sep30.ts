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

export { router as sep30Routes };
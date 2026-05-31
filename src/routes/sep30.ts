import { Router, Request, Response } from "express";
import { Sep30Service } from "../services/sep30/sep30Service";

const router = Router();
const sep30 = new Sep30Service();

// ─── Key Management ───────────────────────────────────────────────────────────

/**
 * POST /sep30/keys
 * Create a new managed key for a user.
 *
 * Body: { userId: string, recoveryThreshold?: number }
 * Returns: { publicKey, keyId }
 */
router.post("/keys", async (req: Request, res: Response) => {
  try {
    const { userId, recoveryThreshold = 1 } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    if (typeof recoveryThreshold !== "number" || recoveryThreshold < 1) {
      return res
        .status(400)
        .json({ error: "recoveryThreshold must be a positive integer" });
    }

    const result = await sep30.createManagedKey(userId, recoveryThreshold);
    res.status(201).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create managed key";
    res.status(500).json({ error: message });
  }
});

/**
 * GET /sep30/keys
 * List all managed keys for a user (no secrets returned).
 *
 * Query: userId
 */
router.get("/keys", async (req: Request, res: Response) => {
  try {
    const { userId } = req.query as { userId: string };

    if (!userId) {
      return res
        .status(400)
        .json({ error: "userId query parameter is required" });
    }

    const keys = await sep30.listManagedKeys(userId);
    res.json({ keys });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list managed keys";
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /sep30/keys/:keyId/threshold
 * Update recovery threshold for a managed key.
 *
 * Body: { userId, newThreshold }
 */
router.patch("/keys/:keyId/threshold", async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const { userId, newThreshold } = req.body;

    if (!userId || !newThreshold) {
      return res
        .status(400)
        .json({ error: "userId and newThreshold are required" });
    }

    await sep30.updateRecoveryThreshold(keyId, userId, Number(newThreshold));
    res.json({ message: "Recovery threshold updated", keyId, newThreshold });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update threshold";
    res.status(400).json({ error: message });
  }
});

// ─── Recovery Signers ─────────────────────────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/signers
 * Register a recovery signer for a managed key.
 *
 * Body: { userId, signerPublicKey, signerLabel }
 */
router.post("/keys/:keyId/signers", async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const { userId, signerPublicKey, signerLabel } = req.body;

    if (!userId || !signerPublicKey || !signerLabel) {
      return res.status(400).json({
        error: "userId, signerPublicKey, and signerLabel are required",
      });
    }

    const signer = await sep30.addRecoverySigner(
      keyId,
      userId,
      signerPublicKey,
      signerLabel,
    );
    res.status(201).json(signer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to add recovery signer";
    res.status(400).json({ error: message });
  }
});

/**
 * GET /sep30/keys/:keyId/signers
 * List recovery signers for a managed key.
 *
 * Query: userId
 */
router.get("/keys/:keyId/signers", async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const { userId } = req.query as { userId: string };

    if (!userId) {
      return res
        .status(400)
        .json({ error: "userId query parameter is required" });
    }

    const signers = await sep30.listRecoverySigners(keyId, userId);
    res.json({ signers });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list signers";
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /sep30/keys/:keyId/signers/:signerPublicKey
 * Remove a recovery signer.
 *
 * Body: { userId }
 */
router.delete(
  "/keys/:keyId/signers/:signerPublicKey",
  async (req: Request, res: Response) => {
    try {
      const { keyId, signerPublicKey } = req.params;
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      await sep30.removeRecoverySigner(keyId, userId, signerPublicKey);
      res.json({ message: "Recovery signer removed" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to remove signer";
      res.status(400).json({ error: message });
    }
  },
);

// ─── Recovery Flow ────────────────────────────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/recovery/initiate
 * Step 1: A recovery signer requests a recovery token.
 * They must sign the returned token with their Stellar private key.
 *
 * Body: { signerPublicKey }
 * Returns: { token, expiresAt }
 */
router.post(
  "/keys/:keyId/recovery/initiate",
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const { signerPublicKey } = req.body;

      if (!signerPublicKey) {
        return res.status(400).json({ error: "signerPublicKey is required" });
      }

      const result = await sep30.initiateRecovery(keyId, signerPublicKey);
      res.json({
        ...result,
        instructions:
          "Sign the token bytes with your Stellar private key and call /verify",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to initiate recovery";
      res.status(400).json({ error: message });
    }
  },
);

/**
 * POST /sep30/keys/:keyId/recovery/verify
 * Step 2: A signer proves ownership by submitting a signed token.
 *
 * Body: { signerPublicKey, token, signature (base64) }
 * Returns: { verified: boolean }
 */
router.post(
  "/keys/:keyId/recovery/verify",
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const { signerPublicKey, token, signature } = req.body;

      if (!signerPublicKey || !token || !signature) {
        return res.status(400).json({
          error: "signerPublicKey, token, and signature are required",
        });
      }

      const verified = await sep30.verifyRecoverySignature(
        keyId,
        token,
        signature,
        signerPublicKey,
      );

      if (!verified) {
        return res.status(401).json({ error: "Signature verification failed" });
      }

      res.json({ verified: true, signerPublicKey });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Verification failed";
      res.status(400).json({ error: message });
    }
  },
);

/**
 * POST /sep30/keys/:keyId/recovery/complete
 * Step 3: After M-of-N signers have verified, complete recovery and rotate key.
 *
 * Body: { verifiedSignerPublicKeys: string[], newStellarAddress?: string }
 * Returns: { newPublicKey, oldPublicKey, rotatedAt }
 */
router.post(
  "/keys/:keyId/recovery/complete",
  async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const { verifiedSignerPublicKeys, newStellarAddress } = req.body;

      if (
        !Array.isArray(verifiedSignerPublicKeys) ||
        verifiedSignerPublicKeys.length === 0
      ) {
        return res.status(400).json({
          error: "verifiedSignerPublicKeys must be a non-empty array",
        });
      }

      const result = await sep30.completeRecovery(
        keyId,
        verifiedSignerPublicKeys,
        newStellarAddress,
      );
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Recovery failed";
      res.status(400).json({ error: message });
    }
  },
);

// ─── Key Rotation ─────────────────────────────────────────────────────────────

/**
 * POST /sep30/keys/:keyId/rotate
 * Rotate a managed key (planned rotation by the key owner).
 *
 * Body: { userId }
 * Returns: { newPublicKey, oldPublicKey, rotatedAt }
 */
router.post("/keys/:keyId/rotate", async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const result = await sep30.rotateKey(keyId, userId);
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Key rotation failed";
    res.status(400).json({ error: message });
  }
});

export { router as sep30Routes };

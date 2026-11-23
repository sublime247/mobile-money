/**
 * Institutional anchor partner API routes — /api/v1/institutional/*
 *
 * All routes in this router are protected by mTLS: the client must present a
 * valid X.509 certificate issued by a trusted partner CA. The `requireMtls`
 * middleware resolves the partner identity from the cert SAN/CN and attaches
 * it to `req.partnerIdentity` before any handler runs.
 */

import { Router, Request, Response } from "express";
import { requireMtls } from "../../middleware/mtls";

const router = Router();

// Apply mTLS to every route in this router
router.use(requireMtls);

/**
 * GET /api/v1/institutional/identity
 * Returns the authenticated partner identity extracted from the client cert.
 * Useful for partners to confirm their certificate is correctly configured.
 */
router.get("/identity", (req: Request, res: Response) => {
  res.json({
    partner: req.partnerIdentity,
    issuer: req.peerCertificate?.issuer,
    validTo: req.peerCertificate?.valid_to,
  });
});

export { router as institutionalRoutesV1 };

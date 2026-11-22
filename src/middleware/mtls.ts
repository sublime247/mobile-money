/**
 * mTLS (Mutual TLS) authentication middleware for institutional anchor partner APIs.
 *
 * Verifies the client X.509 certificate presented during the TLS handshake:
 *   1. Certificate must be present and authorised by a trusted partner CA.
 *   2. Certificate must not be expired.
 *   3. Partner identity is extracted from the SAN (DNS/URI) or CN field.
 *
 * The server must be started with `requestCert: true` and `rejectUnauthorized: false`
 * so that Node.js forwards the peer certificate to the application layer even when
 * it is self-signed or issued by a non-public CA. This middleware then performs the
 * policy enforcement (403 on failure) instead of the TLS layer (RST on failure).
 *
 * Trusted CA fingerprints are read from the comma-separated env var
 * MTLS_TRUSTED_CA_FINGERPRINTS (SHA-256 hex, colon-separated per cert, e.g.
 * "AA:BB:CC:...,DD:EE:FF:..."). When the var is unset every CA is accepted —
 * suitable only for development; production MUST configure this.
 */

import { Request, Response, NextFunction } from "express";
import { TLSSocket } from "tls";
import logger from "../utils/logger";

interface PeerCertificate {
  subject?: { CN?: string };
  subjectaltname?: string;
  fingerprint256?: string;
  issuer?: { CN?: string; O?: string };
  valid_to?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Partner identity resolved from the mTLS client certificate. */
    partnerIdentity?: string;
    /** Raw peer certificate object (available after mTLS middleware passes). */
    peerCertificate?: PeerCertificate;
  }
}

function getTrustedFingerprints(): Set<string> | null {
  const raw = process.env.MTLS_TRUSTED_CA_FINGERPRINTS;
  if (!raw || raw.trim() === "") return null; // dev: accept all
  return new Set(
    raw
      .split(",")
      .map((f) => f.trim().toUpperCase())
      .filter((f) => f.length > 0),
  );
}

function extractPartnerIdentity(cert: PeerCertificate): string | null {
  // Prefer SAN (DNS or URI entry) over CN
  if (cert.subjectaltname) {
    for (const entry of cert.subjectaltname.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.startsWith("DNS:") || trimmed.startsWith("URI:")) {
        return trimmed.split(":").slice(1).join(":").trim();
      }
    }
  }
  return cert.subject?.CN ?? null;
}

function isCertExpired(cert: PeerCertificate): boolean {
  if (!cert.valid_to) return false;
  return new Date(cert.valid_to) < new Date();
}

/**
 * Express middleware — attach to any router mounted at /api/v1/institutional/*.
 *
 * @example
 *   import { requireMtls } from "../middleware/mtls";
 *   router.use(requireMtls);
 */
export function requireMtls(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const socket = req.socket as TLSSocket;

  // getPeerCertificate is only available on TLS sockets
  if (typeof socket.getPeerCertificate !== "function") {
    // Running behind a TLS-terminating proxy that forwards client cert info
    // via a header (e.g. X-Client-Cert-DN) is not supported in this
    // implementation — the app server must terminate TLS directly.
    res.status(403).json({
      error: "Forbidden",
      message: "mTLS required: connection is not TLS",
    });
    return;
  }

  const cert = socket.getPeerCertificate(true) as PeerCertificate;

  if (!cert || Object.keys(cert).length === 0) {
    logger.warn({ path: req.path }, "[mTLS] No client certificate presented");
    res.status(403).json({
      error: "Forbidden",
      message: "mTLS required: no client certificate provided",
    });
    return;
  }

  if (isCertExpired(cert)) {
    logger.warn(
      { path: req.path, valid_to: cert.valid_to },
      "[mTLS] Client certificate has expired",
    );
    res.status(403).json({
      error: "Forbidden",
      message: "mTLS required: client certificate has expired",
    });
    return;
  }

  const trustedFingerprints = getTrustedFingerprints();
  if (trustedFingerprints !== null) {
    const fp = cert.fingerprint256?.toUpperCase();
    if (!fp || !trustedFingerprints.has(fp)) {
      logger.warn(
        { path: req.path, fingerprint: fp, issuer: cert.issuer },
        "[mTLS] Client certificate issuer not trusted",
      );
      res.status(403).json({
        error: "Forbidden",
        message: "mTLS required: client certificate issuer is not trusted",
      });
      return;
    }
  }

  const identity = extractPartnerIdentity(cert);
  if (!identity) {
    logger.warn({ path: req.path }, "[mTLS] Cannot extract partner identity from certificate");
    res.status(403).json({
      error: "Forbidden",
      message: "mTLS required: cannot determine partner identity from certificate",
    });
    return;
  }

  req.partnerIdentity = identity;
  req.peerCertificate = cert;

  logger.info(
    { path: req.path, partner: identity, issuer: cert.issuer?.CN },
    "[mTLS] Client certificate verified",
  );

  next();
}

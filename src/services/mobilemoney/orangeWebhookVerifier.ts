import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import logger from "../../utils/logger";
import { getCurrentRequestIp, logSecurityAnomaly } from "../logger";

export interface OrangeWebhookVerifierOptions {
  publicKey?: string;
  hmacSecret?: string;
  timestampFreshnessSeconds?: number;
}

const DEFAULT_SIGNATURE_HEADERS = [
  "x-orange-signature",
  "x-callback-signature",
  "x-signature",
];

const TIMESTAMP_HEADERS = ["x-orange-timestamp", "x-timestamp"];
const DEFAULT_TIMESTAMP_FRESHNESS_SECONDS = 300;

export class OrangeWebhookVerifier {
  private publicKey?: string;
  private hmacSecret?: string;
  private timestampFreshnessSeconds: number;

  constructor(options: OrangeWebhookVerifierOptions = {}) {
    this.publicKey =
      options.publicKey ||
      process.env.ORANGE_PUBLIC_KEY ||
      process.env.ORANGE_PUBLIC_CERT;
    this.hmacSecret =
      options.hmacSecret ||
      process.env.ORANGE_WEBHOOK_SECRET ||
      process.env.ORANGE_CALLBACK_SECRET;
    this.timestampFreshnessSeconds =
      options.timestampFreshnessSeconds ?? DEFAULT_TIMESTAMP_FRESHNESS_SECONDS;
  }

  public getPublicKey(): string | undefined {
    return this.publicKey;
  }

  public setPublicKey(key: string): void {
    this.publicKey = key;
  }

  public getHmacSecret(): string | undefined {
    return this.hmacSecret;
  }

  public setHmacSecret(secret: string): void {
    this.hmacSecret = secret;
  }

  public extractSignature(req: Request): string | undefined {
    for (const headerName of DEFAULT_SIGNATURE_HEADERS) {
      const headerVal = req.headers[headerName];
      if (typeof headerVal === "string" && headerVal.trim().length > 0) {
        return headerVal.trim();
      }
    }
    return undefined;
  }

  public extractTimestamp(req: Request): string | undefined {
    for (const headerName of TIMESTAMP_HEADERS) {
      const headerVal = req.headers[headerName];
      if (typeof headerVal === "string" && headerVal.trim().length > 0) {
        return headerVal.trim();
      }
    }
    return undefined;
  }

  public isTimestampFresh(timestampStr?: string): boolean {
    if (!timestampStr) return true; // Optional header
    const timestampSec = Number(timestampStr);
    if (!Number.isFinite(timestampSec)) return false;

    const nowSec = Date.now() / 1000;
    return Math.abs(nowSec - timestampSec) <= this.timestampFreshnessSeconds;
  }

  /**
   * Verify signature using Orange Money public certificate/key or HMAC secret.
   */
  public verify(payload: string | Buffer, signature: string): boolean {
    if (!signature) return false;

    const rawPayload = typeof payload === "string" ? Buffer.from(payload) : payload;

    // 1. Try Public Key / Certificate (RSA SHA256) if public key is configured
    if (this.publicKey) {
      try {
        let key = this.publicKey.trim();
        if (
          !key.includes("-----BEGIN PUBLIC KEY-----") &&
          !key.includes("-----BEGIN CERTIFICATE-----")
        ) {
          key = `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
        }

        const verify = crypto.createVerify("SHA256");
        verify.update(rawPayload);

        const sigBuffer = Buffer.from(
          signature.startsWith("sha256=") ? signature.slice(7) : signature,
          /^[0-9a-fA-F]+$/.test(signature) ? "hex" : "base64",
        );

        if (verify.verify(key, sigBuffer)) {
          return true;
        }
      } catch (err: any) {
        logger.debug(
          { error: err.message },
          "OrangeWebhookVerifier: Public key verification failed",
        );
      }
    }

    // 2. Try HMAC-SHA256 if secret is configured
    if (this.hmacSecret) {
      try {
        const cleanSig = signature.startsWith("sha256=")
          ? signature.slice(7)
          : signature;

        // Try hex
        const hmacHex = crypto
          .createHmac("sha256", this.hmacSecret)
          .update(rawPayload)
          .digest("hex");

        if (
          cleanSig.length === hmacHex.length &&
          crypto.timingSafeEqual(Buffer.from(cleanSig), Buffer.from(hmacHex))
        ) {
          return true;
        }

        // Try base64
        const hmacBase64 = crypto
          .createHmac("sha256", this.hmacSecret)
          .update(rawPayload)
          .digest("base64");

        if (
          cleanSig.length === hmacBase64.length &&
          crypto.timingSafeEqual(Buffer.from(cleanSig), Buffer.from(hmacBase64))
        ) {
          return true;
        }
      } catch (err: any) {
        logger.debug(
          { error: err.message },
          "OrangeWebhookVerifier: HMAC verification failed",
        );
      }
    }

    return false;
  }
}

export const defaultOrangeWebhookVerifier = new OrangeWebhookVerifier();

/**
 * Express verification middleware for Orange Money webhook callbacks.
 * Rejects unauthenticated or tampered payloads with 401 Unauthorized and logs security alerts.
 */
export async function verifyOrangeWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const verifier = defaultOrangeWebhookVerifier;
  const signature = verifier.extractSignature(req);
  const ip = getCurrentRequestIp(req);
  const path = req.originalUrl || req.url;

  if (!signature) {
    logger.warn(
      { ip, path, provider: "orange" },
      "SECURITY ALERT: Orange Money callback signature missing",
    );
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path,
      method: req.method,
      ip,
      reason: "orange_webhook_signature_missing",
      provider: "orange",
      headerPresent: false,
    });
    res.status(401).json({
      error: "Unauthorized",
      message: "Missing Orange Money callback signature header",
    });
    return;
  }

  const timestamp = verifier.extractTimestamp(req);
  if (!verifier.isTimestampFresh(timestamp)) {
    logger.warn(
      { ip, path, provider: "orange", timestamp },
      "SECURITY ALERT: Orange Money callback timestamp stale or invalid",
    );
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path,
      method: req.method,
      ip,
      reason: "orange_webhook_timestamp_stale",
      provider: "orange",
      headerPresent: true,
    });
    res.status(401).json({
      error: "Unauthorized",
      message: "Stale or invalid callback timestamp",
    });
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const payload = rawBody || Buffer.from(JSON.stringify(req.body || {}));

  const isValid = verifier.verify(payload, signature);
  if (!isValid) {
    logger.warn(
      { ip, path, provider: "orange" },
      "SECURITY ALERT: Orange Money callback cryptographic signature verification failed (tampered or forged payload)",
    );
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path,
      method: req.method,
      ip,
      reason: "orange_webhook_signature_invalid",
      provider: "orange",
      headerPresent: true,
    });
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid callback signature",
    });
    return;
  }

  next();
}

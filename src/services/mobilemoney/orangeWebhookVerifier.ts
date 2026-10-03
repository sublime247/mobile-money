import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import logger from "../../utils/logger";
import { getCurrentRequestIp, logSecurityAnomaly } from "../logger";

export interface OrangeVerifierConfig {
  hmacSecret?: string;
  publicKey?: string;
  cert?: string;
  timestampFreshnessSeconds?: number;
  signatureHeader?: string;
  timestampHeader?: string;
}

export class OrangeWebhookVerifier {
  private hmacSecret: string;
  private publicKey: string;
  private cert: string;
  private timestampFreshnessSeconds: number;
  private signatureHeader: string;
  private timestampHeader: string;

  constructor(config?: OrangeVerifierConfig) {
    this.hmacSecret =
      config?.hmacSecret ||
      process.env.ORANGE_MONEY_WEBHOOK_SECRET ||
      process.env.ORANGE_CALLBACK_SECRET ||
      process.env.ORANGE_WEBHOOK_SECRET ||
      "";
    this.publicKey =
      config?.publicKey ||
      process.env.ORANGE_MONEY_PUBLIC_KEY ||
      process.env.ORANGE_PUBLIC_KEY ||
      "";
    this.cert =
      config?.cert ||
      process.env.ORANGE_MONEY_CERT_PEM ||
      process.env.ORANGE_CERT_PEM ||
      "";
    this.timestampFreshnessSeconds =
      config?.timestampFreshnessSeconds ||
      parseInt(process.env.ORANGE_TIMESTAMP_FRESHNESS_SECONDS || "300", 10);
    this.signatureHeader = (
      config?.signatureHeader || "x-orange-signature"
    ).toLowerCase();
    this.timestampHeader = (
      config?.timestampHeader || "x-orange-timestamp"
    ).toLowerCase();
  }

  /**
   * Validates if a timestamp is within the acceptable freshness window to prevent replay attacks.
   */
  public isTimestampFresh(
    timestampHeaderValue?: string | number,
    freshnessSeconds?: number,
  ): boolean {
    if (!timestampHeaderValue) {
      return false;
    }

    const maxSkew = freshnessSeconds ?? this.timestampFreshnessSeconds;
    const tsNumber =
      typeof timestampHeaderValue === "number"
        ? timestampHeaderValue
        : Number(timestampHeaderValue);

    if (!Number.isFinite(tsNumber)) {
      return false;
    }

    // Normalize milliseconds vs seconds
    const tsSeconds = tsNumber > 1e11 ? tsNumber / 1000 : tsNumber;
    const nowSeconds = Date.now() / 1000;
    const skew = Math.abs(nowSeconds - tsSeconds);

    return skew <= maxSkew;
  }

  private getSecret(): string {
    return (
      this.hmacSecret ||
      process.env.ORANGE_MONEY_WEBHOOK_SECRET ||
      process.env.ORANGE_CALLBACK_SECRET ||
      process.env.ORANGE_WEBHOOK_SECRET ||
      ""
    );
  }

  private getPublicKey(): string {
    return (
      this.publicKey ||
      process.env.ORANGE_MONEY_PUBLIC_KEY ||
      process.env.ORANGE_PUBLIC_KEY ||
      ""
    );
  }

  /**
   * Verifies an HMAC-SHA256 signature using timing-safe comparison.
   */
  public verifyHmac(
    payload: string | Buffer,
    signature: string,
    secretOverride?: string,
  ): boolean {
    const secret = secretOverride || this.getSecret();
    if (!secret || !signature) {
      return false;
    }

    const payloadBuffer =
      typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;

    const cleanedSignature = signature.trim().replace(/^sha256=/i, "");

    // Compute HMAC
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payloadBuffer);
    const expectedDigestHex = hmac.digest("hex");

    // Also support base64 digest
    const hmacB64 = crypto.createHmac("sha256", secret);
    hmacB64.update(payloadBuffer);
    const expectedDigestB64 = hmacB64.digest("base64");

    const matchHex =
      expectedDigestHex.length === cleanedSignature.length &&
      crypto.timingSafeEqual(
        Buffer.from(expectedDigestHex, "utf-8"),
        Buffer.from(cleanedSignature, "utf-8"),
      );

    if (matchHex) return true;

    const matchB64 =
      expectedDigestB64.length === cleanedSignature.length &&
      crypto.timingSafeEqual(
        Buffer.from(expectedDigestB64, "utf-8"),
        Buffer.from(cleanedSignature, "utf-8"),
      );

    return matchB64;
  }

  /**
   * Verifies an RSA-SHA256 / X.509 public key signature.
   */
  public verifyPublicKey(
    payload: string | Buffer,
    signature: string,
    keyOrCertOverride?: string,
  ): boolean {
    const key = keyOrCertOverride || this.getPublicKey() || this.cert;
    if (!key || !signature) {
      return false;
    }

    const payloadBuffer =
      typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;

    let signatureBuffer: Buffer;
    const cleaned = signature.trim().replace(/^sha256=/i, "");

    // Try hex first if even length hex string, otherwise base64
    if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
      signatureBuffer = Buffer.from(cleaned, "hex");
    } else {
      signatureBuffer = Buffer.from(cleaned, "base64");
    }

    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(payloadBuffer);
      return verifier.verify(key, signatureBuffer);
    } catch (err) {
      logger.debug(
        "[OrangeWebhookVerifier] RSA verification failed or invalid key format:",
        err,
      );
      return false;
    }
  }

  /**
   * Top-level verifier checking payload signature against either Public Key or HMAC secret.
   */
  public verify(
    payload: string | Buffer,
    signature: string,
    options?: { secret?: string; publicKey?: string; cert?: string },
  ): boolean {
    const key =
      options?.publicKey ||
      options?.cert ||
      this.getPublicKey() ||
      this.cert;
    if (key) {
      const rsaValid = this.verifyPublicKey(payload, signature, key);
      if (rsaValid) return true;
    }

    const secret = options?.secret || this.getSecret();
    if (secret) {
      return this.verifyHmac(payload, signature, secret);
    }

    return false;
  }

  /**
   * Express middleware performing cryptographic signature verification on incoming callbacks.
   */
  public getMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const signatureHeaderValue =
        (req.headers[this.signatureHeader] as string) ||
        (req.headers["x-callback-signature"] as string) ||
        (req.headers["x-orange-signature"] as string);

      if (!signatureHeaderValue) {
        logSecurityAnomaly({
          event: "security.anomaly",
          timestamp: new Date().toISOString(),
          path: req.originalUrl || req.url,
          method: req.method,
          ip: getCurrentRequestIp(req),
          reason: "orange_webhook_signature_missing",
          provider: "orange_money",
          headerPresent: false,
        });
        logger.warn(
          "[OrangeWebhookVerifier] Missing callback signature header",
          {
            path: req.originalUrl,
            ip: getCurrentRequestIp(req),
          },
        );
        res.status(401).json({
          error: "Unauthorized: Missing callback signature header",
        });
        return;
      }

      // Check timestamp if present
      const timestampValue =
        (req.headers[this.timestampHeader] as string) ||
        (req.headers["x-orange-timestamp"] as string) ||
        (req.headers["x-timestamp"] as string);

      if (timestampValue && !this.isTimestampFresh(timestampValue)) {
        logSecurityAnomaly({
          event: "security.anomaly",
          timestamp: new Date().toISOString(),
          path: req.originalUrl || req.url,
          method: req.method,
          ip: getCurrentRequestIp(req),
          reason: "orange_webhook_timestamp_stale",
          provider: "orange_money",
          headerPresent: true,
        });
        logger.warn(
          "[OrangeWebhookVerifier] Stale callback timestamp rejected (replay protection)",
          {
            timestamp: timestampValue,
            path: req.originalUrl,
          },
        );
        res.status(401).json({
          error: "Unauthorized: Callback timestamp outside freshness window",
        });
        return;
      }

      // Extract raw body or serialize JSON body
      const rawBody =
        (req as Request & { rawBody?: Buffer | string }).rawBody ||
        JSON.stringify(req.body);

      const isValid = this.verify(rawBody, signatureHeaderValue);

      if (!isValid) {
        logSecurityAnomaly({
          event: "security.anomaly",
          timestamp: new Date().toISOString(),
          path: req.originalUrl || req.url,
          method: req.method,
          ip: getCurrentRequestIp(req),
          reason: "orange_webhook_signature_invalid",
          provider: "orange_money",
          headerPresent: true,
        });
        logger.warn(
          "[OrangeWebhookVerifier] Tampered or invalid signature verification failed",
          {
            path: req.originalUrl,
            ip: getCurrentRequestIp(req),
          },
        );
        res.status(401).json({
          error: "Unauthorized: Invalid or tampered signature",
        });
        return;
      }

      next();
    };
  }
}

export const orangeWebhookVerifier = new OrangeWebhookVerifier();
export const orangeWebhookVerificationMiddleware =
  orangeWebhookVerifier.getMiddleware();

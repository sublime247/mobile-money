import crypto from "crypto";
import axios from "axios";
import NodeCache from "node-cache";
import logger from "./logger";

export class AirtelSignatureValidator {
  private cache: NodeCache;
  private cacheKey = "airtel_public_keys";
  private fallbackKeys: string[] = [];
  private keysUrl: string;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.keysUrl = process.env.AIRTEL_PUBLIC_KEYS_URL || "";
    // Cache public keys with a TTL of 1 hour (3600 seconds)
    this.cache = new NodeCache({ stdTTL: 3600 });

    // Load fallback keys from environment variables
    const localFallback = process.env.AIRTEL_FALLBACK_PUBLIC_KEY || process.env.AIRTEL_FALLBACK_PUBLIC_KEYS;
    if (localFallback) {
      // Split by delimiter (e.g. double newlines or custom delimiter) if multiple keys are provided
      this.fallbackKeys = localFallback
        .split("---SPLIT---")
        .map(k => k.trim())
        .filter(Boolean);
    }

    // Start background key rotation refresh periodically (e.g. every hour)
    // Only run if not in test environment to avoid open handles in Jest
    if (process.env.NODE_ENV !== "test" && this.keysUrl) {
      this.startBackgroundRotation();
    }
  }

  private startBackgroundRotation() {
    // Refresh every hour
    this.refreshInterval = setInterval(async () => {
      try {
        await this.fetchAndCacheKeys();
      } catch (err: any) {
        logger.error({ error: err.message }, "Airtel Signature Validator: Background key refresh failed");
      }
    }, 3600 * 1000);
  }

  public stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  // Fetch from endpoint and cache
  public async fetchAndCacheKeys(): Promise<string[]> {
    if (!this.keysUrl) {
      logger.warn("Airtel Signature Validator: AIRTEL_PUBLIC_KEYS_URL is not configured. Using fallback keys.");
      return this.fallbackKeys;
    }

    try {
      logger.info({ url: this.keysUrl }, "Airtel Signature Validator: Fetching public keys...");
      const response = await axios.get(this.keysUrl, { timeout: 5000 });
      const data = response.data;
      const keys: string[] = [];

      // Parse different potential formats from Airtel API
      if (Array.isArray(data)) {
        // Simple array of PEM keys
        data.forEach(item => {
          if (typeof item === "string") keys.push(item);
          else if (item.value) keys.push(item.value);
          else if (item.key) keys.push(item.key);
        });
      } else if (data && typeof data === "object") {
        if (Array.isArray(data.keys)) {
          // JWKS or list format
          data.keys.forEach((k: any) => {
            if (k.value) keys.push(k.value);
            else if (k.publicKey) keys.push(k.publicKey);
            else if (k.key) keys.push(k.key);
            else if (typeof k === "string") keys.push(k);
          });
        } else {
          // Key-value object mapping kid to PEM
          Object.values(data).forEach((val: any) => {
            if (typeof val === "string") keys.push(val);
          });
        }
      }

      const parsedKeys = keys.map(k => k.trim()).filter(Boolean);
      if (parsedKeys.length > 0) {
        this.cache.set(this.cacheKey, parsedKeys);
        logger.info({ count: parsedKeys.length }, "Airtel Signature Validator: Successfully fetched and cached public keys");
        return parsedKeys;
      }

      throw new Error("Airtel Signature Validator: No valid keys could be extracted from response");
    } catch (err: any) {
      logger.error({ error: err.message }, "Airtel Signature Validator: Failed to fetch remote keys. Using cached or fallback keys.");
      const cached = this.cache.get<string[]>(this.cacheKey);
      if (cached && cached.length > 0) {
        return cached;
      }
      return this.fallbackKeys;
    }
  }

  // Get active keys (cached or fallback)
  public async getActiveKeys(): Promise<string[]> {
    const cached = this.cache.get<string[]>(this.cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    // Try fetching if cache is empty
    if (this.keysUrl) {
      const fetched = await this.fetchAndCacheKeys();
      if (fetched.length > 0) {
        return fetched;
      }
    }

    // Dynamically resolve local fallback keys from env
    const localFallback = process.env.AIRTEL_FALLBACK_PUBLIC_KEY || process.env.AIRTEL_FALLBACK_PUBLIC_KEYS;
    if (localFallback) {
      return localFallback
        .split("---SPLIT---")
        .map(k => k.trim())
        .filter(Boolean);
    }

    return this.fallbackKeys;
  }

  // Verify signature
  public async verifySignature(payload: string, signature: string): Promise<boolean> {
    const keys = await this.getActiveKeys();
    if (keys.length === 0) {
      logger.error("Airtel Signature Validator: No public keys available for signature verification");
      return false;
    }

    const dataBuffer = Buffer.from(payload);
    let sigBuffer: Buffer;
    try {
      sigBuffer = Buffer.from(signature, "base64");
    } catch {
      logger.warn("Airtel Signature Validator: Signature is not a valid base64 string");
      return false;
    }

    // Try verifying with each key. If any succeeds, return true
    for (const rawKey of keys) {
      try {
        let key = rawKey;
        // Ensure standard PEM format headers
        if (!key.includes("-----BEGIN PUBLIC KEY-----")) {
          key = `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
        }

        const verify = crypto.createVerify("SHA256");
        verify.update(dataBuffer);
        const isValid = verify.verify(key, sigBuffer);
        if (isValid) {
          return true;
        }
      } catch (err: any) {
        logger.debug({ error: err.message }, "Airtel Signature Validator: Key verification failed with error");
      }
    }

    return false;
  }
}

/**
 * Cryptographic (Ed25519) signing for outbound webhook payloads.
 *
 * The platform has always supported HMAC-SHA256 request signing
 * (`X-Webhook-Signature: sha256=<hex>`), but `src/routes/webhooks.ts`'s
 * verifier and the developer docs (`GET /api/webhooks/schema`) already
 * documented an alternate `ed25519=<hex>` scheme that was never actually
 * produced on the sending side. This module implements that signing side,
 * so a deployment can configure an Ed25519 keypair and have every outbound
 * webhook delivery signed asymmetrically instead of (or in addition to)
 * HMAC — receivers can verify authenticity against a published public key
 * without ever holding a shared secret.
 *
 * Signing keys accepted:
 *   - A Stellar secret seed ("S...", 56 chars) — signed/verified via the
 *     same Ed25519 keypair used elsewhere in this Stellar bridge.
 *   - A PEM-encoded Ed25519 private/public key (Node's `crypto` module).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

export const ED25519_SIGNATURE_PREFIX = "ed25519=";

function isStellarSecretSeed(key: string): boolean {
  return key.startsWith("S") && key.length === 56;
}

function isStellarPublicKey(key: string): boolean {
  return key.startsWith("G") && key.length === 56;
}

/**
 * Sign a raw webhook payload with Ed25519.
 *
 * @param signingKey Stellar secret seed ("S...") or PEM-encoded Ed25519 private key.
 * @returns The full header value, e.g. `ed25519=<hex signature>`.
 */
export function signWebhookPayloadEd25519(
  payload: string,
  signingKey: string,
): string {
  const message = Buffer.from(payload, "utf8");
  const signature = isStellarSecretSeed(signingKey)
    ? Keypair.fromSecret(signingKey).sign(message)
    : cryptoSign(null, message, createPrivateKey(signingKey));

  return `${ED25519_SIGNATURE_PREFIX}${signature.toString("hex")}`;
}

/**
 * Verify an Ed25519-signed webhook payload.
 *
 * @param publicKey Stellar public key ("G...") or PEM-encoded Ed25519 public key.
 */
export function verifyWebhookPayloadEd25519(
  payload: string,
  signatureHeader: string,
  publicKey: string,
): boolean {
  if (!signatureHeader.startsWith(ED25519_SIGNATURE_PREFIX)) return false;

  try {
    const message = Buffer.from(payload, "utf8");
    const signature = Buffer.from(
      signatureHeader.slice(ED25519_SIGNATURE_PREFIX.length),
      "hex",
    );

    if (isStellarPublicKey(publicKey)) {
      return Keypair.fromPublicKey(publicKey).verify(message, signature);
    }
    return cryptoVerify(null, message, createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

/**
 * Derive the public key (and a short, stable key ID for rotation/lookup)
 * from a configured signing key, without ever exposing the private key
 * material itself.
 */
export function derivePublicSigningKey(signingKey: string): {
  publicKey: string;
  keyId: string;
} {
  const publicKey = isStellarSecretSeed(signingKey)
    ? Keypair.fromSecret(signingKey).publicKey()
    : createPublicKey(createPrivateKey(signingKey))
        .export({ type: "spki", format: "pem" })
        .toString();

  const keyId = createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .slice(0, 16);

  return { publicKey, keyId };
}

export interface SignedWebhookHeader {
  /** Value for the signature header, e.g. "sha256=..." or "ed25519=...". */
  signature: string;
  scheme: "sha256" | "ed25519";
  /** Present only when scheme === "ed25519" — identifies which public key to verify against. */
  keyId?: string;
}

/**
 * Sign a webhook payload using Ed25519 when `ed25519SigningKey` is
 * configured, otherwise falling back to the caller-supplied HMAC-SHA256
 * signer. Centralizes the "which scheme is active" decision so every
 * outbound webhook dispatcher stays consistent.
 */
export function signWebhookPayload(
  payload: string,
  signHmac: (payload: string) => string,
  ed25519SigningKey?: string,
): SignedWebhookHeader {
  if (ed25519SigningKey) {
    const { keyId } = derivePublicSigningKey(ed25519SigningKey);
    return {
      signature: signWebhookPayloadEd25519(payload, ed25519SigningKey),
      scheme: "ed25519",
      keyId,
    };
  }
  return { signature: signHmac(payload), scheme: "sha256" };
}

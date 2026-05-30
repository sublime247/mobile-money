import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "crypto";

export interface Encrypted {
  iv: string; // hex
  ciphertext: string; // hex
  authTag: string; // hex
}

/** Derive a 32-byte AES key from a password using a single SHA-256.
 * This is intentionally simple for tests/fuzzing. For production use a
 * proper KDF (PBKDF2/Argon2/ HKDF) with salt and iterations.
 */
export function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Encrypt a buffer with AES-256-GCM. Returns hex-encoded fields. */
export function encryptAesGcm(plaintext: Buffer, key: Buffer): Encrypted {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Decrypt AES-256-GCM hex fields. Throws on auth failure. */
export function decryptAesGcm(enc: Encrypted, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = Buffer.from(enc.iv, "hex");
  const ciphertext = Buffer.from(enc.ciphertext, "hex");
  const authTag = Buffer.from(enc.authTag, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

export default {
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
};

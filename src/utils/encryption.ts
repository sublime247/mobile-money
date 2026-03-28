import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || "default_encryption_key_32_bytes_";
const DETERMINISTIC_IV = Buffer.from("fixed_iv_12_b", "utf8").slice(0, 12);

/**
 * Encrypts a string using AES-256-GCM.
 * The output format is: iv:authTag:encryptedContent (all hex)
 */
export function encrypt(text: string | null | undefined, deterministic = false): string | null | undefined {
  if (text === null || text === undefined || text === "") return text;
  
  const secretKey = crypto.scryptSync(ENCRYPTION_KEY, "salt", 32);
  const iv = deterministic ? DETERMINISTIC_IV : crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag().toString("hex");
  
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a string using AES-256-GCM.
 * Expects the format: iv:authTag:encryptedContent (all hex)
 */
export function decrypt(encryptedData: string | null | undefined): string | null | undefined {
  if (encryptedData === null || encryptedData === undefined || encryptedData === "" || !encryptedData.includes(":")) return encryptedData;

  const parts = encryptedData.split(":");
  if (parts.length !== 3) return encryptedData;

  const [ivHex, authTagHex, encryptedText] = parts;
  
  const secretKey = crypto.scryptSync(ENCRYPTION_KEY, "salt", 32);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, secretKey, iv);
  
  decipher.setAuthTag(authTag);
  
  try {
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.warn("Decryption failed, returning plain text if possible.");
    return encryptedData;
  }
}



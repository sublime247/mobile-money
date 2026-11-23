import crypto from "crypto";
import {
  decryptSecret,
  encryptSecret,
  EnvelopeEncryptedSecret,
  getSecretsKeyring,
  getSecretsMasterKey,
  parseMasterKey,
  SecretsMasterKey,
} from "../encryption";

const CONTEXT = "provider_credentials:mtn:api_key";
const SECRET = "SBXQ4ZJ7EXAMPLESTELLARSECRETKEYDONOTUSE00000000000000000";

function masterKey(version = "v1"): SecretsMasterKey {
  return { version, key: crypto.randomBytes(32) };
}

function keyringOf(...keys: SecretsMasterKey[]): Map<string, Buffer> {
  return new Map(keys.map((k) => [k.version, k.key]));
}

function flipFirstByte(buf: Buffer): Buffer {
  const copy = Buffer.from(buf);
  copy[0] ^= 0x01;
  return copy;
}

describe("provider secret envelope encryption", () => {
  const kek = masterKey();

  it("round-trips a secret", () => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);
    expect(decryptSecret(enc, CONTEXT, keyringOf(kek))).toBe(SECRET);
  });

  it("stores ciphertext, a 12-byte IV and a 16-byte tag, never the plaintext", () => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);

    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.dekIv).toHaveLength(12);
    expect(enc.dekAuthTag).toHaveLength(16);
    expect(enc.encryptedDek).toHaveLength(32);
    expect(enc.keyVersion).toBe("v1");
    expect(enc.ciphertext.toString("utf8")).not.toContain(SECRET);
  });

  it("uses a unique IV and data key per record", () => {
    const a = encryptSecret(SECRET, CONTEXT, kek);
    const b = encryptSecret(SECRET, CONTEXT, kek);

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.dekIv.equals(b.dekIv)).toBe(false);
    expect(a.encryptedDek.equals(b.encryptedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("cannot be decrypted with an incorrect master key", () => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);
    const wrong = { version: "v1", key: crypto.randomBytes(32) };

    expect(() => decryptSecret(enc, CONTEXT, keyringOf(wrong))).toThrow(
      "Provider secret decryption failed: wrong master key or tampered data",
    );
  });

  it.each<keyof EnvelopeEncryptedSecret>([
    "authTag",
    "ciphertext",
    "iv",
    "encryptedDek",
    "dekIv",
    "dekAuthTag",
  ])("rejects a tampered %s", (field) => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);
    const tampered = {
      ...enc,
      [field]: flipFirstByte(enc[field] as Buffer),
    };

    expect(() => decryptSecret(tampered, CONTEXT, keyringOf(kek))).toThrow(
      "Provider secret decryption failed",
    );
  });

  it("rejects a truncated auth tag", () => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);
    const truncated = { ...enc, authTag: enc.authTag.subarray(0, 8) };

    expect(() => decryptSecret(truncated, CONTEXT, keyringOf(kek))).toThrow(
      "Provider secret decryption failed",
    );
  });

  it("rejects a ciphertext moved to a different record", () => {
    const enc = encryptSecret(SECRET, CONTEXT, kek);

    expect(() =>
      decryptSecret(enc, "provider_credentials:airtel:api_key", keyringOf(kek)),
    ).toThrow("Provider secret decryption failed");
  });

  it("rejects a relabelled key version", () => {
    const old = masterKey("v1");
    const current = masterKey("v2");
    const enc = encryptSecret(SECRET, CONTEXT, old);

    // Pointing the record at a key it was not wrapped with must fail.
    expect(() =>
      decryptSecret(
        { ...enc, keyVersion: "v2" },
        CONTEXT,
        keyringOf(old, current),
      ),
    ).toThrow("Provider secret decryption failed");
  });

  it("decrypts records wrapped by a retired key that is still in the keyring", () => {
    const old = masterKey("v1");
    const current = masterKey("v2");
    const enc = encryptSecret(SECRET, CONTEXT, old);

    expect(decryptSecret(enc, CONTEXT, keyringOf(old, current))).toBe(SECRET);
  });

  it("reports a missing key version without attempting decryption", () => {
    const enc = encryptSecret(SECRET, CONTEXT, masterKey("v0"));

    expect(() => decryptSecret(enc, CONTEXT, keyringOf(kek))).toThrow(
      'No provider secrets master key configured for version "v0"',
    );
  });
});

describe("master key configuration", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("parses hex and base64 32-byte keys", () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(raw.toString("hex"), "K").equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString("base64"), "K").equals(raw)).toBe(true);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseMasterKey("too-short", "K")).toThrow(
      "K must be a 32-byte key",
    );
    expect(() =>
      parseMasterKey(crypto.randomBytes(16).toString("hex"), "K"),
    ).toThrow("K must be a 32-byte key");
  });

  it("requires PROVIDER_SECRETS_MASTER_KEY", () => {
    delete process.env.PROVIDER_SECRETS_MASTER_KEY;
    expect(() => getSecretsMasterKey()).toThrow(
      "PROVIDER_SECRETS_MASTER_KEY is not set",
    );
  });

  it("encrypts and decrypts with the environment keyring by default", () => {
    const retired = crypto.randomBytes(32).toString("hex");
    process.env.PROVIDER_SECRETS_MASTER_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    process.env.PROVIDER_SECRETS_MASTER_KEY_VERSION = "v2";
    process.env.PROVIDER_SECRETS_PREVIOUS_KEYS = JSON.stringify({
      v1: retired,
    });

    const enc = encryptSecret(SECRET, CONTEXT);

    expect(enc.keyVersion).toBe("v2");
    expect(decryptSecret(enc, CONTEXT)).toBe(SECRET);
    expect([...getSecretsKeyring().keys()].sort()).toEqual(["v1", "v2"]);
  });
});

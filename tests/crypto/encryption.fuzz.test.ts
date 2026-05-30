import fc from "fast-check";
import {
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
} from "../../src/crypto/encryption";

describe("encryption fuzz tests (fast-check)", () => {
  test("roundtrip: decrypt(encrypt(p, key)) === p", () => {
    fc.assert(
      fc.property(fc.uint8Array(), fc.string({ maxLength: 32 }), (arr, pwd) => {
        const plain = Buffer.from(arr);
        const key = deriveKey(pwd);
        const enc = encryptAesGcm(plain, key);
        const out = decryptAesGcm(enc, key);
        expect(out.equals(plain)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("tampered ciphertext or tag fails to decrypt", () => {
    fc.assert(
      fc.property(fc.uint8Array(), fc.string({ maxLength: 32 }), (arr, pwd) => {
        const plain = Buffer.from(arr);
        const key = deriveKey(pwd);
        const enc = encryptAesGcm(plain, key);

        // mutate ciphertext
        const badEnc1 = { ...enc, ciphertext: flipHex(enc.ciphertext) };
        expect(() => decryptAesGcm(badEnc1, key)).toThrow();

        // mutate auth tag
        const badEnc2 = { ...enc, authTag: flipHex(enc.authTag) };
        expect(() => decryptAesGcm(badEnc2, key)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  test("wrong key fails to decrypt", () => {
    fc.assert(
      fc.property(
        fc.uint8Array(),
        fc.string({ maxLength: 32 }),
        fc.string({ maxLength: 32 }),
        (arr, pwd, wrong) => {
          // ensure wrong key is different
          fc.pre(pwd !== wrong);
          const plain = Buffer.from(arr);
          const key = deriveKey(pwd);
          const keyWrong = deriveKey(wrong);
          const enc = encryptAesGcm(plain, key);
          expect(() => decryptAesGcm(enc, keyWrong)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});

function flipHex(hex: string): string {
  if (!hex || hex.length < 2) return hex;
  // flip the first byte by xoring 0xff
  const buf = Buffer.from(hex, "hex");
  buf[0] = buf[0] ^ 0xff;
  return buf.toString("hex");
}

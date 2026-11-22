import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  KeyObject,
} from "crypto";
import { Transform } from "stream";

export interface ReportSignatureMetadata {
  sha256: string;
  signature: string;
  algorithm: "RSA-SHA256";
}

function normalizeKey(key: string): string {
  return key.replace(/\\n/g, "\n");
}

function assertRsaKey(key: KeyObject): void {
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("Report signing requires an RSA key");
  }
}

export function createReportSigningTransform(privateKey: string): {
  stream: Transform;
  finalize: () => ReportSignatureMetadata;
} {
  const key = createPrivateKey(normalizeKey(privateKey));
  assertRsaKey(key);
  const digest = createHash("sha256");
  const signer = createSign("RSA-SHA256");
  let finalized = false;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      signer.update(chunk);
      callback(null, chunk);
    },
  });

  return {
    stream,
    finalize() {
      if (finalized) throw new Error("Report signature already finalized");
      finalized = true;
      return {
        sha256: digest.digest("hex"),
        signature: signer.sign(key, "base64"),
        algorithm: "RSA-SHA256",
      };
    },
  };
}

export function signReport(
  content: Buffer | string,
  privateKey: string,
): ReportSignatureMetadata {
  const key = createPrivateKey(normalizeKey(privateKey));
  assertRsaKey(key);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const signer = createSign("RSA-SHA256");
  signer.update(bytes);
  signer.end();

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: signer.sign(key, "base64"),
    algorithm: "RSA-SHA256",
  };
}

export function verifyReport(
  content: Buffer | string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const key = createPublicKey(normalizeKey(publicKey));
    assertRsaKey(key);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(content);
    verifier.end();
    return verifier.verify(key, signature.trim(), "base64");
  } catch {
    return false;
  }
}

export function sha256Report(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

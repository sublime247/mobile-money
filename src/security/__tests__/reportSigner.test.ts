import { createHash, generateKeyPairSync } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  createReportSigningTransform,
  signReport,
  verifyReport,
} from "../reportSigner";

describe("report signing", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  it("signs report bytes and verifies the detached signature", () => {
    const report = Buffer.from("settlement,total\n2026-10-19,12.50\n");
    const signed = signReport(report, privateKey);

    expect(signed.algorithm).toBe("RSA-SHA256");
    expect(signed.sha256).toBe(
      createHash("sha256").update(report).digest("hex"),
    );
    expect(verifyReport(report, signed.signature, publicKey)).toBe(true);
  });

  it("rejects modified report content", () => {
    const signed = signReport(
      "settlement,total\n2026-10-19,12.50\n",
      privateKey,
    );

    expect(
      verifyReport(
        "settlement,total\n2026-10-19,99.99\n",
        signed.signature,
        publicKey,
      ),
    ).toBe(false);
  });

  it("signs the exact bytes emitted by the streaming transform", async () => {
    const chunks: Buffer[] = [];
    const report = Buffer.from("streamed settlement report");
    const signing = createReportSigningTransform(privateKey);
    signing.stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    await pipeline(Readable.from([report]), signing.stream);
    const metadata = signing.finalize();
    const emittedReport = Buffer.concat(chunks);

    expect(metadata.sha256).toBe(
      createHash("sha256").update(emittedReport).digest("hex"),
    );
    expect(verifyReport(emittedReport, metadata.signature, publicKey)).toBe(
      true,
    );
  });
});

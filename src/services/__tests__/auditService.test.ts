const mockQuery = jest.fn();
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockCount = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../../models/auditLog", () => ({
  AuditLogModel: jest.fn().mockImplementation(() => ({
    list: (...args: unknown[]) => mockList(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    count: (...args: unknown[]) => mockCount(...args),
  })),
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import crypto from "crypto";
import { AuditService } from "../auditService";

describe("AuditService export", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds a zip archive with manifest and SHA-256 checksums", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "tx1", amount: "10", status: "completed" }] })
      .mockResolvedValueOnce({ rows: [{ id: "al1", action: "TEST" }] })
      .mockResolvedValueOnce({ rows: [{ id: "kyc1", document_type: "PASSPORT" }] });

    const svc = new AuditService();
    const { archive, manifest, manifestSignature } = await svc.buildAuditExportArchive({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z"),
      signingKey: "test-key",
    });

    expect(manifest.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["ledger/transactions.csv", "audit/audit_logs.csv", "kyc/documents.csv"]),
    );
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifestSignature).toBeTruthy();

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      archive.on("data", (c) => chunks.push(Buffer.from(c)));
      archive.on("end", resolve);
      archive.on("error", reject);
    });
    const buf = Buffer.concat(chunks);
    expect(buf.subarray(0, 2).toString("utf8")).toBe("PK");
  });

  it("signManifest falls back to hmac when key is not a private key", () => {
    const sig = AuditService.signManifest('{"ok":true}', "secret");
    expect(sig.startsWith("hmac-sha256:")).toBe(true);
  });
});

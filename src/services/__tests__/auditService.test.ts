import { generateKeyPairSync, createHash } from "crypto";
import { inflateRawSync } from "zlib";
import { AuditService } from "../auditService";
import { pool } from "../../config/database";
import { getS3Client } from "../../config/s3";
import { verifyReport } from "../../security/reportSigner";
import { createAuditManifest } from "../../utils/auditManifest";

jest.mock("../../config/database", () => ({ pool: { connect: jest.fn() } }));
jest.mock("../../config/s3", () => ({
  getS3Client: jest.fn(),
  s3Config: { bucket: "private-kyc" },
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

// Read the ZIP central directory and inflate actual archive entries independently.
function unzip(zip: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const end = zip.length - 22;
  let offset = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
    const dataOffset =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataOffset, dataOffset + size);
    result.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

describe("signed regulator audit exports", () => {
  const start = "2026-01-01T00:00:00Z";
  const end = "2026-02-01T00:00:00Z";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const previousKey = process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY;
  let query: jest.Mock;
  let release: jest.Mock;
  let send: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY = keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    query = jest.fn().mockResolvedValue({ rows: [] });
    release = jest.fn();
    (pool.connect as jest.Mock).mockResolvedValue({ query, release });
    send = jest
      .fn()
      .mockResolvedValue({
        Body: {
          transformToByteArray: async () => Buffer.from("identity evidence"),
        },
      });
    (getS3Client as jest.Mock).mockReturnValue({ send });
  });
  afterAll(() => {
    if (previousKey === undefined)
      delete process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY;
    else process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY = previousKey;
  });

  it("exports ledger and attachments with independently verifiable hashes and signature", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "tx-1",
            user_id: "user-1",
            reference_number: "=SUM(1,2)",
            amount: "10.00",
            created_at: new Date(start),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "doc-1", s3_key: "kyc/user-1/front" }],
      });
    const files = unzip(await new AuditService().buildAuditArchive(start, end));
    expect([...files.keys()].sort()).toEqual([
      "documents.csv",
      "documents/doc-1",
      "ledger.csv",
      "manifest.sha256",
      "manifest.sig",
      "range.json",
    ]);
    expect(files.get("documents/doc-1")!.toString()).toBe("identity evidence");
    expect(files.get("ledger.csv")!.toString()).toContain('"\'=SUM(1,2)"');
    const manifest = files.get("manifest.sha256")!;
    const signature = files.get("manifest.sig")!.toString();
    expect(verifyReport(manifest, signature, publicKey)).toBe(true);
    expect(
      verifyReport(
        Buffer.concat([manifest, Buffer.from("tampered")]),
        signature,
        publicKey,
      ),
    ).toBe(false);
    const lines = manifest.toString().trim().split("\n");
    expect(lines).toHaveLength(files.size - 2);
    for (const line of lines) {
      const [digest, name] = line.split("  ");
      expect(digest).toBe(
        createHash("sha256").update(files.get(name)!).digest("hex"),
      );
    }
    expect(query.mock.calls[1][1]).toEqual([start, end]);
    expect(query.mock.calls[1][0]).toContain(
      "created_at >= $1 AND created_at < $2",
    );
    expect(query.mock.calls[2][0]).toContain("t.user_id = d.user_id");
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "private-kyc",
      Key: "kyc/user-1/front",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("exports a signed header-only ledger for an empty interval", async () => {
    const files = unzip(await new AuditService().buildAuditArchive(start, end));
    expect(
      files.get("ledger.csv")!.toString().trim().split("\r\n"),
    ).toHaveLength(1);
    expect(
      verifyReport(
        files.get("manifest.sha256")!,
        files.get("manifest.sig")!.toString(),
        publicKey,
      ),
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [end, start],
    [start, start],
    ["invalid", end],
    ["2026-02-30T00:00:00Z", end],
    [undefined, end],
  ])("rejects invalid ranges before querying", async (a, b) => {
    await expect(
      new AuditService().buildAuditArchive(a as string, b),
    ).rejects.toThrow("start and end");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("fails closed without the compliance signing key", async () => {
    delete process.env.ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY;
    await expect(
      new AuditService().buildAuditArchive(start, end),
    ).rejects.toThrow("not configured");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rolls back and releases the database connection on query failure", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      new AuditService().buildAuditArchive(start, end),
    ).rejects.toThrow("database unavailable");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not produce a partial package if a document is unavailable", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "doc-1", s3_key: "missing" }] });
    send.mockRejectedValueOnce(new Error("NoSuchKey"));
    await expect(
      new AuditService().buildAuditArchive(start, end),
    ).rejects.toThrow("NoSuchKey");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects path traversal in manifest filenames", () => {
    expect(() =>
      createAuditManifest(new Map([["../secret", Buffer.from("x")]])),
    ).toThrow("Unsafe");
  });
});

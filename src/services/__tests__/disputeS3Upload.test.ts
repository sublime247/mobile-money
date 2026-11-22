/** @jest-environment node */
import { jest } from "@jest/globals";

describe("disputeS3Upload multi-region failover (#2482)", () => {
  let mockSend: jest.Mock;
  let disputeEvidenceExistsInS3: any;
  let getDisputeEvidenceObjectUrl: any;

  beforeAll(async () => {
    mockSend = jest.fn();
    class MockHeadObjectCommand { input: any; constructor(input: any) { this.input = input; } }
    class MockGetObjectCommand { input: any; constructor(input: any) { this.input = input; } }
    class MockPutObjectCommand { input: any; constructor(input: any) { this.input = input; } }

    jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
      S3Client: jest.fn(),
      GetObjectCommand: MockGetObjectCommand,
      HeadObjectCommand: MockHeadObjectCommand,
      PutObjectCommand: MockPutObjectCommand,
    }));
    jest.unstable_mockModule("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }));
    jest.unstable_mockModule("../../utils/logger", () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));

    ({ disputeEvidenceExistsInS3, getDisputeEvidenceObjectUrl } = await import("../disputeS3Upload"));
  });

  beforeEach(() => mockSend.mockReset());

  const targets = () => [
    { bucket: "kyc-primary", region: "eu-west-1", client: { send: (cmd: any) => mockSend({ cmd, bucket: "kyc-primary" }) }, isReplica: false },
    { bucket: "kyc-replica", region: "af-south-1", client: { send: (cmd: any) => mockSend({ cmd, bucket: "kyc-replica" }) }, isReplica: true },
  ];

  it("falls back to replica bucket when primary head/read fails", async () => {
    mockSend.mockImplementationOnce(async () => { throw new Error("primary outage"); }).mockImplementationOnce(async () => ({}));

    const exists = await disputeEvidenceExistsInS3("disputes/a/file.pdf", targets() as any);
    expect(exists).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].bucket).toBe("kyc-primary");
    expect(mockSend.mock.calls[1][0].bucket).toBe("kyc-replica");
  });

  it("returns replica object URL when primary is unavailable", async () => {
    mockSend.mockImplementationOnce(async () => { throw new Error("primary outage"); }).mockImplementationOnce(async () => ({}));

    const url = await getDisputeEvidenceObjectUrl("disputes/a/file.pdf", targets() as any);
    expect(url).toBe("https://kyc-replica.s3.af-south-1.amazonaws.com/disputes/a/file.pdf");
  });

  it("returns false when both primary and replica are unavailable", async () => {
    mockSend.mockImplementationOnce(async () => { throw new Error("primary outage"); }).mockImplementationOnce(async () => { throw new Error("replica outage"); });

    await expect(disputeEvidenceExistsInS3("disputes/a/file.pdf", targets() as any)).resolves.toBe(false);
  });
});

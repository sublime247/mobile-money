import { MobileMoneyService } from "../../../src/services/mobilemoney/mobileMoneyService";

describe("MobileMoneyService Sandbox Mode", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("hard-blocks external providers when IS_SANDBOX is true", async () => {
    process.env.IS_SANDBOX = "true";
    const service = new MobileMoneyService();

    await expect(
      service.initiatePayment("mtn", "+237670000000", "100"),
    ).rejects.toThrow(
      "SANDBOX_SECURITY_FAULT: External provider 'mtn' is hard-blocked in Sandbox mode.",
    );

    await expect(
      service.sendPayout("orange", "+237690000000", "500"),
    ).rejects.toThrow(
      "SANDBOX_SECURITY_FAULT: External provider 'orange' is hard-blocked in Sandbox mode.",
    );
  });

  it("auto-approves mock provider transactions when IS_SANDBOX is true", async () => {
    process.env.IS_SANDBOX = "true";
    const service = new MobileMoneyService();

    const result = await service.initiatePayment(
      "mock",
      "+237670000000",
      "1000",
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      status: "SUCCESSFUL",
      isSandboxAutoApproved: true,
    });
    expect(result.data.transactionId).toMatch(/^sandbox-auto-/);
  });

  it("allows external providers when IS_SANDBOX is false", async () => {
    process.env.IS_SANDBOX = "false";

    // We'll use a fake provider map to avoid actual API calls during this test
    const mockMtn = {
      requestPayment: jest
        .fn()
        .mockResolvedValue({ success: true, data: { status: "PENDING" } }),
      sendPayout: jest
        .fn()
        .mockResolvedValue({ success: true, data: { status: "SUCCESSFUL" } }),
      getTransactionStatus: jest
        .fn()
        .mockResolvedValue({ status: "completed" }),
    };

    const providers = new Map([["mtn", mockMtn]]);
    const service = new MobileMoneyService(providers as any);

    const result = await service.initiatePayment("mtn", "+237670000000", "100");

    expect(result.success).toBe(true);
    expect(mockMtn.requestPayment).toHaveBeenCalled();
  });
});

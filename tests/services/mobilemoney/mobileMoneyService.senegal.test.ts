import {
  isValidSenegalPhoneNumber,
  MobileMoneyService,
} from "../../../src/services/mobilemoney/mobileMoneyService";

class FakeProvider {
  requestPayment = jest.fn(async () => ({
    success: true,
    data: { reference: "payment-ok" },
  }));

  sendPayout = jest.fn(async () => ({
    success: true,
    data: { reference: "payout-ok" },
  }));

  sendBatchPayout = jest.fn(async () => ({
    success: true,
    results: [],
  }));
}

describe("MobileMoneyService Senegal phone validation", () => {
  it("accepts Senegal phone numbers in +221 plus 9 digit format", async () => {
    const provider = new FakeProvider();
    const service = new MobileMoneyService(
      new Map([["orange", provider]]) as any,
    );

    await expect(
      service.initiatePayment("orange", "+221771234567", "1000"),
    ).resolves.toEqual({
      success: true,
      data: { reference: "payment-ok" },
      providerResponseTimeMs: undefined,
    });
    expect(provider.requestPayment).toHaveBeenCalledWith(
      "+221771234567",
      "1000",
    );
  });

  it("rejects Senegal phone numbers that do not start with +221", async () => {
    const provider = new FakeProvider();
    const service = new MobileMoneyService(
      new Map([["orange", provider]]) as any,
    );

    await expect(
      service.initiatePayment("orange", "221771234567", "1000"),
    ).rejects.toThrow(
      "Invalid Senegal phone number format. Use +221 followed by 9 digits.",
    );
    expect(provider.requestPayment).not.toHaveBeenCalled();
  });

  it("rejects Senegal phone numbers with invalid lengths", async () => {
    const provider = new FakeProvider();
    const service = new MobileMoneyService(
      new Map([["orange", provider]]) as any,
    );

    await expect(
      service.sendPayout("orange", "+22177123456", "1000"),
    ).rejects.toThrow(
      "Invalid Senegal phone number format. Use +221 followed by 9 digits.",
    );
    expect(provider.sendPayout).not.toHaveBeenCalled();
  });

  it("does not block non-Senegal phone numbers", async () => {
    const provider = new FakeProvider();
    const service = new MobileMoneyService(new Map([["mtn", provider]]) as any);

    await service.initiatePayment("mtn", "+237670000000", "1000");

    expect(provider.requestPayment).toHaveBeenCalledWith(
      "+237670000000",
      "1000",
    );
  });

  it("exposes the Senegal regex as a focused helper", () => {
    expect(isValidSenegalPhoneNumber("+221771234567")).toBe(true);
    expect(isValidSenegalPhoneNumber("221771234567")).toBe(false);
    expect(isValidSenegalPhoneNumber("+22177123456")).toBe(false);
  });
});

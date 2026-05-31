/**
 * Twilio client is mocked; asserts messages.create is invoked when SMS is enabled.
 */
const mockCreate = jest
  .fn()
  .mockResolvedValue({ sid: "SM_integration_test", status: "queued" });

jest.mock("twilio", () =>
  jest.fn(() => ({
    messages: { create: mockCreate },
  })),
);

import { SmsService } from "../../src/services/sms";

describe("SmsService Twilio integration (mocked SDK)", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    mockCreate.mockClear();
    process.env.NODE_ENV = "development";
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC_integration_test";
    process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
    process.env.TWILIO_PHONE_NUMBER = "+15005550006";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("sends an SMS via Twilio when configured", async () => {
    const svc = new SmsService();
    expect(svc.shouldSend()).toBe(true);

    const result = await svc.sendToPhone(
      "+14155552671",
      "integration test body",
    );

    expect(result.sent).toBe(true);
    expect(result.messageSid).toBe("SM_integration_test");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+14155552671",
        from: "+15005550006",
        body: "integration test body",
      }),
    );
  });
});

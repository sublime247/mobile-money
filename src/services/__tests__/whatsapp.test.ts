import { WhatsappService } from "../whatsapp";
import { SmsService } from "../sms";

// Mock Twilio
jest.mock("twilio", () => {
  return jest.fn().mockReturnValue({
    messages: {
      create: jest.fn(),
    },
  });
});

// Mock only SmsService, not the whole module
jest.mock("../sms", () => {
  const actual = jest.requireActual("../sms");
  return {
    ...actual,
    SmsService: jest.fn().mockImplementation(() => ({
      sendToPhone: jest.fn(),
      notifyTransactionEvent: jest.fn(),
    })),
  };
});

describe("WhatsappService", () => {
  let whatsappService: WhatsappService;
  let mockSmsService: jest.Mocked<SmsService>;
  let mockTwilioClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "testtoken";
    process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+1234567890";

    mockSmsService = new SmsService() as jest.Mocked<SmsService>;
    whatsappService = new WhatsappService(mockSmsService);
    mockTwilioClient = (whatsappService as any).client;
  });

  it("should send a WhatsApp message when enabled", async () => {
    mockTwilioClient.messages.create.mockResolvedValue({ sid: "SM123" });

    const result = await whatsappService.sendWithFallback(
      "+237670000000",
      "Hello Test",
    );

    expect(mockTwilioClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "whatsapp:+237670000000",
        body: "Hello Test",
      }),
    );
    expect(result).toEqual({
      sent: true,
      provider: "whatsapp",
      messageSid: "SM123",
    });
    expect(mockSmsService.notifyTransactionEvent).not.toHaveBeenCalled();
  });

  it("should fallback to SMS when WhatsApp fails", async () => {
    mockTwilioClient.messages.create.mockRejectedValue(
      new Error("WhatsApp Failed"),
    );
    mockSmsService.sendToPhone.mockResolvedValue({
      sent: true,
      messageSid: "SMS123",
    });

    const result = await whatsappService.sendWithFallback(
      "+237670000000",
      "Hello Fallback",
    );

    expect(mockTwilioClient.messages.create).toHaveBeenCalled();
    expect(mockSmsService.sendToPhone).toHaveBeenCalledWith(
      "+237670000000",
      "Hello Fallback",
    );
    expect(result).toEqual({
      sent: true,
      provider: "sms",
      messageSid: "SMS123",
    });
  });

  it("should fallback to SMS directly when WhatsApp is disabled", async () => {
    process.env.WHATSAPP_ENABLED = "false";
    mockSmsService.sendToPhone.mockResolvedValue({
      sent: true,
      messageSid: "SMS123",
    });

    const result = await whatsappService.sendWithFallback(
      "+237670000000",
      "SMS Only",
    );

    expect(mockTwilioClient.messages.create).not.toHaveBeenCalled();
    expect(mockSmsService.sendToPhone).toHaveBeenCalled();
    expect(result).toEqual({
      sent: true,
      provider: "sms",
      messageSid: "SMS123",
    });
  });
});

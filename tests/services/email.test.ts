import { EmailService } from "../../src/services/email";
import sgMail from "@sendgrid/mail";

jest.mock("@sendgrid/mail");

describe("EmailService", () => {
  let emailService: EmailService;
  let mockSendMail: jest.Mock;

  beforeEach(() => {
    mockSendMail = jest.fn().mockResolvedValue([{ statusCode: 202 }]);
    (sgMail.send as jest.Mock) = mockSendMail;

    // Reset env
    process.env.NODE_ENV = "development";
    process.env.SENDGRID_RECEIPT_TEMPLATE_ID = "receipt-template-id";
    process.env.SENDGRID_FAILURE_TEMPLATE_ID = "failure-template-id";

    emailService = new EmailService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should send a transaction receipt email", async () => {
    const mockTransaction = {
      id: "tx-123",
      referenceNumber: "REF-123",
      type: "deposit",
      amount: "100.00",
      phoneNumber: "+237670000000",
      provider: "mtn",
      stellarAddress: "GABC...",
      status: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    await emailService.sendTransactionReceipt(
      "user@example.com",
      mockTransaction
    );

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        templateId: "receipt-template-id",
        dynamicTemplateData: expect.objectContaining({
          amount: "100.00",
          referenceNumber: "REF-123",
        }),
      })
    );
  });

  it("should send a transaction failure email", async () => {
    const mockTransaction = {
      id: "tx-456",
      referenceNumber: "REF-456",
      type: "withdraw",
      amount: "50.00",
      phoneNumber: "+237670000001",
      provider: "orange",
      stellarAddress: "GDEF...",
      status: "failed",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    await emailService.sendTransactionFailure(
      "user@example.com",
      mockTransaction,
      "Insufficient funds"
    );

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        templateId: "failure-template-id",
        dynamicTemplateData: expect.objectContaining({
          referenceNumber: "REF-456",
          reason: "Insufficient funds",
        }),
      })
    );
  });

  it("should skip email sending in test environment", async () => {
    process.env.NODE_ENV = "test";

    await emailService.sendEmail({
      to: "test@test.com",
      templateId: "test-template",
      dynamicTemplateData: {},
    });

    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
import { NotificationRouter, NotificationSeverity } from "../notificationRouter";
import { UserModel } from "../../models/users";
import { Transaction } from "../../models/transaction";

jest.mock("../email", () => {
  const mockEmailService = {
    sendEmail: jest.fn(),
    sendTransactionReceipt: jest.fn(),
    sendTransactionFailure: jest.fn(),
  };
  (global as any).mockEmailService = mockEmailService;
  return {
    emailService: mockEmailService,
  };
});

jest.mock("../sms", () => {
  const mockSmsService = {
    notifyTransactionEvent: jest.fn(),
  };
  (global as any).mockSmsService = mockSmsService;
  return {
    smsService: mockSmsService,
  };
});

jest.mock("../push", () => {
  const mockPushService = {
    sendToUser: jest.fn(),
    sendTransactionComplete: jest.fn(),
    sendTransactionFailed: jest.fn(),
  };
  (global as any).mockPushService = mockPushService;
  return {
    pushNotificationService: mockPushService,
  };
});

jest.mock("../whatsapp", () => {
  const mockWhatsappService = {
    notifyTransactionEvent: jest.fn(),
  };
  (global as any).mockWhatsappService = mockWhatsappService;
  return {
    whatsappService: mockWhatsappService,
  };
});

jest.mock("../pagerDutyService", () => {
  const mockPagerDutyService = {};
  (global as any).mockPagerDutyService = mockPagerDutyService;
  return {
    pagerDutyService: mockPagerDutyService,
  };
});

const mockEmailService = (global as any).mockEmailService;
const mockSmsService = (global as any).mockSmsService;
const mockPushService = (global as any).mockPushService;
const mockWhatsappService = (global as any).mockWhatsappService;
const mockPagerDutyService = (global as any).mockPagerDutyService;


describe("NotificationRouter", () => {
  let notificationRouter: NotificationRouter;
  let mockUserModel: jest.Mocked<UserModel>;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Mock UserModel
    mockUserModel = {
      findById: jest.fn(),
    } as any;

    notificationRouter = new NotificationRouter(mockUserModel);
  });

  describe("routeNotification", () => {
    it("should route low severity notifications to push channel only", async () => {
      const context = {
        severity: "low" as NotificationSeverity,
        category: "test",
        title: "Test Notification",
        message: "Test message",
      };

      await notificationRouter.routeNotification(context);

      // Verify push service was called
      expect(mockPushService.sendToUser).toHaveBeenCalled();
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
      expect(mockSmsService.notifyTransactionEvent).not.toHaveBeenCalled();
    });
  });
});
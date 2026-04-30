import { NotificationRouter, NotificationSeverity } from "../notificationRouter";
import { UserModel } from "../../models/users";
import { Transaction } from "../../models/transaction";

// Mock the individual services
const mockEmailService = {
  sendEmail: jest.fn(),
  sendTransactionReceipt: jest.fn(),
  sendTransactionFailure: jest.fn(),
};

const mockSmsService = {
  notifyTransactionEvent: jest.fn(),
};

const mockPushService = {
  sendToUser: jest.fn(),
  sendTransactionComplete: jest.fn(),
  sendTransactionFailed: jest.fn(),
};

const mockWhatsappService = {
  notifyTransactionEvent: jest.fn(),
};

const mockPagerDutyService = {
  // Mock PagerDuty methods as needed
};

jest.mock("../email", () => ({
  emailService: mockEmailService,
}));

jest.mock("../sms", () => ({
  smsService: mockSmsService,
}));

jest.mock("../push", () => ({
  pushNotificationService: mockPushService,
}));

jest.mock("../whatsapp", () => ({
  whatsappService: mockWhatsappService,
}));

jest.mock("../pagerDutyService", () => ({
  pagerDutyService: mockPagerDutyService,
}));

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
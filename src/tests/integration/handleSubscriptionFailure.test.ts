const mockFindById = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('../../models/subscription');
jest.mock('../../services/notificationRouter');
jest.mock('../../config/database');

jest.mock('../../models/users', () => {
  return {
    UserModel: jest.fn().mockImplementation(() => {
      return {
        findById: mockFindById,
      };
    }),
  };
});

jest.mock('../../services/email', () => {
  return {
    EmailService: jest.fn().mockImplementation(() => {
      return {
        sendEmail: mockSendEmail,
      };
    }),
    emailService: {
      sendEmail: mockSendEmail,
    },
  };
});

import { handleSubscriptionFailure } from '../../queue/worker';
import subscriptionModel from '../../models/subscription';
import { notificationRouter } from '../../services/notificationRouter';
import { emailService } from '../../services/email';
import { queryWrite } from '../../config/database';

const mockedSub = subscriptionModel as jest.Mocked<typeof subscriptionModel>;
const mockedNotification = notificationRouter as jest.Mocked<typeof notificationRouter>;
const mockedEmail = emailService as jest.Mocked<typeof emailService>;
const mockedQueryWrite = queryWrite as jest.MockedFunction<any>;

describe('handleSubscriptionFailure', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('schedules retry when under max_retries', async () => {
    mockedSub.getById = jest.fn().mockResolvedValueOnce({ id: 'sub1', merchant_id: 'm1' } as any);
    mockedSub.incrementRetry = jest.fn().mockResolvedValueOnce({ retry_count: 1, max_retries: 3, retry_backoff_seconds: 10 } as any);
    mockedSub.recordAttempt = jest.fn().mockResolvedValueOnce(undefined as any);
    mockedQueryWrite.mockResolvedValueOnce(undefined as any);

    await handleSubscriptionFailure('sub1', 'tx1', new Error('boom'));

    expect(mockedSub.incrementRetry).toHaveBeenCalledWith('sub1');
    expect(mockedSub.recordAttempt).toHaveBeenCalledWith('sub1', 'tx1', 1, 'failed', expect.any(String));
    expect(mockedQueryWrite).toHaveBeenCalled();
  });

  test('pauses and notifies when max_retries reached', async () => {
    mockedSub.getById = jest.fn().mockResolvedValueOnce({ id: 'sub2', merchant_id: 'm2' } as any);
    mockedSub.incrementRetry = jest.fn().mockResolvedValueOnce({ retry_count: 5, max_retries: 5, retry_backoff_seconds: 10 } as any);
    mockedSub.recordAttempt = jest.fn().mockResolvedValueOnce(undefined as any);
    mockedSub.pause = jest.fn().mockResolvedValueOnce(undefined as any);
    mockFindById.mockResolvedValueOnce({ email: 'merchant@example.com' } as any);
    mockedNotification.routeSystemNotification = jest.fn().mockResolvedValue(undefined as any);
    mockSendEmail.mockResolvedValue(undefined as any);

    await handleSubscriptionFailure('sub2', 'tx2', 'error');

    expect(mockedSub.pause).toHaveBeenCalledWith('sub2');
    expect(mockedNotification.routeSystemNotification).toHaveBeenCalled();
    expect(mockedEmail.sendEmail).toHaveBeenCalled();
  });
});

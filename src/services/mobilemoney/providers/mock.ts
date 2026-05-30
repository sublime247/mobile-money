import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../mobileMoneyService";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";

export class MockProvider implements MobileMoneyProvider {
  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(
      maskPII({ phoneNumber, amount }),
      "MockProvider: Requesting payment",
    );
    return {
      success: true,
      data: {
        transactionId: `mock-pay-${Date.now()}`,
        status: "PENDING",
      },
    };
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MockProvider: Sending payout");
    return {
      success: true,
      data: {
        transactionId: `mock-payout-${Date.now()}`,
        status: "SUCCESSFUL",
      },
    };
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    logger.info(maskPII({ referenceId }), "MockProvider: Checking status");
    return { status: "completed" };
  }
}

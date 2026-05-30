import axios from "axios";
import { config } from "../config/env";
import { createChildLogger } from "../config/logger";

const logger = createChildLogger("bridge");

interface CreatePaymentPayload {
  amount: number;
  currency: string;
}

interface CreatePaymentResponse {
  id: string;
  status: string;
}

const client = axios.create({
  baseURL: config.bridgeApiUrl,
  headers: {
    Authorization: `Bearer ${config.bridgeApiKey}`,
    "Content-Type": "application/json",
  },
});

export const createPayment = async (
  payload: CreatePaymentPayload
): Promise<CreatePaymentResponse> => {
  try {
    logger.info({ amount: payload.amount, currency: payload.currency }, "Creating payment");
    const response = await client.post<CreatePaymentResponse>(
      "/payments",
      payload
    );
    logger.info({ paymentId: response.data.id, status: response.data.status }, "Payment created");
    return response.data;
  } catch (error: any) {
    logger.error(
      { error: error.response?.data || error.message },
      "Bridge API error"
    );
    throw error;
  }
};

import axios, { AxiosError } from "axios";
import { config } from "../config/env";
import logger from "../logger";

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
    // Authorization header is redacted by the pino logger — never logged.
    Authorization: `Bearer ${config.bridgeApiKey}`,
    "Content-Type": "application/json",
  },
});

/**
 * Creates a payment via the Bridge API.
 * Logs the outbound request and any error response as structured JSON.
 * The Authorization header is automatically redacted by the logger.
 */
export const createPayment = async (
  payload: CreatePaymentPayload,
): Promise<CreatePaymentResponse> => {
  logger.debug(
    { amount: payload.amount, currency: payload.currency },
    "Sending payment request to Bridge API",
  );

  try {
    const response = await client.post<CreatePaymentResponse>(
      "/payments",
      payload,
    );

    logger.info(
      {
        paymentId: response.data.id,
        status: response.data.status,
        amount: payload.amount,
        currency: payload.currency,
      },
      "Bridge API payment created",
    );

    return response.data;
  } catch (err) {
    const axiosErr = err as AxiosError<{ message?: string }>;

    logger.error(
      {
        err: {
          message: axiosErr.message,
          status: axiosErr.response?.status,
          // Response body may contain useful error details but never secrets.
          responseData: axiosErr.response?.data,
        },
        amount: payload.amount,
        currency: payload.currency,
      },
      "Bridge API request failed",
    );

    throw err;
  }
};

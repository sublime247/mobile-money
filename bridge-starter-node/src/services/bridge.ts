import axios from "axios";
import { config } from "../config/env";

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
  payload: CreatePaymentPayload,
): Promise<CreatePaymentResponse> => {
  try {
    const response = await client.post<CreatePaymentResponse>(
      "/payments",
      payload,
    );
    return response.data;
  } catch (error: any) {
    console.error("Bridge API Error:", error.response?.data || error.message);
    throw error;
  }
};
